from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from .settings import settings
from .models import ChatRequest, ChatResponse
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


def _to_openai_messages(messages: List[Dict[str, str]]) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
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

    # messages from new client
    msgs = raw.get("messages")

    # old client used `history` and/or `text`
    history = raw.get("history")
    text = raw.get("text")

    if not msgs:
        # Build from history + text
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
    # We parse JSON ourselves so we can support both payload shapes without breaking.
    raw = await request.json()
    norm = _normalize_payload(raw)

    session_id: str = norm["session_id"]
    messages: List[Dict[str, str]] = norm["messages"]
    wants_explicit: bool = norm["wants_explicit"]

    # Determine "explicit intent"
    last_user = next((m for m in reversed(messages) if m.get("role") == "user"), None)
    user_text = (last_user.get("content") if last_user else "") or ""
    user_requesting_explicit = wants_explicit or _looks_explicit(user_text)

    # Consent gate (your existing store)
    rec = consent_store.get(session_id)
    explicit_allowed = bool(rec and rec.explicit_allowed)

    if (
        getattr(settings, "REQUIRE_EXPLICIT_CONSENT_FOR_EXPLICIT_CONTENT", True)
        and user_requesting_explicit
        and not explicit_allowed
    ):
        return ChatResponse(
            session_id=session_id,
            mode="explicit_blocked",
            reply=(
                "Before we go further, I need to confirm you’re 18+ and that you want explicit adult conversation. "
                "Please use the consent flow to opt in (double 18+ confirmation + explicit intent)."
            ),
        )

    # ✅ Real OpenAI response (no more echo)
    try:
        assistant_reply = _call_gpt4o(_to_openai_messages(messages), model="gpt-4o")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OpenAI call failed: {e}")

    return ChatResponse(
        session_id=session_id,
        mode="explicit_allowed" if (user_requesting_explicit and explicit_allowed) else "safe",
        reply=assistant_reply or "I’m here — what would you like to talk about?",
    )
