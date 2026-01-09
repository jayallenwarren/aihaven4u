from __future__ import annotations

import os
import time
import uuid
from datetime import datetime, timedelta, timezone

import requests
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

# Optional: Azure Blob Storage SDK for hosting TTS MP3s (keeps /chat working even if this is missing)
try:
    from azure.storage.blob import (
        BlobServiceClient,
        ContentSettings,
        BlobSasPermissions,
        generate_blob_sas,
    )
except Exception:
    BlobServiceClient = None  # type: ignore
    ContentSettings = None  # type: ignore
    BlobSasPermissions = None  # type: ignore
    generate_blob_sas = None  # type: ignore

from .settings import settings
from .models import ChatResponse

# If you still want the consent router, keep it BUT don't let it break boot.
# (Boot failures are what cause "CORS missing" + 503.)
try:
    from .consent import router as consent_router  # type: ignore
except Exception:
    consent_router = None

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
if consent_router is not None:
    app.include_router(consent_router)


@app.get("/health")
def health():
    return {"ok": True}


# ----------------------------
# Chat logic (unchanged from your existing backend behavior)
# ----------------------------

STATUS_SAFE = "safe"
STATUS_BLOCKED = "explicit_blocked"
STATUS_ALLOWED = "explicit_allowed"


def _detect_mode_switch_from_text(text: str) -> Optional[str]:
    t = (text or "").lower().strip()

    # explicit hints: allow [mode:romantic] etc
    if "mode:friend" in t or "[mode:friend]" in t:
        return "friend"
    if "mode:romantic" in t or "[mode:romantic]" in t:
        return "romantic"
    if (
        "mode:intimate" in t
        or "[mode:intimate]" in t
        or "mode:explicit" in t
        or "[mode:explicit]" in t
    ):
        return "intimate"

    # soft detection (more natural language coverage)
    # friend
    if any(
        p in t
        for p in [
            "switch to friend",
            "go to friend",
            "back to friend",
            "friend mode",
            "set friend",
            "set mode to friend",
            "turn on friend",
        ]
    ):
        return "friend"

    # romantic
    if any(
        p in t
        for p in [
            "switch to romantic",
            "switch to romance",
            "go to romantic",
            "go to romance",
            "back to romantic",
            "back to romance",
            "romantic mode",
            "romance mode",
            "let's be romantic",
            "lets be romantic",
            "romance again",
            "try romance again",
            "romantic conversation",
        ]
    ):
        return "romantic"

    # intimate
    if any(
        p in t
        for p in [
            "switch to intimate",
            "go to intimate",
            "back to intimate",
            "intimate mode",
            "explicit mode",
            "adult mode",
            "18+",
        ]
    ):
        return "intimate"

    return None


def _should_block_intimate(session_state: Dict[str, Any]) -> bool:
    # backend should require explicit consent before intimate
    return not bool(session_state.get("explicit_consented"))


def _safe_get(obj: Dict[str, Any], *keys: str) -> Any:
    for k in keys:
        if k in obj and obj[k] is not None:
            return obj[k]
    return None


def _get_companion_identity(session_state: Dict[str, Any]) -> str:
    # Allow multiple key formats (frontend may send companionKey, companionName, companion_name)
    return (
        _safe_get(session_state, "companion", "companionName", "companion_name")
        or "Haven"
    )


def _build_system_prompt(companion: str, mode: str) -> str:
    # Keep this aligned with your existing persona system. This is minimal and safe.
    if mode == "friend":
        style = "friendly, supportive, safe"
    elif mode == "romantic":
        style = "warm, romantic, sweet (non-explicit)"
    else:
        style = "intimate but must follow policy constraints"

    return (
        f"You are {companion}, an AI companion in AI Haven 4U. "
        f"Respond in a {style} tone. "
        f"Never claim to be someone else."
    )


def _call_openai_like_model(messages: List[Dict[str, str]], model: str) -> str:
    # Your original implementation likely calls OpenAI via settings.OPENAI_API_KEY etc.
    # This drop-in keeps your current behavior by delegating to settings.chat_completion() if present.
    chat_completion = getattr(settings, "chat_completion", None)
    if callable(chat_completion):
        return chat_completion(messages=messages, model=model)

    # If you didn't expose a helper, raise a clear error.
    raise RuntimeError("No chat completion helper found in settings.chat_completion")


