from __future__ import annotations

import os
import time
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from .settings import settings
from .models import ChatResponse

# If you still want the consent router, keep it BUT don't let it break boot.
# (Boot failures are what cause "CORS missing" + 503.)
try:
    from .consent_routes import router as consent_router  # type: ignore
except Exception:
    consent_router = None


STATUS_SAFE = "safe"
STATUS_BLOCKED = "explicit_blocked"
STATUS_ALLOWED = "explicit_allowed"

app = FastAPI(title="AIHaven4U API")

# ----------------------------
# CORS
# ----------------------------
_raw = (getattr(settings, "CORS_ALLOW_ORIGINS", "") or "").strip()
raw_origins = [o.strip() for o in _raw.split(",") if o.strip()]
allow_all = (_raw == "*")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if allow_all else raw_origins,
    allow_credentials=False if allow_all else True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----------------------------
# Routes
# ----------------------------
if consent_router is not None:
    app.include_router(consent_router)


@app.get("/health")
def health():
    return {"ok": True}


# ----------------------------
# Helpers
# ----------------------------
def _dbg(enabled: bool, *args: Any) -> None:
    if enabled:
        print(*args)


def _now_ts() -> int:
    return int(time.time())


def _normalize_mode(raw: str) -> str:
    t = (raw or "").strip().lower()
    # allow some synonyms from older frontend builds
    if t in {"explicit", "intimate", "18+", "adult"}:
        return "intimate"
    if t in {"romance", "romantic"}:
        return "romantic"
    return "friend"


def _detect_mode_switch_from_text(text: str) -> Optional[str]:
    t = (text or "").lower().strip()

    # explicit hints: allow [mode:romantic] etc
    if "mode:friend" in t or "[mode:friend]" in t:
        return "friend"
    if "mode:romantic" in t or "[mode:romantic]" in t:
        return "romantic"
    if (
        "mode:intimate" in t
        or "[mode:intimate]" in t
        or "mode:explicit" in t
        or "[mode:explicit]" in t
    ):
        return "intimate"

    # soft detection (more natural language coverage)
    # friend
    if any(p in t for p in [
        "switch to friend",
        "go to friend",
        "back to friend",
        "friend mode",
        "set friend",
        "set mode to friend",
        "turn on friend",
    ]):
        return "friend"

    # romantic
    if any(p in t for p in [
        "switch to romantic",
        "go to romantic",
        "back to romantic",
        "romantic mode",
        "set romantic",
        "set mode to romantic",
        "turn on romantic",
        "let's be romantic",
    ]):
        return "romantic"

    # intimate/explicit
    if any(p in t for p in [
        "switch to intimate",
        "go to intimate",
        "back to intimate",
        "intimate mode",
        "set intimate",
        "set mode to intimate",
        "turn on intimate",
        "switch to explicit",
        "explicit mode",
        "set explicit",
        "set mode to explicit",
        "turn on explicit",
    ]):
        return "intimate"

    return None



def _looks_intimate(text: str) -> bool:
    t = (text or "").lower()
    return any(
        k in t
        for k in [
            "explicit", "intimate", "nsfw", "sex", "nude", "porn",
            "fuck", "cock", "pussy", "blowjob", "anal", "orgasm",
        ]
    )


def _parse_companion_meta(raw: Any) -> Dict[str, str]:
    if isinstance(raw, str):
        parts = [p.strip() for p in raw.split("-") if p.strip()]
        if len(parts) >= 4:
            return {
                "first_name": parts[0],
                "gender": parts[1],
                "ethnicity": parts[2],
                "generation": "-".join(parts[3:]),
            }
    return {"first_name": "", "gender": "", "ethnicity": "", "generation": ""}


def _build_persona_system_prompt(session_state: dict, *, mode: str, intimate_allowed: bool) -> str:
    comp = _parse_companion_meta(
        session_state.get("companion")
        or session_state.get("companionName")
        or session_state.get("companion_name")
    )
    name = comp.get("first_name") or "Haven"

    lines = [
        f"You are {name}, an AI companion who is warm, attentive, and emotionally intelligent.",
        "You speak naturally and conversationally.",
        "You prioritize consent, safety, and emotional connection.",
    ]

    if mode == "romantic":
        lines.append("You may be affectionate and flirty while remaining respectful.")

    if mode == "intimate" and intimate_allowed:
        lines.append(
            "The user has consented to Intimate (18+) conversation. "
            "You may engage in adult, sensual discussion, but avoid graphic or pornographic detail. "
            "Focus on intimacy, emotion, and connection."
        )

    return " ".join(lines)


def _to_openai_messages(messages: List[Dict[str, str]], session_state: dict, *, mode: str, intimate_allowed: bool, debug: bool):
    sys = _build_persona_system_prompt(session_state, mode=mode, intimate_allowed=intimate_allowed)
    _dbg(debug, "SYSTEM PROMPT:", sys)

    out = [{"role": "system", "content": sys}]
    for m in messages:
        if m.get("role") in ("user", "assistant"):
            out.append({"role": m["role"], "content": m.get("content", "")})
    return out


def _call_gpt4o(messages):
    from openai import OpenAI

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")

    client = OpenAI(api_key=api_key)
    resp = client.chat.completions.create(
        model="gpt-4o",
        messages=messages,
        temperature=0.8,
    )
    return (resp.choices[0].message.content or "").strip()


