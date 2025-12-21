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

def _looks_explicit(text: str) -> bool:
    t = (text or "").lower()
    return any(
        k in t for k in [
            "explicit", "sex", "nude", "porn", "fuck",
            "cock", "pussy", "blowjob", "anal", "orgasm"
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

def _to_openai_messages(messages, session_state, *, mode, intimate_allowed, debug):
    sys = _build_persona_system_prompt(session_state, mode=mode, intimate_allowed=intimate_allowed)
    _dbg(debug, "SYSTEM PROMPT:", sys)

    out = [{"role": "system", "content": sys}]
    for m in messages:
        if m.get("role") in ("user", "assistant"):
            out.append(m)
    return out

def _call_gpt4o(messages):
    from openai import OpenAI
    client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    resp = client.chat.completions.create(
        model="gpt-4o",
        messages=messages,
        temperature=0.8,
    )
    return resp.choices[0].message.content.strip()

def _normalize_payload(raw: Dict[str, Any]) -> Dict[str, Any]:
    sid = raw.get("session_id") or raw.get("sid")
    msgs = raw.get("messages") or []
    state = raw.get("session_state") or {}
    wants = bool(raw.get("wants_explicit"))
    if not sid or not msgs:
        raise HTTPException(422, "session_id and messages required")
    return {"session_id": sid, "messages": msgs, "session_state": state, "wants_explicit": wants}

# ----------------------------
# CHAT
# ----------------------------
@app.post("/chat", response_model=ChatResponse)
async def chat(request: Request):
    debug = bool(getattr(settings, "DEBUG", False))
    raw = await request.json()
    norm = _normalize_payload(raw)

    session_id = norm["session_id"]
    messages = norm["messages"]
    session_state = norm["session_state"]
    wants_explicit = norm["wants_explicit"]

    last_user = next(m for m in reversed(messages) if m["role"] == "user")
    user_text = last_user["content"].strip().lower()

    requested_mode = (session_state.get("mode") or "friend").lower()
    requested_intimate = requested_mode == "intimate"

    # 🔐 FINAL AUTHORITY: session_state
    intimate_allowed = session_state.get("explicit_consented") is True

    # === CONSENT FLOW ===
    if requested_intimate and not intimate_allowed:
        if user_text in {"yes", "y", "i consent", "i agree"}:
            session_state.update({
                "explicit_consented": True,
                "pending_consent": None,
                "mode": "intimate",
                "explicit_granted_at": _now_ts(),
            })
            return ChatResponse(
                session_id=session_id,
                mode="intimate",
                reply="Thank you — Intimate (18+) mode is enabled. What would you like to explore together?",
                session_state=session_state,
            )

        session_state["pending_consent"] = True
        return ChatResponse(
            session_id=session_id,
            mode="explicit_blocked",
            reply="Before we continue, please confirm you are 18+ and consent to Intimate (18+) conversation. Reply 'yes' to continue.",
            session_state=session_state,
        )

    # === MODEL RESPONSE ===
    reply = _call_gpt4o(
        _to_openai_messages(
            messages,
            session_state,
            mode="intimate" if intimate_allowed else requested_mode,
            intimate_allowed=intimate_allowed,
            debug=debug,
        )
    )

    return ChatResponse(
        session_id=session_id,
        mode="intimate" if intimate_allowed else "safe",
        reply=reply,
        session_state=session_state,
    )
