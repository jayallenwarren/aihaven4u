from __future__ import annotations

import os
import time
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from .settings import settings
from .models import ChatResponse
from .consent_store import consent_store
from .consent_routes import router as consent_router

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


# ----------------------------
# Helpers
# ----------------------------
def _dbg(enabled: bool, *args: Any) -> None:
    if enabled:
        print(*args)


def _now_ts() -> int:
    return int(time.time())


def _normalize_mode(raw: Any) -> str:
    """
    Frontend historically used "explicit" to mean Intimate (18+).
    We standardize server-side to: friend | romantic | intimate
    """
    m = (str(raw or "").strip().lower())
    if m in ("explicit", "intimate", "intimate (18+)", "18+", "nsfw"):
        return "intimate"
    if m in ("romance", "romantic"):
        return "romantic"
    if m in ("friend", "friendly", "safe"):
        return "friend"
    return "friend"


def _looks_intimate(text: str) -> bool:
    # IMPORTANT: "Intimate" is treated the same as "Explicit" intent.
    t = (text or "").lower()
    return any(
        k in t
        for k in [
            "explicit",
            "intimate",
            "18+",
            "nsfw",
            "sex",
            "nude",
            "porn",
            "fuck",
            "cock",
            "pussy",
            "blowjob",
            "anal",
            "orgasm",
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

    # IMPORTANT: We add explicit instructions so the model NEVER claims "I don't have modes"
    # and can answer "what mode are we in?" reliably.
    lines = [
        f"You are {name}, an AI companion who is warm, attentive, and emotionally intelligent.",
        "You speak naturally and conversationally.",
        "You prioritize consent, safety, and emotional connection.",
        "The app has 3 modes: Friend, Romantic, Intimate (18+).",
        "If the user asks what mode you're in, answer with the current mode plainly (Friend/Romantic/Intimate (18+)).",
        "Do not claim you 'don't have modes' or that the UI is unrelated—respond consistently with the app's modes.",
    ]

    if mode == "romantic":
        lines.append("In Romantic mode, you may be affectionate and flirty while remaining respectful and consensual.")

    if mode == "intimate":
        if intimate_allowed:
            lines.append(
                "In Intimate (18+) mode, the user has consented. You may engage in adult, sensual discussion, "
                "but avoid graphic or pornographic detail. Focus on intimacy, emotion, and connection."
            )
        else:
            lines.append("Do not engage in intimate/sexual content unless consent is confirmed.")

    return " ".join(lines)


def _to_openai_messages(messages: List[Dict[str, str]], session_state: dict, *, mode: str, intimate_allowed: bool, debug: bool):
    sys = _build_persona_system_prompt(session_state, mode=mode, intimate_allowed=intimate_allowed)
    _dbg(debug, "SYSTEM PROMPT:", sys)

    out = [{"role": "system", "content": sys}]
    for m in messages:
        if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str):
            out.append({"role": m["role"], "content": m["content"]})
    return out


def _call_gpt4o(messages: List[Dict[str, str]]) -> str:
    api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set")

    from openai import OpenAI  # type: ignore
    client = OpenAI(api_key=api_key)
    resp = client.chat.completions.create(
        model="gpt-4o",
        messages=messages,
        temperature=0.8,
    )
    return (resp.choices[0].message.content or "").strip()


def _normalize_payload(raw: Dict[str, Any]) -> Dict[str, Any]:
    sid = raw.get("session_id") or raw.get("sid") or raw.get("sessionId")
    msgs = raw.get("messages") or []
    state = raw.get("session_state") or {}
    wants = bool(raw.get("wants_explicit") or raw.get("wantsExplicit") or False)

    if not sid or not isinstance(msgs, list) or not msgs:
        raise HTTPException(status_code=422, detail="session_id and messages are required")

    return {"session_id": str(sid), "messages": msgs, "session_state": state, "wants_explicit": wants}


def _detect_mode_switch_command(user_text_lower: str) -> Optional[str]:
    t = (user_text_lower or "").strip()

    # "switch to ___ mode" / "set mode to ___" etc
    if "switch" in t or "set" in t or "mode" in t:
        if "friend" in t:
            return "friend"
        if "romantic" in t or "romance" in t:
            return "romantic"
        if "intimate" in t or "explicit" in t or "18+" in t:
            return "intimate"

    return None


# ----------------------------
# CHAT
# ----------------------------
@app.post("/chat", response_model=ChatResponse)
async def chat(request: Request):
    debug = bool(getattr(settings, "DEBUG", False))
    raw = await request.json()
    norm = _normalize_payload(raw)

    session_id: str = norm["session_id"]
    messages: List[Dict[str, str]] = norm["messages"]
    session_state: Dict[str, Any] = norm["session_state"] or {}
    wants_explicit: bool = bool(norm["wants_explicit"])

    # Last user message
    last_user = next((m for m in reversed(messages) if m.get("role") == "user"), None)
    user_text = ((last_user.get("content") if last_user else "") or "").strip()
    user_text_lower = user_text.lower().strip()

    # Normalize requested mode (friend/romantic/intimate)
    requested_mode = _normalize_mode(session_state.get("mode") or "friend")

    # Consent sources:
    # - server record (consent_store)
    # - echoed session_state flag from frontend
    server_allowed = False
    try:
        rec = consent_store.get(session_id)
        server_allowed = bool(rec and getattr(rec, "explicit_allowed", False))
    except Exception:
        server_allowed = False

    session_allowed = (session_state.get("explicit_consented") is True)
    intimate_allowed = bool(server_allowed or session_allowed)

    # If user typed a mode-switch instruction, honor it by updating session_state.mode
    cmd_mode = _detect_mode_switch_command(user_text_lower)
    if cmd_mode:
        session_state["mode"] = cmd_mode
        requested_mode = cmd_mode

    # If user is requesting intimate intent via content, treat it as intimate request
    if _looks_intimate(user_text) or wants_explicit:
        # only auto-upshift to intimate if they already selected it or gave a mode command
        # (we do NOT silently flip them; we just use it to trigger consent if they asked)
        pass

    _dbg(
        debug,
        f"/chat sid={session_id} requested_mode={requested_mode} intimate_allowed={intimate_allowed} "
        f"pending={session_state.get('pending_consent')}",
    )

    # ----------------------------
    # CONSENT FLOW (Intimate == Explicit)
    # ----------------------------
    CONSENT_YES = {
        "yes", "y", "yeah", "yep", "sure", "ok", "okay",
        "i consent", "i agree", "i confirm", "confirm",
        "i am 18+", "i'm 18+", "i am over 18", "i'm over 18",
        "i confirm i am 18+", "i confirm that i am 18+",
        "i confirm and consent",
    }
    CONSENT_NO = {"no", "n", "nope", "nah", "decline", "cancel"}

    pending = str(session_state.get("pending_consent") or "").strip().lower()

    def _grant_intimate() -> Dict[str, Any]:
        # Persist server-side
        try:
            consent_store.set(
                session_id=session_id,
                explicit_allowed=True,
                reason="user intimate consent",
            )
        except Exception:
            pass

        out = dict(session_state)
        out["adult_verified"] = True
        out["explicit_consented"] = True
        out["pending_consent"] = None
        out["mode"] = "intimate"
        out["explicit_granted_at"] = _now_ts()
        return out

    # If we're waiting for consent
    if pending == "intimate" and not intimate_allowed:
        if user_text_lower in CONSENT_YES:
            session_state_out = _grant_intimate()
            return ChatResponse(
                session_id=session_id,
                mode="intimate",
                reply="Thank you — Intimate (18+) mode is enabled. What would you like to talk about?",
                session_state=session_state_out,
            )

        if user_text_lower in CONSENT_NO:
            session_state_out = dict(session_state)
            session_state_out["pending_consent"] = None
            session_state_out["explicit_consented"] = False
            session_state_out["mode"] = "friend"
            return ChatResponse(
                session_id=session_id,
                mode="friend",
                reply="No problem — we’ll keep things non-intimate.",
                session_state=session_state_out,
            )

        # Not yes/no: keep asking
        session_state_out = dict(session_state)
        session_state_out["pending_consent"] = "intimate"
        session_state_out["mode"] = "intimate"
        return ChatResponse(
            session_id=session_id,
            mode="intimate",
            reply="Please reply with 'yes' or 'no' to continue.",
            session_state=session_state_out,
        )

    # If Intimate is requested but not allowed, ask for consent
    intimate_requested = (requested_mode == "intimate") or _looks_intimate(user_text) or wants_explicit
    if (
        getattr(settings, "REQUIRE_EXPLICIT_CONSENT_FOR_EXPLICIT_CONTENT", True)
        and intimate_requested
        and not intimate_allowed
    ):
        session_state_out = dict(session_state)
        session_state_out["pending_consent"] = "intimate"
        # Keep the user's selection visible so the pill stays highlighted
        session_state_out["mode"] = "intimate"

        return ChatResponse(
            session_id=session_id,
            mode="intimate",
            reply=(
                "Before we go further, I need to confirm you’re 18+ and that you want Intimate (18+) conversation. "
                "Please reply with 'yes' to confirm."
            ),
            session_state=session_state_out,
        )

    # ----------------------------
    # MODEL RESPONSE
    # ----------------------------
    mode_for_model = requested_mode
    if mode_for_model == "intimate" and not intimate_allowed:
        # should be unreachable due to return above, but keep safe
        mode_for_model = "friend"

    try:
        reply = _call_gpt4o(
            _to_openai_messages(
                messages,
                session_state,
                mode=mode_for_model,
                intimate_allowed=intimate_allowed,
                debug=debug,
            )
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OpenAI call failed: {e}")

    # Echo state back
    session_state_out = dict(session_state)
    session_state_out["mode"] = requested_mode

    return ChatResponse(
        session_id=session_id,
        mode=requested_mode,
        reply=reply or "I’m here — what would you like to talk about?",
        session_state=session_state_out,
    )