def _normalize_payload(raw: Dict[str, Any]) -> Tuple[str, List[Dict[str, str]], Dict[str, Any], bool]:
    sid = raw.get("session_id") or raw.get("sid")
    msgs = raw.get("messages") or []
    state = raw.get("session_state") or {}
    wants = bool(raw.get("wants_explicit"))

    if not sid or not isinstance(sid, str):
        raise HTTPException(422, "session_id required")
    if not msgs or not isinstance(msgs, list):
        raise HTTPException(422, "messages required")
    if not isinstance(state, dict):
        state = {}

    return sid, msgs, state, wants


# ----------------------------
# CHAT
# ----------------------------
@app.post("/chat", response_model=ChatResponse)
async def chat(request: Request):
    debug = bool(getattr(settings, "DEBUG", False))

    raw = await request.json()
    session_id, messages, session_state, wants_explicit = _normalize_payload(raw)

    # last user message
    last_user = next((m for m in reversed(messages) if m.get("role") == "user"), None)
    user_text = ((last_user.get("content") if last_user else "") or "").strip()
    normalized_text = user_text.lower().strip()

    # allow text-based mode switching
    detected_switch = _detect_mode_switch_from_text(user_text)
    if detected_switch:
        session_state["mode"] = detected_switch

    requested_mode = _normalize_mode(str(session_state.get("mode") or "friend"))
    requested_intimate = (requested_mode == "intimate")

    # authoritative consent flag should live in session_state (works across gunicorn workers)
    intimate_allowed = bool(session_state.get("explicit_consented") is True)

    # if user is requesting intimate OR the UI is in intimate mode, treat as intimate request
    user_requesting_intimate = wants_explicit or requested_intimate or _looks_intimate(user_text)

    # consent keywords
    CONSENT_YES = {
        "yes", "y", "yeah", "yep", "sure", "ok", "okay",
        "i consent", "i agree", "i confirm", "confirm",
        "i am 18+", "i'm 18+", "i am over 18", "i'm over 18",
        "i confirm i am 18+", "i confirm that i am 18+",
        "i confirm and consent",
    }
    CONSENT_NO = {"no", "n", "nope", "nah", "decline", "cancel"}

    pending = (session_state.get("pending_consent") or "")
    pending = pending.strip().lower() if isinstance(pending, str) else ""

    def _grant_intimate(state_in: Dict[str, Any]) -> Dict[str, Any]:
        out = dict(state_in)
        out["adult_verified"] = True
        out["explicit_consented"] = True
        out["pending_consent"] = None
        out["mode"] = "intimate"
        out["explicit_granted_at"] = _now_ts()
        return out

    # If we are waiting on consent, only accept yes/no
    if pending == "intimate" and not intimate_allowed:
        if normalized_text in CONSENT_YES:
            session_state_out = _grant_intimate(session_state)
            return ChatResponse(
                session_id=session_id,
                mode=STATUS_ALLOWED,
                reply="Thank you — Intimate (18+) mode is enabled. What would you like to explore together?",
                session_state=session_state_out,
            )

        if normalized_text in CONSENT_NO:
            session_state_out = dict(session_state)
            session_state_out["pending_consent"] = None
            session_state_out["explicit_consented"] = False
            session_state_out["mode"] = "friend"
            return ChatResponse(
                session_id=session_id,
                mode=STATUS_SAFE,
                reply="No problem — we’ll keep things in Friend mode.",
                session_state=session_state_out,
            )

        # still pending; remind
        session_state_out = dict(session_state)
        session_state_out["pending_consent"] = "intimate"
        session_state_out["mode"] = "intimate"  # keep pill highlighted
        return ChatResponse(
            session_id=session_id,
            mode=STATUS_BLOCKED,
            reply="Please reply with 'yes' or 'no' to continue.",
            session_state=session_state_out,
        )

    # Start consent if intimate requested but not allowed
    require_consent = bool(getattr(settings, "REQUIRE_EXPLICIT_CONSENT_FOR_EXPLICIT_CONTENT", True))
    if require_consent and user_requesting_intimate and not intimate_allowed:
        session_state_out = dict(session_state)
        session_state_out["pending_consent"] = "intimate"
        session_state_out["mode"] = "intimate"
        return ChatResponse(
            session_id=session_id,
            mode=STATUS_BLOCKED,
            reply="Before we continue, please confirm you are 18+ and consent to Intimate (18+) conversation. Reply 'yes' to continue.",
            session_state=session_state_out,
        )

    # Effective mode for the model (never intimate unless allowed)
    effective_mode = requested_mode
    if effective_mode == "intimate" and not intimate_allowed:
        effective_mode = "friend"

    _dbg(
        debug,
        f"/chat session={session_id} requested_mode={requested_mode} effective_mode={effective_mode} "
        f"user_requesting_intimate={user_requesting_intimate} intimate_allowed={intimate_allowed} pending={pending}",
    )

    # call model
    try:
        assistant_reply = _call_gpt4o(
            _to_openai_messages(
                messages,
                session_state,
                mode=effective_mode,
                intimate_allowed=intimate_allowed,
                debug=debug,
            )
        )
    except Exception as e:
        _dbg(debug, "OpenAI call failed:", repr(e))
        raise HTTPException(status_code=500, detail=f"OpenAI call failed: {type(e).__name__}: {e}")

    # echo back session_state (ensure correct mode)
    session_state_out = dict(session_state)
    session_state_out["mode"] = effective_mode
    session_state_out["pending_consent"] = None if intimate_allowed else session_state_out.get("pending_consent")
    session_state_out["companion_meta"] = _parse_companion_meta(
        session_state_out.get("companion")
        or session_state_out.get("companionName")
        or session_state_out.get("companion_name")
    )

    return ChatResponse(
        session_id=session_id,
        mode=STATUS_ALLOWED if intimate_allowed else STATUS_SAFE,
        reply=assistant_reply,
        session_state=session_state_out,
    )
