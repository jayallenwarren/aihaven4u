from __future__ import annotations

import os
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

# If allow_credentials=True, you cannot use allow_origins=["*"] in browsers.
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


@app.get("/debug/cors")
def debug_cors():
    # ✅ disabled in production
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
def _looks_explicit(text: str) -> bool:
    t = (text or "").lower()
    keywords = [
        "explicit", "nude", "sex", "porn", "dirty", "fuck", "cock", "pussy",
        "blowjob", "anal", "orgasm",
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


def _build_persona_system_prompt(session_state: dict) -> str:
    """
    Builds a stable system prompt based on companion persona.
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
    ]

    if generation:
        lines.append(
            f"Your tone and references should feel familiar and comfortable to someone from {generation}."
        )

    if ethnicity:
        lines.append(
            f"You are culturally aware of {ethnicity} perspectives, without using stereotypes."
        )

    if gender:
        lines.append(
            f"Your communication style aligns gently with a {gender.lower()} identity."
        )

    lines.append(
        "You are supportive, respectful, and focused on the user's emotional experience."
    )

    return " ".join(lines)


def _to_openai_messages(messages: List[Dict[str, str]], session_state: dict) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []

    # Persona system prompt FIRST
    system_prompt = _build_persona_system_prompt(session_state)

    if bool(getattr(settings, "DEBUG", False)):
        print("Persona system prompt:", system_prompt)

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
    raw = await request.json()
    norm = _normalize_payload(raw)

    session_id: str = norm["session_id"]
    messages: List[Dict[str, str]] = norm["messages"]
    session_state: Dict[str, Any] = norm["session_state"] or {}
    wants_explicit: bool = bool(norm["wants_explicit"])

    # Determine last user text early (Step 5 needs it)
    last_user = next((m for m in reversed(messages) if m.get("role") == "user"), None)
    user_text = ((last_user.get("content") if last_user else "") or "").strip()
    normalized_text = user_text.lower()

    # Determine requested mode from session_state (fixes "requested_mode undefined")
    requested_mode = (session_state.get("mode") or "").strip().lower()  # friend/romantic/explicit

    # Determine explicit intent
    user_requesting_explicit = wants_explicit or _looks_explicit(user_text) or (requested_mode == "explicit")

    # =========================
    # STEP 5 — CONSENT REPLY HANDLER (FIXED)
    # =========================
    CONSENT_YES = {
        "yes",
        "y",
        "i consent",
        "i agree",
        "i am 18+",
        "i'm 18+",
        "i confirm",
        "i confirm i am 18+",
        "i confirm that i am 18+",
        "i confirm and consent",
        "i am over 18",
        "i'm over 18",
    }

    pending = (session_state.get("pending_consent") or "").strip().lower()

    # If the UI asked for explicit consent (pending_consent == "explicit") and user says yes:
    if pending == "explicit" and normalized_text in CONSENT_YES:
        consent_store.set(
            session_id=session_id,
            explicit_allowed=True,
            reason="user explicit consent",
        )

        session_state_out = dict(session_state)
        session_state_out["explicit_consented"] = True
        session_state_out["pending_consent"] = None

        return ChatResponse(
            session_id=session_id,
            mode="explicit_allowed",
            reply="Thank you — explicit mode is enabled. What would you like to do next?",
            session_state=session_state_out,
        )

    # If explicit is requested but not yet allowed, ask for consent (sets pending_consent)
    rec = consent_store.get(session_id)
    explicit_allowed = bool(rec and rec.explicit_allowed)

    if (
        getattr(settings, "REQUIRE_EXPLICIT_CONSENT_FOR_EXPLICIT_CONTENT", True)
        and user_requesting_explicit
        and not explicit_allowed
    ):
        session_state_out = dict(session_state)
        session_state_out["pending_consent"] = "explicit"

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
    try:
        assistant_reply = _call_gpt4o(
            _to_openai_messages(messages, session_state),
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

    return ChatResponse(
        session_id=session_id,
        mode="explicit_allowed" if (user_requesting_explicit and explicit_allowed) else "safe",
        reply=assistant_reply or "I’m here — what would you like to talk about?",
        session_state=session_state_out,
    )
