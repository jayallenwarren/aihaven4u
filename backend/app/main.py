from __future__ import annotations

import os
import re
import time
import uuid
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from .settings import settings
from .models import ChatResponse
from .consent_store import consent_store
from .consent_routes import router as consent_router


# =============================================================================
# App
# =============================================================================
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
app.include_router(consent_router)

@app.get("/health")
def health():
    return {"ok": True}


# =============================================================================
# Helpers
# =============================================================================
STATUS_SAFE = "safe"
STATUS_BLOCKED = "explicit_blocked"
STATUS_ALLOWED = "explicit_allowed"

Mode = str  # runtime only; frontend uses "friend"|"romantic"|"explicit"


def _dbg(enabled: bool, *args: Any) -> None:
    if enabled:
        print(*args)


def _now_ts() -> int:
    return int(time.time())


def _looks_explicit(text: str) -> bool:
    t = (text or "").lower()
    keywords = [
        "explicit", "intimate", "18+",
        "sex", "nude", "porn",
        "fuck", "cock", "pussy", "blowjob", "anal", "orgasm",
        "nsfw",
    ]
    return any(k in t for k in keywords)


def _normalize_mode(raw: Any) -> Mode:
    """
    Canonical UI modes:
      - friend
      - romantic
      - explicit  (UI label: "Intimate (18+)")
    Accept synonyms (intimate/18+/nsfw -> explicit).
    """
    t = (str(raw or "")).strip().lower()
    if t in ("friend", "friendly", "safe"):
        return "friend"
    if t in ("romantic", "romance", "flirty"):
        return "romantic"
    if t in ("explicit", "intimate", "adult", "18+", "nsfw"):
        return "explicit"
    return "friend"


_MODE_SWITCH_RE = re.compile(
    r"\b(switch|change|set|go|return|move|put|back)\b.*\b(friend|romantic|romance|explicit|intimate|18\+|nsfw)\b",
    re.IGNORECASE,
)

def _detect_mode_switch_from_text(text: str) -> Optional[Mode]:
    t = (text or "").strip()
    if not t:
        return None
    m = _MODE_SWITCH_RE.search(t)
    if not m:
        return None

    target = m.group(2).lower()
    if target == "romance":
        target = "romantic"
    if target in ("intimate", "18+", "nsfw"):
        target = "explicit"
    return _normalize_mode(target)


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


def _build_persona_system_prompt(session_state: Dict[str, Any], *, mode: Mode, explicit_allowed: bool) -> str:
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

    # Intentionally non-graphic.
    if mode == "explicit" and explicit_allowed:
        lines.append(
            "The user has consented to Intimate (18+) conversation. "
            "You may engage in adult, sensual discussion, but avoid graphic/pornographic detail. "
            "Focus on intimacy, emotion, and connection."
        )

    return " ".join(lines)


def _to_openai_messages(
    messages: List[Dict[str, str]],
    session_state: Dict[str, Any],
    *,
    mode: Mode,
    explicit_allowed: bool,
    debug: bool,
) -> List[Dict[str, str]]:
    sys = _build_persona_system_prompt(session_state, mode=mode, explicit_allowed=explicit_allowed)
    _dbg(debug, "SYSTEM PROMPT:", sys)

    out: List[Dict[str, str]] = [{"role": "system", "content": sys}]
    for m in messages:
        if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str):
            out.append({"role": m["role"], "content": m["content"]})
    return out


def _call_gpt4o(messages: List[Dict[str, str]]) -> str:
    from openai import OpenAI  # type: ignore

    api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set")

    client = OpenAI(api_key=api_key)
    resp = client.chat.completions.create(
        model=getattr(settings, "OPENAI_MODEL", "gpt-4o"),
        messages=messages,
        temperature=float(getattr(settings, "OPENAI_TEMPERATURE", 0.8)),
    )
    return (resp.choices[0].message.content or "").strip()


def _normalize_payload(raw: Dict[str, Any]) -> Dict[str, Any]:
    sid = raw.get("session_id") or raw.get("sessionId") or raw.get("sid")
    msgs = raw.get("messages")

    if not msgs:
        msgs = []
        history = raw.get("history")
        text = raw.get("text")
        if isinstance(history, list):
            for m in history:
                if isinstance(m, dict) and "role" in m and "content" in m:
                    msgs.append({"role": m["role"], "content": m["content"]})
        if isinstance(text, str) and text.strip():
            msgs.append({"role": "user", "content": text.strip()})

    if not sid:
        raise HTTPException(status_code=422, detail="session_id is required")
    if not isinstance(msgs, list) or not msgs:
        raise HTTPException(status_code=422, detail="messages is required and cannot be empty")

    state = raw.get("session_state") or {}
    wants = bool(raw.get("wants_explicit") or raw.get("wantsExplicit") or False)
    return {"session_id": str(sid), "messages": msgs, "session_state": state, "wants_explicit": wants}


