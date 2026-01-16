from __future__ import annotations

import os
import time
import re
import uuid
import hashlib
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

# Threadpool helper (prevents blocking the event loop on requests/azure upload)
from starlette.concurrency import run_in_threadpool  # type: ignore

from .settings import settings
from .models import ChatResponse  # kept for compatibility with existing codebase


# ----------------------------
# Optional consent router
# ----------------------------
try:
    from .consent_routes import router as consent_router  # type: ignore
except Exception:
    consent_router = None


STATUS_SAFE = "safe"
STATUS_BLOCKED = "explicit_blocked"
STATUS_ALLOWED = "explicit_allowed"


# ---------------------------------------------------------------------------
# Saved chat summaries ("memory")
# ---------------------------------------------------------------------------

# In-memory cache to reduce blob reads. Keyed by f"{user_key}::{companion_slug}"
_MEMORY_CACHE: dict[str, tuple[float, str]] = {}

# Cache TTL in seconds (default 5 minutes)
_MEMORY_CACHE_TTL_S = int(os.getenv("MEMORY_CACHE_TTL_S", "300"))

def _slugify(val: str) -> str:
    val = (val or "").strip().lower()
    if not val:
        return "unknown"
    val = re.sub(r"[^a-z0-9]+", "-", val)
    val = val.strip("-")
    return val or "unknown"

def _memory_blob_name(user_key: str, companion: str) -> str:
    # Store JSON in the same container we already have access to (TTS container).
    # Keeping a stable path makes it easy to recall per-user, per-companion.
    return f"memory/{_slugify(user_key)}/{_slugify(companion)}/summary.json"

def _memory_cache_key(user_key: str, companion: str) -> str:
    return f"{user_key}::{_slugify(companion)}"

def _get_memory_from_cache(user_key: str, companion: str) -> str | None:
    k = _memory_cache_key(user_key, companion)
    item = _MEMORY_CACHE.get(k)
    if not item:
        return None
    ts, summary = item
    if (time.time() - ts) > _MEMORY_CACHE_TTL_S:
        _MEMORY_CACHE.pop(k, None)
        return None
    return summary

def _set_memory_cache(user_key: str, companion: str, summary: str) -> None:
    k = _memory_cache_key(user_key, companion)
    _MEMORY_CACHE[k] = (time.time(), summary)

def _azure_put_memory_json(blob_name: str, data: dict[str, Any]) -> None:
    """Store summary JSON in Azure Blob Storage.

    Uses the existing AZURE_STORAGE_CONNECTION_STRING + TTS_CONTAINER settings.
    """
    try:
        from azure.storage.blob import BlobServiceClient, ContentSettings  # type: ignore
    except Exception as e:
        raise RuntimeError(f"azure-storage-blob missing: {e}")

    conn = getattr(settings, "AZURE_STORAGE_CONNECTION_STRING", None) or os.getenv(
        "AZURE_STORAGE_CONNECTION_STRING", ""
    )
    if not conn:
        raise RuntimeError("AZURE_STORAGE_CONNECTION_STRING is not set")

    container = getattr(settings, "TTS_CONTAINER", None) or os.getenv("TTS_CONTAINER", "tts")
    svc = BlobServiceClient.from_connection_string(conn)
    blob_client = svc.get_blob_client(container=container, blob=blob_name)
    payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
    blob_client.upload_blob(
        payload,
        overwrite=True,
        content_settings=ContentSettings(content_type="application/json; charset=utf-8"),
    )

def _azure_get_memory_json(blob_name: str) -> dict[str, Any] | None:
    try:
        from azure.storage.blob import BlobServiceClient  # type: ignore
    except Exception:
        # If azure blob isn't installed, just treat as missing
        return None

    conn = getattr(settings, "AZURE_STORAGE_CONNECTION_STRING", None) or os.getenv(
        "AZURE_STORAGE_CONNECTION_STRING", ""
    )
    if not conn:
        return None

    container = getattr(settings, "TTS_CONTAINER", None) or os.getenv("TTS_CONTAINER", "tts")
    svc = BlobServiceClient.from_connection_string(conn)
    blob_client = svc.get_blob_client(container=container, blob=blob_name)
    try:
        stream = blob_client.download_blob()
        raw = stream.readall()
        return json.loads(raw)
    except Exception:
        return None

