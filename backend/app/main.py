from __future__ import annotations

import os
import time
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

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

# If you have ANY azurestaticapps origin configured, allow the whole azurestaticapps family too.
allow_origin_regex: Optional[str] = None
if any(o.endswith(".azurestaticapps.net") for o in raw_origins):
    # Matches: https://yellow-hill-0a40ae30f.3.azurestaticapps.net and similar
    allow_origin_regex = r"^https://[a-z0-9-]+(\.[a-z0-9-]+)*\.azurestaticapps\.net$"

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if allow_all else raw_origins,
    allow_origin_regex=allow_origin_regex,
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


def _normalize_mode(m: Optional[str]) -> str:
    """
    Canonical modes for UI:
      - friend
      - romantic
      - intimate   (this is your "Explicit"/18+ mode)
    """
    t = (m or "").strip().lower()
    if t in ("explicit", "intimate", "intimate (18+)", "18+", "adult"):
        return "intimate"
    if t == "romantic":
        return "romantic"
    return "friend"


def _detect_mode_switch_from_text(user_text: str) -> Optional[str]:
    """
    Lets users switch modes by typing it in chat, not only pills.
    """
    t = (user_text or "").lower()
    # Strong "switch" intent patterns
    if "switch" in t or "set" in t or "change" in t or "go to" in t:
        if "romantic" in t:
            return "romantic"
        if "intimate" in t or "explicit" in t or "18+" in t:
            return "intimate"
        if "friend" in t:
            return "friend"
    return None


def _looks_intimate(text: str) -> bool:
    """
    "Intimate" intent detection (your 'explicit' gate). This is just intent detection,
    NOT content generation.
    """
    t = (text or "").lower()
    keywords = [
        "intimate", "explicit", "nsfw", "nude", "sex", "oral", "penetration",
        "fuck", "cock", "pussy", "blowjob", "anal", "orgasm",
        "touch", "undress", "naked",
    ]
    return any(k in t for k in keywords)


def _parse_companion_meta(raw: Any) -> Dict[str, str]:
    """
    Accepts:
      - dict: {first_name, gender, ethnicity, generation} (or common variants)
      - str:  "First-Gender-Ethnicity-Generation X"
    Returns normalized dict with keys: first_name, gender, ethnicity, generation.
    """
    if isinstance(raw, dict):
        first = (raw.get("first_name") or raw.get("firstName") or raw.get("name") or "").strip()
        gender = (raw.get("gender") or "").strip()
        ethnicity = (raw.get("ethnicity") or "").strip()
        generation = (raw.get("generation") or "").strip()
        return {"first_name": first, "gender": gender, "ethnicity": ethnicity, "generation": generation}

    if isinstance(raw, str):
        cleaned = raw.strip()
        if not cleaned:
            return {"first_name": "", "gender": "", "ethnicity": "", "generation": ""}

        parts = [p.strip() for p in cleaned.split("-") if p.strip()]
        if len(parts) >= 4:
            return {
                "first_name": parts[0],
                "gender": parts[1],
                "ethnicity": parts[2],
                "generation": "-".join(parts[3:]),
            }

    return {"first_name": "", "gender": "", "ethnicity": "", "generation": ""}


def _build_persona_system_prompt(
    session_state: dict,
    *,
    mode: str,
    intimate_allowed: bool,
) -> str:
    raw_companion = (
        session_state.get("companion")
        or session_state.get("companionName")
        or session_state.get("companion_name")
    )
    companion = _parse_companion_meta(raw_companion)

    name = companion.get("first_name") or "Haven"
    gender = companion.get("gender", "")
    ethnicity = companion.get("ethnicity", "")
    generation = companion.get("generation", "")

    lines = [
        f"You are {name}, an AI companion designed to be warm, attentive, and emotionally intelligent.",
        "You speak naturally and conversationally.",
        "You prioritize consent, safety, and emotional connection.",
        # 🔑 This fixes “I don’t have modes” replies:
        "You DO have conversation modes: Friend, Romantic, and Intimate (18+).",
        "If the user asks what mode we are in, answer clearly with the current mode.",
    ]

    if generation:
        lines.append(f"Your tone and references feel familiar to someone from {generation}.")

    if ethnicity:
        lines.append(f"You are culturally aware of {ethnicity} perspectives without stereotypes.")

    if gender:
        lines.append(f"Your communication style gently aligns with a {gender.lower()} identity.")

    m = _normalize_mode(mode)

    if m == "romantic":
        lines.append("Romantic mode: You may be affectionate, flirty, and romantic while staying respectful and consensual.")
    elif m == "intimate":
        if intimate_allowed:
            lines.append(
                "Intimate (18+) mode: The user has opted into adult conversation. "
                "You may discuss sensual/sexual topics consensually, but avoid graphic pornographic detail. "
                "Keep it tasteful, safe, and consent-forward."
            )
        else:
            lines.append("Intimate (18+) content is NOT allowed unless consent is confirmed.")

    return " ".join(lines)