@app.post("/chat", response_model=ChatResponse)
async def chat(req: Request) -> ChatResponse:
    """
    Expected input JSON:
      {
        "session_id": "...",
        "wants_explicit": true/false,
        "session_state": {...},
        "messages": [{"role":"user|assistant", "content":"..."}]
      }
    """
    body = await req.json()
    session_id = body.get("session_id")
    wants_explicit = bool(body.get("wants_explicit"))
    session_state_in = body.get("session_state") or {}
    messages_in = body.get("messages") or []

    if not session_id:
        raise HTTPException(status_code=422, detail="session_id required")

    # Normalize mode from session_state if present; otherwise friend
    mode = session_state_in.get("mode") or "friend"
    mode = mode if mode in ("friend", "romantic", "intimate") else "friend"

    # Allow user text to request mode switch
    user_text = ""
    if messages_in and isinstance(messages_in[-1], dict):
        user_text = str(messages_in[-1].get("content") or "")

    detected_switch = _detect_mode_switch_from_text(user_text)
    if detected_switch in ("friend", "romantic", "intimate"):
        mode = detected_switch

    # Consent gating for intimate
    intimate_allowed = True
    if mode == "intimate" or wants_explicit:
        if _should_block_intimate(session_state_in):
            intimate_allowed = False

    # If blocked, force safe output mode but keep UI pending consent flags in session_state
    session_state_out = dict(session_state_in)
    if not intimate_allowed:
        session_state_out["pending_consent"] = "intimate"
        session_state_out["mode"] = "intimate"
        status = STATUS_BLOCKED
    else:
        session_state_out["pending_consent"] = None
        session_state_out["mode"] = mode
        status = STATUS_ALLOWED if mode == "intimate" else STATUS_SAFE

    # Companion identity
    companion = _get_companion_identity(session_state_out)
    session_state_out["companion"] = companion
    session_state_out["companionName"] = companion
    session_state_out["companion_name"] = companion

    # Build prompt
    model = session_state_out.get("model") or "gpt-4o"
    system_prompt = _build_system_prompt(companion=companion, mode=mode)

    messages_for_model: List[Dict[str, str]] = [{"role": "system", "content": system_prompt}]
    for m in messages_in:
        role = (m.get("role") or "").strip()
        content = (m.get("content") or "")
        if role in ("user", "assistant"):
            messages_for_model.append({"role": role, "content": content})

    # If blocked, override assistant reply to consent prompt (your UI also handles overlay)
    if status == STATUS_BLOCKED:
        assistant_reply = (
            "Before we continue, please confirm you are 18+ and consent to Intimate (18+) conversation. "
            "Reply 'yes' to continue."
        )
        return ChatResponse(
            session_id=session_id,
            mode=STATUS_BLOCKED,
            reply=assistant_reply,
            session_state=session_state_out,
        )

    # Otherwise call the model
    try:
        assistant_reply = _call_openai_like_model(messages=messages_for_model, model=model)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"chat completion error: {e}")

    return ChatResponse(
        session_id=session_id,
        mode=status,
        reply=assistant_reply,
        session_state=session_state_out,
    )


# -------------------- TTS (ElevenLabs -> Azure Blob SAS URL) --------------------
# This endpoint generates an MP3 with ElevenLabs, uploads it to Azure Blob Storage,
# then returns a short-lived SAS URL so D-ID can fetch the audio server-to-server.

_TTS_CONTAINER = os.getenv("AZURE_TTS_CONTAINER", "tts")
_TTS_BLOB_PREFIX = os.getenv("TTS_BLOB_PREFIX", "audio")
_TTS_SAS_MINUTES = int(os.getenv("TTS_SAS_MINUTES", "30"))

_blob_service_client = None
_storage_account_name = None
_storage_account_key = None


def _parse_storage_connection_string(conn_str: str) -> Tuple[str, str]:
    """
    Parse AccountName and AccountKey from a classic Azure Storage connection string.
    """
    parts = {}
    for seg in conn_str.split(";"):
        if "=" in seg:
            k, v = seg.split("=", 1)
            parts[k.strip()] = v.strip()

    acct = parts.get("AccountName") or ""
    key = parts.get("AccountKey") or ""
    if not acct or not key:
        raise RuntimeError("Could not parse AccountName/AccountKey from AZURE_STORAGE_CONNECTION_STRING")
    return acct, key


