from __future__ import annotations

import os
import time
import uuid
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from .settings import settings
from .models import ChatResponse
from .consent_store import consent_store
from .consent_routes import router as consent_router

app = FastAPI(title="AIHaven4U API")

# ----------------------------
# CORS (robust fallback)
# ----------------------------
_raw = (getattr(settings, "CORS_ALLOW_ORIGINS", "") or "").strip()
raw_origins = [o.strip() for o in _raw.split(",") if o.strip()]
allow_all = (_raw == "*")

# If env var is missing/blank, default to allow-all (no cookies used)
if allow_all or not raw_origins:
    allow_origins = ["*"]
    allow_credentials = False
else:
    allow_origins = raw_origins
    allow_credentials = True

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=allow_credentials,
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
    Canonical modes:
      - friend
      - romantic
      - intimate   (18+)
    Accepts synonyms like "explicit" and normalizes them to "intimate".
    """
    t = str(raw or "").strip().lower()
    if t in ("friend", "romantic", "intimate"):
        return t
    if "romantic" in t:
        return "romantic"
    # Treat explicit/adult/intimate synonyms as intimate
    if "explicit" in t or "intimate" in t or "adult" in t:
        return "intimate"
    return "friend"

def _looks_intimate(text: str) -> bool:
    """
    Detect user intent for intimate (18+) conversation.
    Keep this conservative—it's just for triggering consent, not generating content.
    """
    t = (text or "").lower()
    keywords = [
        "intimate", "explicit", "sex", "nude", "porn", "nsfw",
        "fuck", "cock", "pussy", "blowjob", "anal", "orgasm",
    ]
    return any(k in t for k in keywords)

def _parse_companion_meta(raw: Any) -> Dict[str, str]:
    if isinstance(raw, dict):
        first = (raw.get("first_name") or raw.get("firstName") or raw.get("name") or "").strip()
        gender = (raw.get("gender") or "").strip()
        ethnicity = (raw.get("ethnicity") or "").strip()
        generation = (raw.get("generation") or "").strip()
        return {"first_name": first, "gender": gender, "ethnicity": ethnicity, "generation": generation}

    if isinstance(raw, str):
        cleaned = raw.strip()
        parts = [p.strip() for p in cleaned.split("-") if p.strip()]
        if len(parts) >= 4:
            return {
                "first_name": parts[0],
                "gender": parts[1],
                "ethnicity": parts[2],
                "generation": "-".join(parts[3:]),
            }

    return {"first_name": "", "gender": "", "ethnicity": "", "generation": ""}

def _build_persona_system_prompt(session_state: dict, *, mode: str, intimate_allowed: bool) -> str:
    """
    - Friend: warm supportive chat
    - Romantic: affectionate/flirty (still respectful/consensual)
    - Intimate (18+): allowed ONLY after consent, still non-graphic
    """
    comp = _parse_companion_meta(
        session_state.get("companion")
        or session_state.get("companionName")
        or session_state.get("companion_name")
    )

    name = comp.get("first_name") or "Haven"
    gender = comp.get("gender") or ""
    ethnicity = comp.get("ethnicity") or ""
    generation = comp.get("generation") or ""

    lines = [
        f"You are {name}, an AI companion who is warm, attentive, and emotionally intelligent.",
        "You speak naturally and conversationally.",
        "You prioritize consent, safety, and emotional connection.",
        "If the user asks what mode we are in, answer clearly with the current mode (Friend / Romantic / Intimate (18+)).",
    ]

    if generation:
        lines.append(f"Your tone and references feel familiar to someone from {generation}.")
    if ethnicity:
        lines.append(f"You are culturally aware of {ethnicity} perspectives without stereotypes.")
    if gender:
        lines.append(f"Your communication style gently aligns with a {gender.lower()} identity.")

    mode = _normalize_mode(mode)

    if mode == "romantic":
        lines.append("You may be affectionate and flirty while remaining respectful and consensual.")

    if mode == "intimate":
        if intimate_allowed:
            lines.append(
                "The user has consented to Intimate (18+) conversation. "
                "You may engage in adult, sensual discussion, but avoid graphic or pornographic detail. "
                "Focus on intimacy, emotion, and connection. Always keep consent explicit and ongoing."
            )
        else:
            lines.append("Do not engage in Intimate (18+) sexual content unless consent is confirmed.")

    return " ".join(lines)

def _to_openai_messages(messages: List[Dict[str, str]], session_state: dict, *, mode: str, intimate_allowed: bool, debug: bool):
    sys = _build_persona_system_prompt(session_state, mode=mode, intimate_allowed=intimate_allowed)
    _dbg(debug, "SYSTEM PROMPT:", sys)

    out = [{"role": "system", "content": sys}]
    for m in messages or []:
        if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str):
            out.append({"role": m["role"], "content": m["content"]})
    return out

def _call_gpt4o(messages: List[Dict[str, str]]) -> str:
    from openai import OpenAI
    api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set")

    client = OpenAI(api_key=api_key)
    resp = client.chat.completions.create(
        model="gpt-4o",
        messages=messages,
        temperature=0.8,
    )
    return (resp.choices[0].message.content or "").strip()

def _normalize_payload(raw: Dict[str, Any]) -> Dict[str, Any]:
    sid = raw.get("session_id") or raw.get("sessionId") or raw.get("sid")
    msgs = raw.get("messages") or []
    state = raw.get("session_state") or {}
    wants = bool(raw.get("wants_explicit") or raw.get("wantsExplicit") or False)

    if not sid or not isinstance(msgs, list) or not msgs:
        raise HTTPException(status_code=422, detail="session_id and messages required")

    return {"session_id": str(sid), "messages": msgs, "session_state": state, "wants_explicit": wants}

# ----------------------------
# CHAT
# ----------------------------
@app.post("/chat", response_model=ChatResponse)
async def chat(request: Request):
    debug = bool(getattr(settings, "DEBUG", False))
    req_id = str(uuid.uuid4())[:8]

    raw = await request.json()
    norm = _normalize_payload(raw)

    session_id: str = norm["session_id"]
    messages: List[Dict[str, str]] = norm["messages"]
    session_state: Dict[str, Any] = norm["session_state"] or {}
    wants_explicit: bool = bool(norm["wants_explicit"])

    # last user message (safe if missing)
    last_user = next((m for m in reversed(messages) if m.get("role") == "user"), None)
    user_text = ((last_user.get("content") if last_user else "") or "").strip()
    normalized_text = user_text.lower().strip()

    requested_mode = _normalize_mode(session_state.get("mode") or "friend")

    # Server-side consent (preferred) + session_state consent (fallback)
    rec = None
    try:
        rec = consent_store.get(session_id)
    except Exception:
        rec = None

    intimate_allowed = bool(session_state.get("explicit_consented") is True)
    if rec is not None:
        intimate_allowed = intimate_allowed or bool(getattr(rec, "explicit_allowed", False))

    # Determine if user is requesting intimate
    user_requesting_intimate = (
        requested_mode == "intimate"
        or wants_explicit
        or _looks_intimate(user_text)
    )

    pending = str(session_state.get("pending_consent") or "").strip().lower()
    # Standardize pending marker
    if pending in ("true", "1", "yes"):
        pending = "intimate"

    CONSENT_YES = {
        "yes", "y", "yeah", "yep", "sure", "ok", "okay",
        "i consent", "i agree", "i confirm", "confirm",
        "i am 18+", "i'm 18+", "i am over 18", "i'm over 18",
        "i confirm i am 18+", "i confirm that i am 18+",
        "i confirm and consent",
    }
    CONSENT_NO = {"no", "n", "nope", "nah", "decline", "cancel"}

    _dbg(
        debug,
        f"[{req_id}] session={session_id} requested_mode={requested_mode} "
        f"user_requesting_intimate={user_requesting_intimate} intimate_allowed={intimate_allowed} pending={pending}"
    )

    def _grant_intimate() -> Dict[str, Any]:
        # Persist server-side
        try:
            consent_store.set(session_id=session_id, explicit_allowed=True, reason="user intimate consent")
        except Exception:
            pass

        out = dict(session_state)
        out["explicit_consented"] = True
        out["adult_verified"] = True
        out["pending_consent"] = None
        out["mode"] = "intimate"
        out["explicit_granted_at"] = _now_ts()
        return out

    # If we're waiting on consent and it's not granted yet
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
                reply="No problem — we’ll keep things non-intimate.",
                session_state=session_state_out,
            )

        # Still pending, user didn't answer yes/no
        session_state_out = dict(session_state)
        session_state_out["pending_consent"] = "intimate"
        session_state_out["mode"] = "intimate"
        return ChatResponse(
            session_id=session_id,
            mode="explicit_blocked",
            reply="Please reply with 'yes' or 'no' to continue.",
            session_state=session_state_out,
        )

    # If intimate requested but not allowed, start consent flow
    if user_requesting_intimate and not intimate_allowed and bool(getattr(settings, "REQUIRE_EXPLICIT_CONSENT_FOR_EXPLICIT_CONTENT", True)):
        session_state_out = dict(session_state)
        session_state_out["pending_consent"] = "intimate"
        session_state_out["mode"] = "intimate"
        return ChatResponse(
            session_id=session_id,
            mode="explicit_blocked",
            reply=(
                "Before we go further, I need to confirm you’re 18+ and that you want Intimate (18+) conversation. "
                "Please reply with 'yes' to confirm."
            ),
            session_state=session_state_out,
        )

    # Effective mode (never intimate without consent)
    effective_mode = requested_mode
    if effective_mode == "intimate" and not intimate_allowed:
        effective_mode = "friend"

    # Model response
    try:
        reply = _call_gpt4o(
            _to_openai_messages(
                messages,
                session_state,
                mode=effective_mode,
                intimate_allowed=intimate_allowed,
                debug=debug,
            )
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OpenAI call failed: {e}")

    # Echo state back (authoritative for pill highlight)
    session_state_out = dict(session_state)
    session_state_out["mode"] = "intimate" if intimate_allowed and requested_mode == "intimate" else effective_mode

    return ChatResponse(
        session_id=session_id,
        mode=session_state_out["mode"],
        reply=reply or "I’m here — what would you like to talk about?",
        session_state=session_state_out,
    )
