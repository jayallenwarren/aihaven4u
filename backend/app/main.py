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
# CORS
# ----------------------------
_raw = (getattr(settings, "CORS_ALLOW_ORIGINS", "") or "").strip()
raw_origins = [o.strip() for o in _raw.split(",") if o.strip()]
allow_all = _raw == "*"

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


def _looks_intimate(text: str) -> bool:
    """
    Detects "adult/intimate intent" to trigger consent.
    (We treat any mention of explicit as intimate.)
    """
    t = (text or "").lower()
    keywords = [
        "intimate",
        "explicit",
        "sex",
        "nude",
        "porn",
        "nsfw",
        "fuck",
        "cock",
        "pussy",
        "blowjob",
        "anal",
        "orgasm",
        "penetration",
        "oral",
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
        return {
            "first_name": first,
            "gender": gender,
            "ethnicity": ethnicity,
            "generation": generation,
        }

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
    """
    Builds a stable system prompt based on companion persona + mode.

    NOTE:
    - "intimate" mode (18+) is allowed ONLY after consent.
    - Keep it adult, consensual, and non-graphic (avoid pornographic detail).
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
    ]

    if generation:
        lines.append(f"Your tone and references feel familiar to someone from {generation}.")
    if ethnicity:
        lines.append(f"You are culturally aware of {ethnicity} perspectives without stereotypes.")
    if gender:
        lines.append(f"Your communication style gently aligns with a {gender.lower()} identity.")

    mode = (mode or "friend").strip().lower()

    if mode == "romantic":
        lines.append("You may be affectionate and flirty while remaining respectful and consensual.")

    if mode == "intimate":
        if intimate_allowed:
            lines.append(
                "The user has consented to Intimate (18+) conversation. "
                "You may engage in adult, sensual discussion, but avoid graphic or pornographic detail. "
                "Focus on intimacy, emotion, and connection."
            )
        else:
            lines.append("Do not engage in Intimate (18+) content unless explicit consent is confirmed.")

    return " ".join(lines)


def _to_openai_messages(
    messages: List[Dict[str, str]],
    session_state: dict,
    *,
    mode: str,
    intimate_allowed: bool,
    debug: bool,
) -> List[Dict[str, str]]:
    sys_prompt = _build_persona_system_prompt(session_state, mode=mode, intimate_allowed=intimate_allowed)
    _dbg(debug, "SYSTEM PROMPT:", sys_prompt)

    out: List[Dict[str, str]] = [{"role": "system", "content": sys_prompt}]
    for m in messages or []:
        role = m.get("role")
        content = m.get("content")
        if role in ("user", "assistant") and isinstance(content, str):
            out.append({"role": role, "content": content})
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
    """
    Accepts payload:
      - { session_id, messages: [{role, content}], wants_explicit, session_state }
    Returns normalized:
      { session_id, messages, wants_explicit, session_state }
    """
    sid = raw.get("session_id") or raw.get("sessionId") or raw.get("sid")
    msgs = raw.get("messages") or []
    state = raw.get("session_state") or {}
    wants = bool(raw.get("wants_explicit") or raw.get("wantsExplicit") or False)

    if not sid:
        raise HTTPException(status_code=422, detail="session_id is required")
    if not isinstance(msgs, list) or not msgs:
        raise HTTPException(status_code=422, detail="messages is required and cannot be empty")

    return {"session_id": str(sid), "messages": msgs, "session_state": state, "wants_explicit": wants}


def _extract_last_user_text(messages: List[Dict[str, str]]) -> str:
    last_user = next((m for m in reversed(messages or []) if m.get("role") == "user"), None)
    return ((last_user.get("content") if last_user else "") or "").strip()


def _normalize_mode(raw_mode: Optional[str]) -> str:
    """
    Treat any mention of "explicit" as "intimate" (your requirement).
    """
    m = (raw_mode or "").strip().lower()
    if m == "explicit":
        return "intimate"
    return m or "friend"


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

    user_text = _extract_last_user_text(messages)
    user_text_lower = user_text.lower().strip()

    requested_mode = _normalize_mode(session_state.get("mode"))
    requested_intimate = requested_mode == "intimate"

    # Detect intent to enter Intimate (18+) (treat explicit as intimate)
    user_requesting_intimate = wants_explicit or requested_intimate or _looks_intimate(user_text)

    # Server-side consent is the authority (but we mirror flags back into session_state for UI)
    rec = consent_store.get(session_id)
    intimate_allowed = bool(rec and getattr(rec, "explicit_allowed", False))

    # Also accept a client-mirrored flag (keeps UX stable if consent_store is empty during dev),
    # but server-side record wins if present.
    if not intimate_allowed and session_state.get("explicit_consented") is True:
        intimate_allowed = True

    _dbg(
        debug,
        f"[{req_id}] /chat session={session_id} requested_mode={requested_mode} "
        f"user_requesting_intimate={user_requesting_intimate} intimate_allowed={intimate_allowed} "
        f"pending={session_state.get('pending_consent')}",
    )

    # =========================
    # CONSENT FLOW (Intimate 18+)
    # =========================
    # Normalize pending consent sentinel
    pending = (session_state.get("pending_consent") or "")
    if pending is True:
        pending = "intimate"  # migrate older boolean usage

    pending = str(pending).strip().lower() if pending else ""

    CONSENT_YES = {
        "yes",
        "y",
        "yeah",
        "yep",
        "sure",
        "ok",
        "okay",
        "i consent",
        "i agree",
        "i confirm",
        "confirm",
        "i am 18+",
        "i'm 18+",
        "i am over 18",
        "i'm over 18",
        "i confirm i am 18+",
        "i confirm that i am 18+",
        "i confirm and consent",
    }
    CONSENT_NO = {"no", "n", "nope", "nah", "decline", "cancel"}

    def _grant_intimate() -> Dict[str, Any]:
        consent_store.set(session_id=session_id, explicit_allowed=True, reason="user intimate consent")
        out = dict(session_state)
        out["explicit_consented"] = True          # keep key name for back-compat with your UI/backend
        out["adult_verified"] = True
        out["pending_consent"] = None
        out["mode"] = "intimate"
        out["explicit_granted_at"] = _now_ts()
        return out

    # If we already have consent, never keep asking
    if intimate_allowed and session_state.get("pending_consent"):
        session_state["pending_consent"] = None

    # If user is replying to a consent prompt
    if pending and not intimate_allowed:
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
                reply="No problem — we’ll keep things in Friend mode.",
                session_state=session_state_out,
            )

        # still waiting
        session_state_out = dict(session_state)
        session_state_out["pending_consent"] = "intimate"
        session_state_out["mode"] = "intimate"
        return ChatResponse(
            session_id=session_id,
            mode="intimate_blocked",
            reply="Please reply with 'yes' or 'no' to continue.",
            session_state=session_state_out,
        )

    # If intimate is requested but not allowed, prompt for consent
    if user_requesting_intimate and not intimate_allowed:
        session_state_out = dict(session_state)
        session_state_out["pending_consent"] = "intimate"
        session_state_out["mode"] = "intimate"
        return ChatResponse(
            session_id=session_id,
            mode="intimate_blocked",
            reply=(
                "Before we go further, I need to confirm you’re 18+ and that you want Intimate (18+) conversation. "
                "Please reply with 'yes' to confirm."
            ),
            session_state=session_state_out,
        )

    # =========================
    # MODEL RESPONSE
    # =========================
    effective_mode = requested_mode
    if effective_mode == "intimate" and not intimate_allowed:
        effective_mode = "friend"

    # If they are allowed and requested intimate, keep mode intimate
    if intimate_allowed and requested_mode == "intimate":
        effective_mode = "intimate"

    reply = _call_gpt4o(
        _to_openai_messages(
            messages,
            session_state,
            mode=effective_mode,
            intimate_allowed=intimate_allowed,
            debug=debug,
        )
    )

    # Echo state back so frontend can highlight pills correctly
    session_state_out = dict(session_state)
    if intimate_allowed and requested_mode == "intimate":
        session_state_out["mode"] = "intimate"
        session_state_out["explicit_consented"] = True
        session_state_out["pending_consent"] = None

    return ChatResponse(
        session_id=session_id,
        mode=session_state_out.get("mode") or effective_mode,
        reply=reply or "I’m here — what’s on your mind?",
        session_state=session_state_out,
    )