def _get_blob_service_client() -> "Any":
    global _blob_service_client, _storage_account_name, _storage_account_key

    if _blob_service_client is not None:
        return _blob_service_client

    conn_str = os.getenv("AZURE_STORAGE_CONNECTION_STRING", "")
    if not conn_str:
        raise RuntimeError("AZURE_STORAGE_CONNECTION_STRING is not configured")

    if BlobServiceClient is None:
        raise RuntimeError("azure-storage-blob is not installed (add it to requirements.txt)")

    _storage_account_name, _storage_account_key = _parse_storage_connection_string(conn_str)
    _blob_service_client = BlobServiceClient.from_connection_string(conn_str)
    return _blob_service_client


def _elevenlabs_tts_mp3(text: str, voice_id: str) -> bytes:
    api_key = os.getenv("ELEVENLABS_API_KEY", "")
    if not api_key:
        raise RuntimeError("ELEVENLABS_API_KEY is not configured")

    model_id = os.getenv("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2")
    output_format = os.getenv("ELEVENLABS_OUTPUT_FORMAT", "mp3_44100_128")

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format={output_format}"
    headers = {"xi-api-key": api_key, "Content-Type": "application/json"}
    payload = {"text": text, "model_id": model_id}

    r = requests.post(url, headers=headers, json=payload, timeout=60)
    if not r.ok:
        raise RuntimeError(f"ElevenLabs error {r.status_code}: {r.text}")

    return r.content


@app.post("/tts/audio-url")
async def tts_audio_url(req: Request) -> Dict[str, Any]:
    """
    Request JSON:
      {
        "session_id": "...",
        "voice_id": "ElevenLabsVoiceId",
        "text": "..."
      }

    Response JSON:
      { "audio_url": "https://<account>.blob.core.windows.net/<container>/<blob>?<sas>" }
    """
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    session_id = str(body.get("session_id") or "").strip()
    voice_id = str(body.get("voice_id") or "").strip()
    text = str(body.get("text") or "").strip()

    if not session_id:
        raise HTTPException(status_code=422, detail="session_id required")
    if not voice_id:
        raise HTTPException(status_code=422, detail="voice_id required")
    if not text:
        raise HTTPException(status_code=422, detail="text required")

    # Generate MP3
    try:
        audio_bytes = _elevenlabs_tts_mp3(text=text, voice_id=voice_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # Upload to Azure Blob
    try:
        blob_service = _get_blob_service_client()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    container_client = blob_service.get_container_client(_TTS_CONTAINER)
    try:
        container_client.create_container()
    except Exception:
        pass  # already exists

    safe_prefix = (_TTS_BLOB_PREFIX or "").strip().strip("/")
    file_name = f"{uuid.uuid4().hex}.mp3"
    blob_name = f"{safe_prefix}/{file_name}" if safe_prefix else file_name

    blob_client = container_client.get_blob_client(blob_name)

    if ContentSettings is None:
        raise HTTPException(status_code=500, detail="azure-storage-blob ContentSettings is unavailable")

    blob_client.upload_blob(
        audio_bytes,
        overwrite=True,
        content_settings=ContentSettings(content_type="audio/mpeg"),
    )

    # Create a short-lived SAS URL for read access
    if generate_blob_sas is None or BlobSasPermissions is None:
        raise HTTPException(status_code=500, detail="azure-storage-blob SAS helpers are unavailable")

    expiry = datetime.now(timezone.utc) + timedelta(minutes=max(5, min(_TTS_SAS_MINUTES, 24 * 60)))

    sas = generate_blob_sas(
        account_name=_storage_account_name or blob_client.account_name,
        container_name=_TTS_CONTAINER,
        blob_name=blob_name,
        account_key=_storage_account_key,
        permission=BlobSasPermissions(read=True),
        expiry=expiry,
    )

    audio_url = f"{blob_client.url}?{sas}"
    return {"audio_url": audio_url, "blob": blob_name}
