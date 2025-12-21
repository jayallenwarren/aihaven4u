from __future__ import annotations

import os
import time
import uuid
from typing import Any, Dict, List

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
    # If allow_credentials=True, you cannot use allow_origins=["*"] in browsers.
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


@app.get("/debug/cors")
def debug_cors():
    # disabled in production
    if not bool(getattr(settings, "DEBUG", False)):
        raise HTTPException(status_code=404, detail="Not Found")

    return {
        "CORS_ALLOW_ORIGINS_raw": _raw,
        "parsed_origins": raw_origins,
        "allow_all": allow_all,
        "allow_credentials": (not allow_all),
    }


# ----------------------------
# Helpers
# ----------------------------
def _dbg(enabled: bool, *args: Any) -> None:
    if enabled:
        print(*args)


def _now_ts() -> int:
    return int(time.time())


def _get_explicit_ttl_seconds() -> int:
    # configurable, default 6 hours
    try:
        return int(os.getenv("EXPLICIT_CONSENT_TTL_SECONDS", "21600").strip())
    except Exception:
        return 21600


def _user_wants_exit_explicit(user_text_lower: str) -> bool:
    t = (user_text_lower or "").strip()
    return any(
        phrase in t
        for phrase in [
            "exit explicit",
            "leave explicit",
            "turn off explicit",
            "stop explicit",
            "disable explicit",
            "back to friend",
            "switch to friend",
            "go back to friend",
        ]
    )


def _looks_explicit(text: str) -> bool:
    t = (text or "").lower()
    keywords = [
        "explicit",
        "nude",
        "sex",
        "porn",
        "dirty",
        "fuck",
        "cock",
        "pussy",
        "blowjob",
        "anal",
        "orgasm",
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
        cleaned = raw.strip()
        if not cleaned:
            return {"first_name": "", "gender": "", "ethnicity": "", "generation": ""}

        parts = [p.strip() for p in cleaned.split("-") if p.strip()]
        if len(parts) >= 4:
            return {
                "first_name": parts[0],
                "gender": parts[1],
                "ethnicity": parts[2],
                "generation": "-".join(parts[3:]),  # allow hyphens/spaces in generation
            }

    return {"first_name": "", "gender": "", "ethnicity": "", "generation": ""}


def _build_persona_system_prompt(
    session_state: dict,
    *,
    mode: str,
    explicit_allowed: bool,
) -> str:
    """
    Builds a stable system prompt based on companion persona + mode.

    NOTE:
    - "explicit" mode means adult conversation is allowed ONLY after consent.
    - Keep it adult, consensual, and non-graphic (avoid pornographic detail).
    """
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
        "You are supportive, respectful, and focused on the user's emotional experience.",
    ]

    if generation:
        lines.append(f"Your tone and references feel familiar to someone from {generation}.")

    if ethnicity:
        lines.append(f"You are culturally aware of {ethnicity} perspectives without stereotypes.")

    if gender:
        lines.append(f"Your communication style gently aligns with a {gender.lower()} identity.")

    # Mode shaping
    mode = (mode or "friend").strip().lower()
    if mode == "romantic":
        lines.append("You may be affectionate, flirty, and romantic while staying respectful and consensual.")
    elif mode == "explicit":
        if explicit_allowed:
            lines.append(
                "The user has opted into adult conversation. You may discuss sexual topics consensually, "
                "but avoid graphic pornographic detail; keep it tasteful, safe, and consent-forward."
            )
        else:
            # Shouldn't happen if the gate works, but keep safe.
            lines.append("Do not engage in adult sexual content unless explicit consent is confirmed.")

    return " ".join(lines)


def _to_openai_messages(
    messages: List[Dict[str, str]],
    session_state: dict,
    *,
    mode: str,
    explicit_allowed: bool,
    debug: bool,
) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []

    system_prompt = _build_persona_system_prompt(session_state, mode=mode, explicit_allowed=explicit_allowed)
    _dbg(debug, "Persona system prompt:", system_prompt)

    out.append({"role": "system", "content": system_prompt})

    for m in messages or []:
        role = m.get("role")
        content = m.get("content")
        if role in ("user", "assistant") and isinstance(content, str):
            out.append({"role": role, "content": content})

    return out