app = FastAPI(title="AIHaven4U API")

# ----------------------------
# CORS
# ----------------------------
# CORS_ALLOW_ORIGINS can be:
#   - comma-separated list of exact origins (e.g. https://aihaven4u.com,https://www.aihaven4u.com)
#   - entries with wildcards (e.g. https://*.azurestaticapps.net)
#   - or a single "*" to allow all (NOT recommended for production)
cors_env = (
    os.getenv("CORS_ALLOW_ORIGINS", "")
    or getattr(settings, "CORS_ALLOW_ORIGINS", None)
    or ""
).strip()

def _split_cors_origins(raw: str) -> list[str]:
    """Split + normalize CORS origins from an env var.

    Supports comma and/or whitespace separation.
    Removes trailing slashes (browser Origin never includes a trailing slash).
    De-dupes while preserving order.
    """
    if not raw:
        return []
    tokens = re.split(r"[\s,]+", raw.strip())
    out: list[str] = []
    seen: set[str] = set()
    for t in tokens:
        if not t:
            continue
        t = t.strip()
        if not t:
            continue
        if t != "*" and t.endswith("/"):
            t = t.rstrip("/")
        if t not in seen:
            out.append(t)
            seen.add(t)
    return out

raw_items = _split_cors_origins(cors_env)
allow_all = (len(raw_items) == 1 and raw_items[0] == "*")

allow_origins: list[str] = []
allow_origin_regex: str | None = None
allow_credentials = True

if allow_all:
    # Allow-all is only enabled when explicitly configured via "*".
    allow_origins = ["*"]
    allow_credentials = False  # cannot be True with wildcard
else:
    # Support optional wildcards (e.g., "https://*.azurestaticapps.net").
    literal: list[str] = []
    wildcard: list[str] = []
    for o in raw_items:
        if "*" in o:
            wildcard.append(o)
        else:
            literal.append(o)

    allow_origins = literal

    if wildcard:
        # Convert wildcard origins to a regex.
        parts: list[str] = []
        for w in wildcard:
            parts.append("^" + re.escape(w).replace("\\*", ".*") + "$")
        allow_origin_regex = "|".join(parts)

    # Security-first default: if CORS_ALLOW_ORIGINS is empty, we do NOT allow browser cross-origin calls.
    # (Server-to-server calls without an Origin header still work.)
    if not allow_origins and not allow_origin_regex:
        print("[CORS] WARNING: CORS_ALLOW_ORIGINS is empty. Browser requests from other origins will be blocked.")

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_origin_regex=allow_origin_regex,
    allow_credentials=allow_credentials,
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
# Helpers
# ----------------------------
def _dbg(enabled: bool, *args: Any) -> None:
    if enabled:
        print(*args)


def _now_ts() -> int:
    return int(time.time())


def _normalize_mode(raw: str) -> str:
    t = (raw or "").strip().lower()
    # allow some synonyms from older frontend builds
    if t in {"explicit", "intimate", "18+", "adult"}:
        return "intimate"
    if t in {"romance", "romantic"}:
        return "romantic"
    return "friend"


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
    if any(p in t for p in [
        "switch to friend",
        "go to friend",
        "back to friend",
        "friend mode",
        "set friend",
        "set mode to friend",
        "turn on friend",
    ]):
        return "friend"

    # romantic
    if any(p in t for p in [
        "switch to romantic",
        "go to romantic",
        "back to romantic",
        "romantic mode",
        "set romantic",
        "set mode to romantic",
        "turn on romantic",
        "let's be romantic",
    ]):
        return "romantic"

    # intimate/explicit
    if any(p in t for p in [
        "switch to intimate",
        "go to intimate",
        "back to intimate",
        "intimate mode",
        "set intimate",
        "set mode to intimate",
        "turn on intimate",
        "switch to explicit",
        "explicit mode",
        "set explicit",
        "set mode to explicit",
        "turn on explicit",
    ]):
        return "intimate"

    return None


