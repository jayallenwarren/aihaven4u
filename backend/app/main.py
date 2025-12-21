from __future__ import annotations

import os
import time
import uuid
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if allow_all else raw_origins,
    # If allow_all, credentials must be false in browsers
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
# Global exception handler (prevents silent 500s)
# ----------------------------
@app.exception_handler(Exception)
async def _unhandled_exc_handler(request: Request, exc: Exception):
    debug = bool(getattr(settings, "DEBUG", False))
    # Keep production response simple; include error details only in debug.
    payload = {"detail": "Internal Server Error"}
    if debug:
        payload["error"] = repr(exc)
    return JSONResponse(status_code=500, content=payload)


# ----------------------------
# Helpers
# ----------------------------
def _dbg(enabled: bool, *args: Any) -> None:
    if enabled:
        print(*args)


def _now_ts() -> int:
    return int(time.time())


def _looks_explicit(text: str) -> bool:
    t = (text or "").lower()
    keywords = [
        "explicit", "intimate", "sex", "nude", "porn", "nsfw",
        "fuck", "cock", "pussy", "blowjob", "anal", "orgasm",
        "penetration", "hardcore", "oral",
    ]
    return any(k in t for k in keywords)


def _parse_companion_meta(raw: Any) -> Dict[str, str]:
    """
    Accepts:
      - dict: {first_name, gender, ethnicity, generation} (or common variants)
      - str:  "First-Gender-Ethnicity-Generation X"
    """
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


def _normalize_mode(raw_mode: str) -> str:
    """
    Frontend historically used mode="explicit" while labeling it "Intimate (18+)".
    Some backend versions used mode="intimate".
    We treat both as the same adult mode.
    """
    m = (raw_mode or "").strip().lower()
    if m in ("explicit", "intimate", "18+", "adult"):
        return "explicit"  # canonical internal value
    if m in ("romantic", "friend"):
        return m
    return "friend"


def _mode_label(mode: str) -> str:
    mode = _normalize_mode(mode)
    if mode == "friend":
        return "Friend"
    if mode == "romantic":
        return "Romantic"
    return "Intimate (18+)"  # adult mode label


def _is_mode_question(text_lower: str) -> bool:
    t = (text_lower or "").strip()
    return any(
        phrase in t
        for phrase in [
            "what mode am i in",
            "what mode are we in",
            "are we in",
            "which mode",
            "what mode is this",
            "are you in",
        ]
    )


def _build_persona_system_prompt(
    session_state: dict,
    *,
    mode: str,
    explicit_allowed: bool,
) -> str:
    """
    Persona + mode shaping.

    Adult mode = "explicit" internally, but UI label is "Intimate (18+)".
    Keep adult content consensual and non-graphic.
    """
    raw_companion = (
        session_state.get("companion")
        or session_state.get("companionName")
        or session_state.get("companion_name")
    )
    comp = _parse_companion_meta(raw_companion)

    name = comp.get("first_name") or "Haven"
    gender = comp.get("gender") or ""
    ethnicity = comp.get("ethnicity") or ""
    generation = comp.get("generation") or ""

    mode = _normalize_mode(mode)

    lines = [
        f"You are {name}, an AI companion who is warm, attentive, and emotionally intelligent.",
        "You speak naturally and conversationally.",
        "You prioritize consent, safety, and emotional connection.",
        "IMPORTANT UI FACT: The app has three modes: Friend, Romantic, and Intimate (18+).",
        "If the user asks what mode you're in, answer directly and confidently with the current mode label.",
        "Never claim you don't have modes or that you can't see the UI modes.",
    ]

    if generation:
        lines.append(f"Your tone and references feel familiar to someone from {generation}.")

    if ethnicity:
        lines.append(f"You are culturally aware of {ethnicity} perspectives without stereotypes.")

    if gender:
        lines.append(f"Your communication style gently aligns with a {gender.lower()} identity.")

    if mode == "romantic":
        lines.append("In Romantic mode, you may be affectionate, flirty, and romantic while staying respectful and consensual.")

    if mode == "explicit":
        if explicit_allowed:
            lines.append(
                "In Intimate (18+) mode, you may engage in adult, sensual conversation consensually, "
                "but avoid graphic/pornographic detail. Keep it tasteful, consent-forward, and emotionally focused."
            )
        else:
            lines.append("Do not engage in Intimate (18+) content unless explicit consent is confirmed.")

    return " ".join(lines)


def _to_openai_messages(
    messages: List[Dict[str, str]],
    session_state: dict,
    *,
    mode: str,
    explicit_allowed: bool,
    debug: bool,
) -> List[Dict[str, str]]:
    sys_prompt = _build_persona_system_prompt(session_state, mode=mode, explicit_allowed=explicit_allowed)
    _dbg(debug, "SYSTEM PROMPT:", sys_prompt)

    out: List[Dict[str, str]] = [{"role": "system", "content": sys_prompt}]
    for m in messages or []:
        role = m.get("role")
        content = m.get("content")
        if role in ("user", "assistant") and isinstance(content, str):
            out.append({"role": role, "content": content})
    return out


