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
    if isinstance(raw, dict):
        return {
            "first_name": (raw.get("first_name") or raw.get("firstName") or raw.get("name") or "").strip(),
            "gender": (raw.get("gender") or "").strip(),
            "ethnicity": (raw.get("ethnicity") or "").strip(),
            "generation": (raw.get("generation") or "").strip(),
        }

    if isinstance(raw, str):
        parts = [p.strip() for p in raw.strip().split("-") if p.strip()]
        if len(parts) >= 4:
            return {
                "first_name": parts[0],
                "gender": parts[1],
                "ethnicity": parts[2],
                "generation": "-".join(parts[3:]),
            }

    return {"first_name": "", "gender": "", "ethnicity": "", "generation": ""}


def _build_persona_system_prompt(session_state: dict) -> str:
    raw = (
        session_state.get("companion")
        or session_state.get("companionName")
        or session_state.get("companion_name")
    )
    c = _parse_companion_meta(raw)

    name = c.get("first_name") or "Haven"

    lines = [
        f"You are {name}, an AI companion who speaks naturally and attentively.",
        "You are emotionally intelligent, supportive, and present.",
    ]

    if c.get("generation"):
        lines.append(f"Your tone feels familiar to someone from {c['generation']}.")

    if c.get("ethnicity"):
        lines.append(f"You are culturally aware of {c['ethnicity']} perspectives.")

    if c.get("gender"):
        lines.append(f"Your communication style gently aligns with a {c['gender'].lower()} identity.")

    return " ".join(lines)


def _to_openai_messages(messages: List[Dict[str, str]], session_state: dict) -> List[Dict[str, str]]:
    out = [{"role": "system", "content": _build_persona_system_prompt(session_state)}]
    for m in messages:
        if m.get("role") in ("user", "assistant"):
            out.append({"role": m["role"], "content": m["content"]})
    return out


def _call_gpt4o(messages: List[Dict[str, str]], model: str = "gpt-4o") -> str:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set")

    from openai import OpenAI
    client = OpenAI(api_key=api_key)
    resp = client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=0.8,
    )
    return (resp.choices[0].message.content or "").strip()


def _normalize_payload(raw: Dict[str, Any]) -> Dict[str, Any]:
    session_id = raw.get("session_id") or raw.get("sessionId") or raw.get("sid")
    if not session_id:
        raise HTTPException(status_code=422, detail="session_id is required")

    msgs = raw.get("messages") or []
    if not msgs:
        if raw.get("text"):
            msgs = [{"role": "user", "content": raw["text"]}]

    if not msgs:
        raise HTTPException(status_code=422, detail="messages cannot be empty")

    return {
        "session_id": str(session_id),
        "messages": msgs,
        "session_state": raw.get("session_state") or {},
        "wants_explicit": bool(raw.get("wants_explicit")),
    }


# ----------------------------
# CHAT
# ----------------------------
@app.post("/chat", response_model=ChatResponse)
async def chat(request: Request):
    raw = await request.json()
    norm = _normalize_payload(raw)

    session_id = norm["session_id"]
    messages = norm["messages"]
    session_state = norm["session_state"]
    wants_explicit = norm["wants_explicit"]

    last_user = next((m for m in reversed(messages) if m["role"] == "user"), None)
    user_text = (last_user["content"] if last_user else "").strip().lower()

    requested_mode = (session_state.get("mode") or "").lower()
    user_requesting_explicit = wants_explicit or _looks_explicit(user_text) or requested_mode == "explicit"

    # 🔑 CRITICAL FIX — resolve consent ONCE
    rec = consent_store.get(session_id)
    explicit_allowed = bool(rec and rec.explicit_allowed)

    # =========================
    # CONSENT HANDLER
    # =========================
    CONSENT_YES = {
        "yes", "y", "ok", "okay", "i consent", "i agree",
        "i am 18+", "i'm 18+", "i confirm", "i am over 18",
    }

    pending = (session_state.get("pending_consent") or "").lower()

    if not explicit_allowed and pending == "explicit":
        if user_text in CONSENT_YES:
            consent_store.set(session_id=session_id, explicit_allowed=True)
            session_state.update({
                "explicit_consented": True,
                "adult_verified": True,
                "pending_consent": None,
                "mode": "explicit",
            })
            return ChatResponse(
                session_id=session_id,
                mode="explicit",
                reply="Thank you — explicit mode is now enabled. What would you like to do?",
                session_state=session_state,
            )

        return ChatResponse(
            session_id=session_id,
            mode="explicit_blocked",
            reply="Please reply with 'yes' to confirm explicit consent.",
            session_state=session_state,
        )

    if (
        getattr(settings, "REQUIRE_EXPLICIT_CONSENT_FOR_EXPLICIT_CONTENT", True)
        and user_requesting_explicit
        and not explicit_allowed
    ):
        session_state["pending_consent"] = "explicit"
        return ChatResponse(
            session_id=session_id,
            mode="explicit_blocked",
            reply="Before we go further, please confirm you’re 18+ by replying 'yes'.",
            session_state=session_state,
        )

    # =========================
    # LLM
    # =========================
    assistant_reply = _call_gpt4o(
        _to_openai_messages(messages, session_state)
    )

    session_state["companion_meta"] = _parse_companion_meta(
        session_state.get("companion")
        or session_state.get("companionName")
        or session_state.get("companion_name")
    )

    return ChatResponse(
        session_id=session_id,
        mode="explicit" if explicit_allowed else "safe",
        reply=assistant_reply,
        session_state=session_state,
    )