def _call_gpt4o(messages: List[Dict[str, str]], model: str = "gpt-4o") -> str:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set")

    # Prefer new OpenAI SDK (v1.x)
    try:
        from openai import OpenAI  # type: ignore
        client = OpenAI(api_key=api_key)
        resp = client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=0.8,
        )
        return (resp.choices[0].message.content or "").strip()
    except ImportError:
        # Fallback: older SDK (v0.x)
        import openai  # type: ignore
        openai.api_key = api_key
        resp = openai.ChatCompletion.create(
            model=model,
            messages=messages,
            temperature=0.8,
        )
        return (resp["choices"][0]["message"]["content"] or "").strip()


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

    # Determine last user text early (CONSENT HANDLER needs this)
    last_user = next((m for m in reversed(messages) if m.get("role") == "user"), None)
    user_text = ((last_user.get("content") if last_user else "") or "").strip()
    normalized_text = user_text.lower().strip()

    # Requested mode from UI
    requested_mode = (session_state.get("mode") or "").strip().lower()  # friend/romantic/explicit

    # Determine explicit intent
    user_requesting_explicit = wants_explicit or _looks_explicit(user_text) or (requested_mode == "explicit")

    # Pull server consent state FIRST
    rec = consent_store.get(session_id)
    explicit_allowed = bool(rec and getattr(rec, "explicit_allowed", False))

    # TTL (timeout) support (stored in session_state; frontend echoes session_state back)
    ttl = _get_explicit_ttl_seconds()
    granted_at = session_state.get("explicit_granted_at")
    if explicit_allowed and isinstance(granted_at, int) and ttl > 0:
        if _now_ts() - granted_at > ttl:
            explicit_allowed = False
            session_state["explicit_consented"] = False
            session_state["pending_consent"] = None
            session_state["mode"] = "friend"

    # Manual revoke / exit explicit
    if _user_wants_exit_explicit(normalized_text):
        session_state["mode"] = "friend"
        session_state["explicit_consented"] = False
        session_state["pending_consent"] = None
        return ChatResponse(
            session_id=session_id,
            mode="safe",
            reply="Okay — we’ll switch back to Friend mode.",
            session_state=session_state,
        )

    _dbg(
        debug,
        f"[{req_id}] /chat session={session_id} requested_mode={requested_mode} "
        f"user_requesting_explicit={user_requesting_explicit} explicit_allowed={explicit_allowed} "
        f"pending={session_state.get('pending_consent')}",
    )

    # =========================
    # STEP 5 — CONSENT HANDLER (WORKING)
    # =========================
    CONSENT_YES = {
        "yes", "y", "yeah", "yep", "sure", "ok", "okay",
        "i consent", "i agree", "i confirm", "confirm",
        "i am 18+", "i'm 18+", "i am over 18", "i'm over 18",
        "i confirm i am 18+", "i confirm that i am 18+",
        "i confirm and consent",
    }
    CONSENT_NO = {"no", "n", "nope", "nah", "decline", "cancel"}

    pending = (session_state.get("pending_consent") or "").strip().lower()

    def _grant_explicit() -> Dict[str, Any]:
        # Persist server-side
        consent_store.set(
            session_id=session_id,
            explicit_allowed=True,
            reason="user explicit consent",
        )
        out = dict(session_state)
        out["adult_verified"] = True
        out["explicit_consented"] = True
        out["pending_consent"] = None
        out["mode"] = "explicit"
        out["explicit_granted_at"] = _now_ts()
        return out

    # If we already have explicit_allowed, ensure we NEVER keep asking again
    if explicit_allowed and session_state.get("pending_consent"):
        session_state["pending_consent"] = None

    # If user replies while we are waiting for consent and explicit isn't allowed yet
    if pending and not explicit_allowed:
        if normalized_text in CONSENT_YES:
            session_state_out = _grant_explicit()
            return ChatResponse(
                session_id=session_id,
                mode="explicit",
                reply="Thank you — explicit mode is enabled. What would you like to talk about?",
                session_state=session_state_out,
            )

        if normalized_text in CONSENT_NO:
            session_state_out = dict(session_state)
            session_state_out["pending_consent"] = None
            session_state_out["explicit_consented"] = False
            session_state_out["mode"] = "friend"
            return ChatResponse(
                session_id=session_id,
                mode="safe",
                reply="No problem — we’ll keep things non-explicit.",
                session_state=session_state_out,
            )

        session_state_out = dict(session_state)
        session_state_out["pending_consent"] = pending or "explicit"
        return ChatResponse(
            session_id=session_id,
            mode="explicit_blocked",
            reply="Please reply with 'yes' or 'no' to continue.",
            session_state=session_state_out,
        )

    # If explicit is requested but not yet allowed, ask for consent
    if (
        getattr(settings, "REQUIRE_EXPLICIT_CONSENT_FOR_EXPLICIT_CONTENT", True)
        and user_requesting_explicit
        and not explicit_allowed
    ):
        session_state_out = dict(session_state)
        session_state_out["pending_consent"] = "explicit"
        # keep mode request visible to UI but do not allow yet
        session_state_out["mode"] = "explicit"

        return ChatResponse(
            session_id=session_id,
            mode="explicit_blocked",
            reply=(
                "Before we go further, I need to confirm you’re 18+ and that you want explicit adult conversation. "
                "Please reply with 'yes' to confirm."
            ),
            session_state=session_state_out,
        )

    # =========================
    # OpenAI response
    # =========================
    # Choose the mode the model should follow
    effective_mode = requested_mode or "friend"
    if effective_mode == "explicit" and not explicit_allowed:
        # safety fallback: if UI asked explicit but we haven't granted it, stay friend
        effective_mode = "friend"

    try:
        assistant_reply = _call_gpt4o(
            _to_openai_messages(
                messages,
                session_state,
                mode=effective_mode,
                explicit_allowed=explicit_allowed,
                debug=debug,
            ),
            model="gpt-4o",
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OpenAI call failed: {e}")

    # Echo state back so the frontend can render plan/companion correctly
    session_state_out = dict(session_state)

    # Normalize plan key variants (so UI doesn't show Unknown)
    if "plan_name" not in session_state_out and "planName" in session_state_out:
        session_state_out["plan_name"] = session_state_out.get("planName")

    # Also expose a normalized companion meta object (non-breaking)
    raw_comp = (
        session_state_out.get("companion")
        or session_state_out.get("companionName")
        or session_state_out.get("companion_name")
    )
    session_state_out["companion_meta"] = _parse_companion_meta(raw_comp)

    # Ensure mode reflects actual state
    if explicit_allowed and requested_mode == "explicit":
        session_state_out["mode"] = "explicit"

    return ChatResponse(
        session_id=session_id,
        mode="explicit" if (explicit_allowed and requested_mode == "explicit") else "safe",
        reply=assistant_reply or "I’m here — what would you like to talk about?",
        session_state=session_state_out,
    )