def _call_gpt4o(messages: List[Dict[str, str]], *, model: str = "gpt-4o") -> str:
    api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set")

    # Prefer OpenAI SDK v1.x, fallback to older
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
        import openai  # type: ignore
        openai.api_key = api_key
        resp = openai.ChatCompletion.create(
            model=model,
            messages=messages,
            temperature=0.8,
        )
        return (resp["choices"][0]["message"]["content"] or "").strip()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OpenAI call failed: {e}")


def _normalize_payload(raw: Dict[str, Any]) -> Dict[str, Any]:
    """
    Accepts:
      A) { session_id, messages:[{role,content}], wants_explicit?, session_state? }
      B) { sid, text, history:[{role,content}], session_state? }
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

    session_state = raw.get("session_state") or raw.get("sessionState") or {}
    wants_explicit = bool(raw.get("wants_explicit") or raw.get("wantsExplicit") or False)

    return {
        "session_id": str(session_id),
        "messages": msgs,
        "session_state": session_state if isinstance(session_state, dict) else {},
        "wants_explicit": wants_explicit,
    }


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

    # last user text (safe)
    last_user = next((m for m in reversed(messages) if m.get("role") == "user"), None)
    user_text = ((last_user.get("content") if last_user else "") or "").strip()
    normalized_text = user_text.lower().strip()

    # Mode request (treat "intimate" == "explicit")
    requested_mode = _normalize_mode(session_state.get("mode") or "friend")

    # Determine if user is requesting adult mode/intimacy
    user_requesting_explicit = (
        wants_explicit
        or _looks_explicit(user_text)
        or (requested_mode == "explicit")
    )

    # Server-side consent is the authority
    rec = consent_store.get(session_id)
    explicit_allowed = bool(rec and getattr(rec, "explicit_allowed", False))

    _dbg(
        debug,
        f"[{req_id}] session={session_id} requested_mode={requested_mode} "
        f"user_requesting_explicit={user_requesting_explicit} explicit_allowed={explicit_allowed} "
        f"pending={session_state.get('pending_consent')}",
    )

    # Deterministic "what mode are we in?" answer (prevents model saying it has no modes)
    if _is_mode_question(normalized_text):
        # effective mode should reflect whether explicit is actually allowed
        effective = requested_mode
        if effective == "explicit" and not explicit_allowed:
            effective = "friend"
        session_state_out = dict(session_state)
        session_state_out["mode"] = effective
        return ChatResponse(
            session_id=session_id,
            mode=effective,
            reply=f"We're in {_mode_label(effective)} mode.",
            session_state=session_state_out,
        )

    # ----------------------------
    # Consent flow for Intimate (18+)
    # ----------------------------
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
        consent_store.set(
            session_id=session_id,
            explicit_allowed=True,
            reason="user explicit consent",
        )
        out = dict(session_state)
        out["explicit_consented"] = True
        out["adult_verified"] = True
        out["pending_consent"] = None
        out["mode"] = "explicit"
        out["explicit_granted_at"] = _now_ts()
        return out

    # If already allowed, never keep asking
    if explicit_allowed and session_state.get("pending_consent"):
        session_state["pending_consent"] = None

    # If user is answering a pending consent prompt
    if pending and not explicit_allowed:
        if normalized_text in CONSENT_YES:
            session_state_out = _grant_explicit()
            return ChatResponse(
                session_id=session_id,
                mode="explicit",
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

        session_state_out = dict(session_state)
        session_state_out["pending_consent"] = pending or "explicit"
        return ChatResponse(
            session_id=session_id,
            mode="friend",
            reply="Please reply with 'yes' or 'no' to continue.",
            session_state=session_state_out,
        )

    # If user requests intimate/explicit but not allowed yet → ask for consent
    if (
        getattr(settings, "REQUIRE_EXPLICIT_CONSENT_FOR_EXPLICIT_CONTENT", True)
        and user_requesting_explicit
        and not explicit_allowed
    ):
        session_state_out = dict(session_state)
        session_state_out["pending_consent"] = "explicit"
        # keep mode request visible to UI
        session_state_out["mode"] = "explicit"

        return ChatResponse(
            session_id=session_id,
            mode="friend",
            reply=(
                "Before we go further, I need to confirm you’re 18+ and that you want Intimate (18+) conversation. "
                "Please reply with 'yes' to confirm."
            ),
            session_state=session_state_out,
        )

    # ----------------------------
    # Model response
    # ----------------------------
    effective_mode = requested_mode
    if effective_mode == "explicit" and not explicit_allowed:
        effective_mode = "friend"

    assistant_reply = _call_gpt4o(
        _to_openai_messages(
            messages,
            session_state,
            mode=effective_mode,
            explicit_allowed=explicit_allowed,
            debug=debug,
        )
    )

    session_state_out = dict(session_state)
    session_state_out["mode"] = effective_mode

    # helpful normalization (non-breaking)
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
        mode=effective_mode,
        reply=assistant_reply or "I’m here — what would you like to talk about?",
        session_state=session_state_out,
    )