def _looks_intimate(text: str) -> bool:
    t = (text or "").lower()
    return any(
        k in t
        for k in [
            "explicit", "intimate", "nsfw", "sex", "nude", "porn",
            "fuck", "cock", "pussy", "blowjob", "anal", "orgasm",
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


def _to_openai_messages(
    messages: List[Dict[str, str]],
    session_state: dict,
    *,
    mode: str,
    intimate_allowed: bool,
    debug: bool,
    memory_summary: str | None = None,
):
    sys = _build_persona_system_prompt(session_state, mode=mode, intimate_allowed=intimate_allowed)

    if memory_summary:
        sys += "\n\n[SAVED CHAT SUMMARY]\n" + memory_summary + "\n[/SAVED CHAT SUMMARY]\n"
    _dbg(debug, "SYSTEM PROMPT:", sys)

    out = [{"role": "system", "content": sys}]
    for m in messages:
        if m.get("role") in ("user", "assistant"):
            out.append({"role": m["role"], "content": m.get("content", "")})
    return out


def _call_gpt4o(messages: List[Dict[str, str]], *, temperature: float | None = None) -> str:
    from openai import OpenAI

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")

    client = OpenAI(api_key=api_key)
    temp = float(os.getenv("OPENAI_TEMPERATURE", "0.8")) if temperature is None else float(temperature)
    resp = client.chat.completions.create(
        model=os.getenv("OPENAI_MODEL", "gpt-4o"),
        messages=messages,
        temperature=temp,
    )
    return (resp.choices[0].message.content or "").strip()


def _normalize_payload(raw: Dict[str, Any]) -> Tuple[str, List[Dict[str, str]], Dict[str, Any], bool]:
    sid = raw.get("session_id") or raw.get("sid")
    msgs = raw.get("messages") or []
    state = raw.get("session_state") or {}
    wants = bool(raw.get("wants_explicit"))

    if not sid or not isinstance(sid, str):
        raise HTTPException(422, "session_id required")
    if not msgs or not isinstance(msgs, list):
        raise HTTPException(422, "messages required")
    if not isinstance(state, dict):
        state = {}

    return sid, msgs, state, wants


def _extract_voice_id(raw: Dict[str, Any]) -> str:
    """
    Supports both snake_case and camelCase for frontend convenience.
    """
    return (
        (raw.get("voice_id") or raw.get("voiceId") or raw.get("eleven_voice_id") or raw.get("elevenVoiceId") or "")
    ).strip()


def _summarize_chat_for_memory(
    *,
    companion: str,
    relationship_mode: str | None,
    messages: List[Dict[str, str]],
) -> str:
    """Create a short 'memory' summary for future conversations.

    This is called only when the user explicitly presses the Save button.
    """

    comp = (companion or "Assistant").strip() or "Assistant"
    rel = (relationship_mode or "").strip()

    # Keep only the last N turns to stay under token limits
    trimmed = [m for m in messages if isinstance(m, dict) and m.get("role") in ("user", "assistant")]
    trimmed = trimmed[-40:]

    # Flatten into a compact transcript string
    lines: list[str] = []
    for m in trimmed:
        role = m.get("role")
        text = m.get("content")
        if not isinstance(text, str):
            continue
        t = text.strip()
        if not t:
            continue
        who = "User" if role == "user" else comp
        # Avoid super-long single entries
        if len(t) > 2000:
            t = t[:2000] + "…"
        lines.append(f"{who}: {t}")

    transcript = "\n".join(lines)

    sys = (
        "You write a concise memory summary of a chat between a user and an AI companion.\n"
        "Goal: help the companion personalize future conversations.\n"
        "Rules:\n"
        "- Keep it short (<= 900 characters)\n"
        "- 1 short paragraph + up to 6 bullet points\n"
        "- Capture stable user facts (preferences, goals, boundaries) and emotional tone\n"
        "- Do NOT include private identifiers (emails, phone numbers, addresses, full names) even if present\n"
        "- Do NOT include explicit content; keep it safe and general\n"
    )

    user_prompt = (
        f"Companion name: {comp}\n"
        + (f"Relationship mode: {rel}\n" if rel else "")
        + "\nConversation (most recent last):\n"
        + transcript
        + "\n\nWrite the memory summary now."
    )

    summary = _call_gpt4o(
        [
            {"role": "system", "content": sys},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.2,
    )
    return summary.strip()


# ----------------------------
# TTS Helpers (ElevenLabs -> Azure Blob SAS)
# ----------------------------
_TTS_CONTAINER = os.getenv("AZURE_TTS_CONTAINER", os.getenv("AZURE_STORAGE_CONTAINER", "tts")) or "tts"
_TTS_BLOB_PREFIX = os.getenv("TTS_BLOB_PREFIX", "audio") or "audio"
_TTS_SAS_MINUTES = int(os.getenv("TTS_SAS_MINUTES", os.getenv("AZURE_BLOB_SAS_EXPIRY_MINUTES", "30")) or "30")


def _tts_blob_name(session_id: str, voice_id: str, text: str) -> str:
    safe_session = re.sub(r"[^A-Za-z0-9_-]", "_", (session_id or "session"))[:64]
    safe_voice = re.sub(r"[^A-Za-z0-9_-]", "_", (voice_id or "voice"))[:48]
    h = hashlib.sha1((safe_voice + "|" + (text or "")).encode("utf-8")).hexdigest()[:16]
    ts_ms = int(time.time() * 1000)
    # include hash for debugging/caching, but still unique by timestamp
    return f"{_TTS_BLOB_PREFIX}/{safe_session}/{ts_ms}-{h}-{uuid.uuid4().hex}.mp3"


def _elevenlabs_tts_mp3_bytes(voice_id: str, text: str) -> bytes:
    import requests  # type: ignore

    xi_api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not xi_api_key:
        raise RuntimeError("ELEVENLABS_API_KEY is not configured")

    model_id = os.getenv("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2").strip() or "eleven_multilingual_v2"
    output_format = os.getenv("ELEVENLABS_OUTPUT_FORMAT", "mp3_44100_128").strip() or "mp3_44100_128"

    # Using /stream tends to be lower latency on ElevenLabs.
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream?output_format={output_format}"
    headers = {
        "xi-api-key": xi_api_key,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
    }
    body = {"text": text, "model_id": model_id}

    r = requests.post(url, headers=headers, json=body, timeout=60)
    if r.status_code >= 400:
        raise RuntimeError(f"ElevenLabs error {r.status_code}: {(r.text or '')[:400]}")
    if not r.content:
        raise RuntimeError("ElevenLabs returned empty audio")
    return r.content


def _azure_upload_mp3_and_get_sas_url(blob_name: str, mp3_bytes: bytes) -> str:
    from azure.storage.blob import BlobServiceClient, ContentSettings  # type: ignore
    from azure.storage.blob import BlobSasPermissions, generate_blob_sas  # type: ignore

    storage_conn_str = os.getenv("AZURE_STORAGE_CONNECTION_STRING", "").strip()
    if not storage_conn_str:
        raise RuntimeError("AZURE_STORAGE_CONNECTION_STRING is not configured")

    blob_service = BlobServiceClient.from_connection_string(storage_conn_str)
    container_client = blob_service.get_container_client(_TTS_CONTAINER)

    # Ensure container exists (safe)
    try:
        container_client.get_container_properties()
    except Exception:
        try:
            container_client.create_container()
        except Exception:
            pass

    blob_client = container_client.get_blob_client(blob_name)
    blob_client.upload_blob(
        mp3_bytes,
        overwrite=True,
        content_settings=ContentSettings(content_type="audio/mpeg"),
    )

    # Parse AccountName/AccountKey from connection string for SAS
    parts: Dict[str, str] = {}
    for seg in storage_conn_str.split(";"):
        if "=" in seg:
            k, v = seg.split("=", 1)
            parts[k] = v
    account_name = parts.get("AccountName") or getattr(blob_service, "account_name", None)
    account_key = parts.get("AccountKey")
    if not account_name or not account_key:
        raise RuntimeError("Could not parse AccountName/AccountKey from AZURE_STORAGE_CONNECTION_STRING")

    expiry = datetime.utcnow() + timedelta(minutes=max(5, min(_TTS_SAS_MINUTES, 24 * 60)))
    sas = generate_blob_sas(
        account_name=account_name,
        container_name=_TTS_CONTAINER,
        blob_name=blob_name,
        account_key=account_key,
        permission=BlobSasPermissions(read=True),
        expiry=expiry,
    )
    return f"{blob_client.url}?{sas}"


def _tts_audio_url_sync(session_id: str, voice_id: str, text: str) -> str:
    text = (text or "").strip()
    if not text:
        raise RuntimeError("TTS text is empty")
    blob_name = _tts_blob_name(session_id=session_id, voice_id=voice_id, text=text)
    mp3_bytes = _elevenlabs_tts_mp3_bytes(voice_id=voice_id, text=text)
    return _azure_upload_mp3_and_get_sas_url(blob_name=blob_name, mp3_bytes=mp3_bytes)


# ----------------------------
# CHAT (Optimized: optional audio_url in same response)
# ----------------------------
@app.post("/chat", response_model=None)
async def chat(request: Request):
    """
    Backward-compatible /chat endpoint.

    Optimization:
      If the request includes `voice_id` (or `voiceId`), the API will ALSO generate
      an ElevenLabs MP3, upload it to Azure Blob, and return `audio_url` in the same
      /chat response — avoiding a second round-trip to /tts/audio-url.

    Request (existing fields):
      { session_id, messages, session_state, wants_explicit }

    Additional optional fields:
      { voice_id: "<elevenlabs_voice_id>" }   or  { voiceId: "<...>" }
    """
    debug = bool(getattr(settings, "DEBUG", False))

    raw = await request.json()
    session_id, messages, session_state, wants_explicit = _normalize_payload(raw)
    voice_id = _extract_voice_id(raw)

    # Helper to build responses consistently and optionally include audio_url.
    async def _respond(reply: str, status_mode: str, state_out: Dict[str, Any]) -> Dict[str, Any]:
        audio_url: Optional[str] = None
        if voice_id and (reply or "").strip():
            try:
                audio_url = await run_in_threadpool(_tts_audio_url_sync, session_id, voice_id, reply)
            except Exception as e:
                # Fail-open: never break chat because TTS failed
                _dbg(debug, "TTS generation failed:", repr(e))
                state_out = dict(state_out)
                state_out["tts_error"] = f"{type(e).__name__}: {e}"

        return {
            "session_id": session_id,
            "mode": status_mode,          # safe/explicit_blocked/explicit_allowed
            "reply": reply,
            "session_state": state_out,
            "audio_url": audio_url,       # NEW (optional)
        }

    # last user message
    last_user = next((m for m in reversed(messages) if m.get("role") == "user"), None)
    user_text = ((last_user.get("content") if last_user else "") or "").strip()
    normalized_text = user_text.lower().strip()

    # allow text-based mode switching
    detected_switch = _detect_mode_switch_from_text(user_text)
    if detected_switch:
        session_state["mode"] = detected_switch

    requested_mode = _normalize_mode(str(session_state.get("mode") or "friend"))
    requested_intimate = (requested_mode == "intimate")

    # authoritative consent flag should live in session_state (works across gunicorn workers)
    intimate_allowed = bool(session_state.get("explicit_consented") is True)

    # if user is requesting intimate OR the UI is in intimate mode, treat as intimate request
    user_requesting_intimate = wants_explicit or requested_intimate or _looks_intimate(user_text)

    # consent keywords
    CONSENT_YES = {
        "yes", "y", "yeah", "yep", "sure", "ok", "okay",
        "i consent", "i agree", "i confirm", "confirm",
        "i am 18+", "i'm 18+", "i am over 18", "i'm over 18",
        "i confirm i am 18+", "i confirm that i am 18+",
        "i confirm and consent",
    }
    CONSENT_NO = {"no", "n", "nope", "nah", "decline", "cancel"}

    pending = (session_state.get("pending_consent") or "")
    pending = pending.strip().lower() if isinstance(pending, str) else ""

    def _grant_intimate(state_in: Dict[str, Any]) -> Dict[str, Any]:
        out = dict(state_in)
        out["adult_verified"] = True
        out["explicit_consented"] = True
        out["pending_consent"] = None
        out["mode"] = "intimate"
        out["explicit_granted_at"] = _now_ts()
        return out

    # If we are waiting on consent, only accept yes/no
    if pending == "intimate" and not intimate_allowed:
        if normalized_text in CONSENT_YES:
            session_state_out = _grant_intimate(session_state)
            return await _respond(
                "Thank you — Intimate (18+) mode is enabled. What would you like to explore together?",
                STATUS_ALLOWED,
                session_state_out,
            )

        if normalized_text in CONSENT_NO:
            session_state_out = dict(session_state)
            session_state_out["pending_consent"] = None
            session_state_out["explicit_consented"] = False
            session_state_out["mode"] = "friend"
            return await _respond(
                "No problem — we’ll keep things in Friend mode.",
                STATUS_SAFE,
                session_state_out,
            )

        # still pending; remind
        session_state_out = dict(session_state)
        session_state_out["pending_consent"] = "intimate"
        session_state_out["mode"] = "intimate"  # keep pill highlighted
        return await _respond(
            "Please reply with 'yes' or 'no' to continue.",
            STATUS_BLOCKED,
            session_state_out,
        )

    # Start consent if intimate requested but not allowed
    require_consent = bool(getattr(settings, "REQUIRE_EXPLICIT_CONSENT_FOR_EXPLICIT_CONTENT", True))
    if require_consent and user_requesting_intimate and not intimate_allowed:
        session_state_out = dict(session_state)
        session_state_out["pending_consent"] = "intimate"
        session_state_out["mode"] = "intimate"
        return await _respond(
            "Before we continue, please confirm you are 18+ and consent to Intimate (18+) conversation. Reply 'yes' to continue.",
            STATUS_BLOCKED,
            session_state_out,
        )

    # Effective mode for the model (never intimate unless allowed)
    effective_mode = requested_mode
    if effective_mode == "intimate" and not intimate_allowed:
        effective_mode = "friend"

    _dbg(
        debug,
        f"/chat session={session_id} requested_mode={requested_mode} effective_mode={effective_mode} "
        f"user_requesting_intimate={user_requesting_intimate} intimate_allowed={intimate_allowed} pending={pending} voice_id={'yes' if voice_id else 'no'}",
    )

    # Load saved summary (memory) for this user+companion, if available.
    user_key = (
        str(raw.get("user_key") or raw.get("user_id") or raw.get("member_id") or raw.get("wix_user_id") or "").strip()
        or session_id
    )
    companion_for_memory = (
        str(
            session_state.get("companion")
            or session_state.get("companionName")
            or session_state.get("companion_name")
            or ""
        ).strip()
    )
    memory_summary = None
    if companion_for_memory:
        memory_summary = _memory_load_summary(user_key, companion_for_memory)
        if memory_summary:
            _dbg(debug, f"Loaded saved summary for {companion_for_memory} ({len(memory_summary)} chars)")

    # call model
    try:
        assistant_reply = _call_gpt4o(
            _to_openai_messages(
                messages,
                session_state,
                mode=effective_mode,
                intimate_allowed=intimate_allowed,
                debug=debug,
                memory_summary=memory_summary,
            )
        )
    except Exception as e:
        _dbg(debug, "OpenAI call failed:", repr(e))
        raise HTTPException(status_code=500, detail=f"OpenAI call failed: {type(e).__name__}: {e}")

    # echo back session_state (ensure correct mode)
    session_state_out = dict(session_state)
    session_state_out["mode"] = effective_mode
    session_state_out["pending_consent"] = None if intimate_allowed else session_state_out.get("pending_consent")
    session_state_out["companion_meta"] = _parse_companion_meta(
        session_state_out.get("companion")
        or session_state_out.get("companionName")
        or session_state_out.get("companion_name")
    )

    return await _respond(
        assistant_reply,
        STATUS_ALLOWED if intimate_allowed else STATUS_SAFE,
        session_state_out,
    )


# ----------------------------
# BACKWARD-COMPAT TTS ENDPOINT (still supported)
# ----------------------------
@app.post("/tts/audio-url")
async def tts_audio_url(request: Request) -> Dict[str, Any]:
    """
    Backward compatible endpoint.

    Request JSON:
      {
        "session_id": "...",
        "voice_id": "<ElevenLabsVoiceId>",
        "text": "..."
      }

    Response JSON:
      { "audio_url": "https://...sas..." }
    """
    try:
        body = await request.json()
    except Exception:
        body = {}

    session_id = (body.get("session_id") or body.get("sid") or "").strip()
    if not session_id:
        raise HTTPException(status_code=422, detail="session_id required")

    voice_id = ((body.get("voice_id") or body.get("voiceId") or "")).strip()
    text = (body.get("text") or "").strip()

    if not voice_id or not text:
        raise HTTPException(status_code=422, detail="voice_id and text are required")

    try:
        audio_url = await run_in_threadpool(_tts_audio_url_sync, session_id, voice_id, text)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"TTS failed: {type(e).__name__}: {e}")

    return {"audio_url": audio_url}


# --------------------------
# STT (Speech-to-Text)
# --------------------------
# NOTE: This endpoint intentionally accepts RAW audio bytes in the request body (not multipart/form-data)
# to avoid requiring the `python-multipart` package (which can otherwise prevent FastAPI from starting).
#
# Frontend should POST the recorded Blob directly:
#   fetch(`${API_BASE}/stt/transcribe`, { method:"POST", headers:{ "Content-Type": blob.type }, body: blob })
#
@app.post("/stt/transcribe")
async def stt_transcribe(request: Request):
    if not settings.OPENAI_API_KEY:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not configured")

    content_type = (request.headers.get("content-type") or "").lower().strip()
    audio_bytes = await request.body()

    if not audio_bytes or len(audio_bytes) < 16:
        raise HTTPException(status_code=400, detail="No audio received")

    # Infer file extension for OpenAI transcription.
    if "webm" in content_type:
        ext = "webm"
    elif "ogg" in content_type:
        ext = "ogg"
    elif "mp4" in content_type or "m4a" in content_type or "aac" in content_type:
        ext = "mp4"
    elif "wav" in content_type:
        ext = "wav"
    else:
        # Fallback; OpenAI can often still detect format, but providing a filename helps.
        ext = "bin"

    bio = io.BytesIO(audio_bytes)
    bio.name = f"stt.{ext}"

    try:
        # Use the same OpenAI client used elsewhere in this service.
        # `settings.STT_MODEL` can be set; fallback is whisper-1.
        stt_model = getattr(settings, "STT_MODEL", None) or "whisper-1"
        resp = client.audio.transcriptions.create(
            model=stt_model,
            file=bio,
        )
        text = getattr(resp, "text", None)
        if text is None and isinstance(resp, dict):
            text = resp.get("text")
        if not text:
            text = ""
        return {"text": str(text).strip()}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"STT transcription failed: {e}")


# --------------------------
# Memory (Saved chat summaries)
# --------------------------

@app.post("/memory/save")
async def memory_save(request: Request):
    """Save a condensed summary of the current chat for future personalization.

    This is keyed by:
      - user_key (preferred) OR
      - session_id (fallback)
    plus the selected companion.

    The frontend may omit user_key; in that case memory is scoped to the browser session_id.
    """
    raw = await request.json()

    session_id = str(raw.get("session_id") or raw.get("sessionId") or "").strip()
    user_key = str(
        raw.get("user_key") or raw.get("userKey") or raw.get("user_id") or raw.get("userId") or session_id
    ).strip()
    companion = str(raw.get("companion") or raw.get("companionName") or "").strip()
    relationship_mode = str(raw.get("relationship_mode") or raw.get("relationship") or "").strip() or None
    messages = raw.get("messages") or []

    if not user_key:
        raise HTTPException(status_code=400, detail="user_key (or session_id) is required")
    if not companion:
        raise HTTPException(status_code=400, detail="companion is required")
    if not isinstance(messages, list):
        raise HTTPException(status_code=400, detail="messages must be a list")

    # Sanitize / trim messages
    safe_messages: List[Dict[str, str]] = []
    for m in messages[-60:]:
        if not isinstance(m, dict):
            continue
        role = str(m.get("role") or "").strip()
        content = m.get("content")
        if role not in ("user", "assistant"):
            continue
        if not isinstance(content, str):
            continue
        c = content.strip()
        if not c:
            continue
        safe_messages.append({"role": role, "content": c})

    if not safe_messages:
        raise HTTPException(status_code=400, detail="No valid messages to summarize")

    summary = _summarize_chat_for_memory(companion=companion, relationship_mode=relationship_mode, messages=safe_messages)
    meta = {
        "session_id": session_id,
        "companion": companion,
        "relationship_mode": relationship_mode,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }

    ok = _memory_save_summary(user_key=user_key, companion=companion, summary=summary, meta=meta)
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to persist summary")

    return {"ok": True, "user_key": user_key, "companion": companion, "summary": summary}


@app.get("/memory/get")
async def memory_get(session_id: str, companion: str, user_key: str | None = None):
    key = (user_key or session_id or "").strip()
    comp = (companion or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="session_id or user_key is required")
    if not comp:
        raise HTTPException(status_code=400, detail="companion is required")

    summary = _memory_load_summary(user_key=key, companion=comp)
    return {"ok": True, "user_key": key, "companion": comp, "summary": summary}