# =============================================================================
# CHAT
# =============================================================================
@app.post("/chat", response_model=ChatResponse)
async def chat(request: Request):
    debug = bool(getattr(settings, "DEBUG", False))
    req_id = uuid.uuid4().hex[:8]

    raw = await request.json()
    norm = _normalize_payload(raw)

    session_id: str = norm["session_id"]
    messages: List[Dict[str, str]] = norm["messages"]
    session_state: Dict[str, Any] = norm["session_state"] or {}
    wants_explicit: bool = bool(norm["wants_explicit"])

    last_user = next((m for m in reversed(messages) if m.get("role") == "user"), None)
    user_text = ((last_user.get("content") if last_user else "") or "").strip()
    normalized_text = user_text.lower().strip()

    detected_switch = _detect_mode_switch_from_text(user_text)
    if detected_switch:
        session_state["mode"] = detected_switch

    requested_mode: Mode = _normalize_mode(session_state.get("mode") or "friend")

    user_requesting_explicit = (requested_mode == "explicit") or wants_explicit or _looks_explicit(user_text)

    rec = consent_store.get(session_id)
    server_allowed = bool(rec and getattr(rec, "explicit_allowed", False))
    session_allowed = bool(session_state.get("explicit_consented") is True)
    explicit_allowed = server_allowed or session_allowed

    if explicit_allowed and session_state.get("pending_consent"):
        session_state["pending_consent"] = None

    pending = (session_state.get("pending_consent") or "").strip().lower()

    CONSENT_YES = {
        "yes", "y", "yeah", "yep", "sure", "ok", "okay",
        "i consent", "i agree", "i confirm", "confirm",
        "i am 18+", "i'm 18+", "i am over 18", "i'm over 18",
        "i confirm i am 18+", "i confirm that i am 18+",
        "i confirm and consent",
    }
    CONSENT_NO = {"no", "n", "nope", "nah", "decline", "cancel"}

    def _grant_explicit() -> Dict[str, Any]:
        try:
            consent_store.set(session_id=session_id, explicit_allowed=True, reason="user explicit consent")
        except Exception:
            pass

        out = dict(session_state)
        out["adult_verified"] = True
        out["explicit_consented"] = True
        out["pending_consent"] = None
        out["mode"] = "explicit"
        out["explicit_granted_at"] = _now_ts()
        return out

    # If we are waiting on consent
    if pending == "explicit" and not explicit_allowed:
        if normalized_text in CONSENT_YES:
            session_state_out = _grant_explicit()
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

        session_state_out = dict(session_state)
        session_state_out["pending_consent"] = "explicit"
        session_state_out["mode"] = "explicit"
        return ChatResponse(
            session_id=session_id,
            mode=STATUS_BLOCKED,
            reply="Please reply with 'yes' or 'no' to continue.",
            session_state=session_state_out,
        )

    # Start consent flow
    if (
        getattr(settings, "REQUIRE_EXPLICIT_CONSENT_FOR_EXPLICIT_CONTENT", True)
        and user_requesting_explicit
        and not explicit_allowed
    ):
        session_state_out = dict(session_state)
        session_state_out["pending_consent"] = "explicit"
        session_state_out["mode"] = "explicit"

        return ChatResponse(
            session_id=session_id,
            mode=STATUS_BLOCKED,
            reply=(
                "Before we continue, please confirm you are 18+ and consent to Intimate (18+) conversation. "
                "Reply 'yes' to continue."
            ),
            session_state=session_state_out,
        )

    effective_mode: Mode = requested_mode
    if effective_mode == "explicit" and not explicit_allowed:
        effective_mode = "friend"

    _dbg(
        debug,
        f"[{req_id}] /chat session={session_id} requested_mode={requested_mode} "
        f"effective_mode={effective_mode} user_requesting_explicit={user_requesting_explicit} "
        f"explicit_allowed={explicit_allowed} pending={pending}",
    )

    try:
        assistant_reply = _call_gpt4o(
            _to_openai_messages(
                messages,
                session_state,
                mode=effective_mode,
                explicit_allowed=explicit_allowed,
                debug=debug,
            )
        )
    except HTTPException:
        raise
    except Exception as e:
        _dbg(debug, "OpenAI call failed:", repr(e))
        raise HTTPException(status_code=500, detail=f"OpenAI call failed: {type(e).__name__}: {e}")

    session_state_out = dict(session_state)
    session_state_out["mode"] = requested_mode
    session_state_out["explicit_consented"] = bool(session_state_out.get("explicit_consented") is True) or explicit_allowed
    if explicit_allowed:
        session_state_out["pending_consent"] = None
        session_state_out["adult_verified"] = True

    if "plan_name" not in session_state_out and "planName" in session_state_out:
        session_state_out["plan_name"] = session_state_out.get("planName")

    raw_comp = (
        session_state_out.get("companion")
        or session_state_out.get("companionName")
        or session_state_out.get("companion_name")
    )
    session_state_out["companion_meta"] = _parse_companion_meta(raw_comp)

    return ChatResponse(
        session_id=session_id,
        mode=STATUS_ALLOWED if explicit_allowed else STATUS_SAFE,
        reply=assistant_reply or "I’m here — what would you like to talk about?",
        session_state=session_state_out,
    )
