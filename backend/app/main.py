from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from .settings import settings
from .models import ChatRequest, ChatResponse
from .consent_store import consent_store
from .consent_routes import router as consent_router

app = FastAPI(title="AIHaven4U API")

# --- CORS (THIS IS “Step A2” from earlier: allow Wix domain) ---
# Set env var CORS_ALLOW_ORIGINS to your Wix site origin(s):
#   https://yoursite.com,https://yoursite.wixsite.com
raw_origins = [o.strip() for o in settings.CORS_ALLOW_ORIGINS.split(",") if o.strip()]
allow_all = (settings.CORS_ALLOW_ORIGINS.strip() == "*")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if allow_all else raw_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routes
app.include_router(consent_router)

@app.get("/health")
def health():
    return {"ok": True}

def _looks_explicit(text: str) -> bool:
    """
    Minimal heuristic.
    Replace this with your real classifier/moderation later.
    """
    t = text.lower()
    keywords = ["explicit", "nude", "sex", "porn", "dirty", "fuck", "cock", "pussy"]
    return any(k in t for k in keywords)

@app.post("/chat", response_model=ChatResponse)
async def chat(payload: ChatRequest, request: Request):
    if not payload.messages:
        raise HTTPException(status_code=400, detail="messages cannot be empty")

    # Identify if user is asking for explicit content
    last_user = next((m for m in reversed(payload.messages) if m.role == "user"), None)
    user_text = last_user.content if last_user else ""
    user_requesting_explicit = payload.wants_explicit or _looks_explicit(user_text)

    # Enforce explicit consent gate
    rec = consent_store.get(payload.session_id)
    explicit_allowed = bool(rec and rec.explicit_allowed)

    if settings.REQUIRE_EXPLICIT_CONSENT_FOR_EXPLICIT_CONTENT and user_requesting_explicit and not explicit_allowed:
        return ChatResponse(
            session_id=payload.session_id,
            mode="explicit_blocked",
            reply=(
                "Before we go further, I need to confirm you’re 18+ and that you want explicit adult conversation. "
                "Please use the consent flow to opt in (double 18+ confirmation + explicit intent)."
            ),
        )

    # TODO: Replace this stub with your real LLM call + your safety layers.
    # For now: simple echo behavior to prove the gate works.
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
