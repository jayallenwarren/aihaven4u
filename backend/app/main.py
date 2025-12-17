from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from .settings import settings
from .models import ChatRequest, ChatResponse
from .consent_store import consent_store
from .consent_routes import router as consent_router

# Disable automatic trailing-slash redirects to avoid preflight redirect issues.
app = FastAPI(title="AIHaven4U API", redirect_slashes=False)

# -----------------------------
# CORS
# -----------------------------
# CORS_ALLOW_ORIGINS should be a comma-separated list of exact origins, e.g.:
# https://aihaven4u.com,https://www.aihaven4u.com,https://yellow-hill-0a40ae30f.3.azurestaticapps.net,http://localhost:3000
#
# IMPORTANT:
# - Browsers reject allow_origins=["*"] when allow_credentials=True.
# - So we only allow "*" when allow_credentials is False.
cors_value = (settings.CORS_ALLOW_ORIGINS or "").strip()
allow_all = cors_value == "*"

raw_origins = [o.strip() for o in cors_value.split(",") if o.strip()]

if allow_all:
    allow_origins = ["*"]
    allow_credentials = False
else:
    allow_origins = raw_origins
    allow_credentials = True

if not allow_all and not allow_origins:
    print(
        "WARNING: CORS_ALLOW_ORIGINS is empty. "
        "Set it to a comma-separated list of allowed origins."
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------------
# Routes
# -----------------------------
app.include_router(consent_router)


@app.get("/health")
def health():
    return {"ok": True}


# Explicit preflight handler (helps if anything upstream misroutes OPTIONS).
# CORSMiddleware will still attach the proper Access-Control-* headers.
@app.options("/chat")
async def chat_preflight() -> Response:
    return Response(status_code=204)


def _looks_explicit(text: str) -> bool:
    """
    Minimal heuristic.
    Replace this with your real classifier/moderation later.
    """
    t = (text or "").lower()
    keywords = ["explicit", "nude", "sex", "porn", "dirty", "fuck", "cock", "pussy"]
    return any(k in t for k in keywords)


@app.post("/chat", response_model=ChatResponse)
async def chat(payload: ChatRequest, request: Request):
    if not payload.messages:
        raise HTTPException(status_code=400, detail="messages cannot be empty")

    last_user = next((m for m in reversed(payload.messages) if m.role == "user"), None)
    user_text = last_user.content if last_user else ""
    user_requesting_explicit = bool(payload.wants_explicit) or _looks_explicit(user_text)

    rec = consent_store.get(payload.session_id)
    explicit_allowed = bool(rec and rec.explicit_allowed)

    if (
        settings.REQUIRE_EXPLICIT_CONSENT_FOR_EXPLICIT_CONTENT
        and user_requesting_explicit
        and not explicit_allowed
    ):
        return ChatResponse(
            session_id=payload.session_id,
            mode="explicit_blocked",
            reply=(
                "Before we go further, I need to confirm you’re 18+ and that you want explicit adult conversation. "
                "Please use the consent flow to opt in (double 18+ confirmation + explicit intent)."
            ),
        )

    if user_requesting_explicit and explicit_allowed:
        return ChatResponse(
            session_id=payload.session_id,
            mode="explicit_allowed",
            reply="(Explicit mode allowed by server gate.) What would you like to talk about?",
        )

    return ChatResponse(
        session_id=payload.session_id,
        mode="safe",
        reply=f"You said: {user_text}",
    )


@app.get("/debug/cors")
def debug_cors():
    cors_value = (settings.CORS_ALLOW_ORIGINS or "").strip()
    raw_origins = [o.strip() for o in cors_value.split(",") if o.strip()]
    return {
        "CORS_ALLOW_ORIGINS_raw": cors_value,
        "parsed_origins": raw_origins,
    }