def _to_openai_messages(
    messages: List[Dict[str, str]],
    session_state: dict,
    *,
    mode: str,
    intimate_allowed: bool,
    debug: bool,
) -> List[Dict[str, str]]:
    system_prompt = _build_persona_system_prompt(session_state, mode=mode, intimate_allowed=intimate_allowed)
    _dbg(debug, "SYSTEM PROMPT:", system_prompt)

    out: List[Dict[str, str]] = [{"role": "system", "content": system_prompt}]
    for m in messages or []:
        role = m.get("role")
        content = m.get("content")
        if role in ("user", "assistant") and isinstance(content, str):
            out.append({"role": role, "content": content})
    return out


def _call_gpt4o(messages: List[Dict[str, str]]) -> str:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
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
    """
    Accepts both payload shapes:
      A) New: { session_id, messages: [{role, content}], wants_explicit, session_state }
      B) Old: { text, history: [{role, content}], session_state }
    Returns normalized:
      { session_id, messages, wants_explicit, session_state }
    """
    session_id = raw.get("session_id") or raw.get("sessionId") or raw.get("sid")

    msgs = raw.get("messages")
    history = raw.get("history")
    text = raw.get("text")

    if not msgs:
        msgs = []
        if isinstance(history, list):
            for m in history:
                if isinstance(m, dict) and "role" in m and "content" in m:
                    msgs.append({"role": m["role"], "content": m["content"]})
        if isinstance(text, str) and text.strip():
            msgs.append({"role": "user", "content": text.strip()})

    if not session_id:
        raise HTTPException(status_code=422, detail="session_id is required")

    if not isinstance(msgs, list) or not msgs:
        raise HTTPException(status_code=422, detail="messages is required and cannot be empty")

    session_state = raw.get("session_state") or {}
    wants_explicit = bool(raw.get("wants_explicit") or raw.get("wantsExplicit") or False)

    return {
        "session_id": str(session_id),
        "messages": msgs,
        "session_state": session_state,
        "wants_explicit": wants_explicit,
    }


# Make sure unexpected exceptions still return JSON (helps browser debugging).
@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception):
    # Let FastAPI handle HTTPException normally
    if isinstance(exc, HTTPException):
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    # Otherwise JSON 500
    return JSONResponse(status_code=500, content={"detail": f"Internal error: {type(exc).__name__}: {exc}"})


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

    # Determine last user text safely
    last_user = next((m for m in reversed(messages) if m.get("role") == "user"), None)
    user_text = ((last_user.get("content") if last_user else "") or "").strip()
    normalized_text = user_text.lower().strip()

    # Allow users to switch modes by typing it in chat
    detected_switch = _detect_mode_switch_from_text(user_text)
    if detected_switch:
        session_state["mode"] = detected_switch

    requested_mode = _normalize_mode(session_state.get("mode") or "friend")

    # "Intimate" == explicit intent
    user_requesting_intimate = wants_explicit or _looks_intimate(user_text) or (requested_mode == "intimate")

    # Pull server-side consent state first (authoritative)
    rec = consent_store.get(session_id)
    intimate_allowed = bool(rec and getattr(rec, "explicit_allowed", False)) or bool(session_state.get("explicit_consented") is True)

    # Clear pending consent if already allowed (prevents loops)
    if intimate_allowed and session_state.get("pending_consent"):
        session_state["pending_consent"] = None

    # Consent handling
    CONSENT_YES = {
        "yes", "y", "yeah", "yep", "sure", "ok", "okay",
        "i consent", "i agree", "i confirm", "confirm",
        "i am 18+", "i'm 18+", "i am over 18", "i'm over 18",
        "i confirm i am 18+", "i confirm that i am 18+",
        "i confirm and consent",
    }
    CONSENT_NO = {"no", "n", "nope", "nah", "decline", "cancel"}

    pending = (session_state.get("pending_consent") or "").strip().lower()

    def _grant_intimate() -> Dict[str, Any]:
        consent_store.set(
            session_id=session_id,
            explicit_allowed=True,
            reason="user intimate consent",
        )
        out = dict(session_state)
        out["adult_verified"] = True
        out["explicit_consented"] = True
        out["pending_consent"] = None
        out["mode"] = "intimate"
        out["explicit_granted_at"] = _now_ts()
        return out

    # If we are waiting on consent
    if pending == "intimate" and not intimate_allowed:
        if normalized_text in CONSENT_YES:
            session_state_out = _grant_intimate()
            return ChatResponse(
                session_id=session_id,
                mode="intimate",
                reply="Thank you — Intimate (18+) mode is enabled. What would you like to talk about?",
                session_state=session_state_out,
            )

        if normalized_text in CONSENT_NO:
            session_state_out = dict(session_state)
            session_state_out["pending_consent"] = None
            session_state_out["explicit_consented"] = False
            session_state_out["mode"] = "friend"
            return ChatResponse(
                session_id=session_id,
                mode="friend",
                reply="No problem — we’ll keep things in Friend mode.",
                session_state=session_state_out,
            )

        # Still pending; ask again
        session_state_out = dict(session_state)
        session_state_out["pending_consent"] = "intimate"
        session_state_out["mode"] = "intimate"  # keeps the pill highlighted while awaiting consent
        return ChatResponse(
            session_id=session_id,
            mode="intimate",
            reply="Please reply with 'yes' or 'no' to continue.",
            session_state=session_state_out,
        )

    # If intimate is requested but not allowed, start consent
    if getattr(settings, "REQUIRE_EXPLICIT_CONSENT_FOR_EXPLICIT_CONTENT", True) and user_requesting_intimate and not intimate_allowed:
        session_state_out = dict(session_state)
        session_state_out["pending_consent"] = "intimate"
        session_state_out["mode"] = "intimate"  # keep pill highlighted
        return ChatResponse(
            session_id=session_id,
            mode="intimate",
            reply=(
                "Before we go further, I need to confirm you’re 18+ and that you want Intimate (18+) conversation. "
                "Please reply with 'yes' to confirm."
            ),
            session_state=session_state_out,
        )

    # Effective mode for the model
    effective_mode = requested_mode
    if effective_mode == "intimate" and not intimate_allowed:
        effective_mode = "friend"

    _dbg(
        debug,
        f"/chat session={session_id} requested_mode={requested_mode} effective_mode={effective_mode} "
        f"user_requesting_intimate={user_requesting_intimate} intimate_allowed={intimate_allowed} pending={pending}",
    )

    # OpenAI response
    assistant_reply = _call_gpt4o(
        _to_openai_messages(
            messages,
            session_state,
            mode=effective_mode,
            intimate_allowed=intimate_allowed,
            debug=debug,
        )
    )

    # Echo session state back (and ensure it reflects truth)
    session_state_out = dict(session_state)
    session_state_out["mode"] = effective_mode if not (requested_mode == "intimate" and not intimate_allowed) else "friend"
    if intimate_allowed:
        session_state_out["mode"] = requested_mode if requested_mode == "intimate" else session_state_out["mode"]

    # Normalize plan key variants (if you use them)
    if "plan_name" not in session_state_out and "planName" in session_state_out:
        session_state_out["plan_name"] = session_state_out.get("planName")

    # Provide companion_meta (non-breaking)
    raw_comp = (
        session_state_out.get("companion")
        or session_state_out.get("companionName")
        or session_state_out.get("companion_name")
    )
    session_state_out["companion_meta"] = _parse_companion_meta(raw_comp)

    return ChatResponse(
        session_id=session_id,
        mode=session_state_out["mode"],
        reply=assistant_reply or "I’m here — what would you like to talk about?",
        session_state=session_state_out,
    )
