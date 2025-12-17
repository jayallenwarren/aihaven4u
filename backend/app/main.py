from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from .settings import settings
from .models import ChatRequest, ChatResponse
from .consent_store import consent_store
from .consent_routes import router as consent_router

app = FastAPI(title="AIHaven4U API")

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
allow_all = (cors_value == "*")

raw_origins = [
    o.strip()
    for o in cors_value.split(",")
    if o.strip()
]

if allow_all:
    allow_origins = ["*"]
    allow_credentials = False
else:
    allow_origins = raw_origins
    allow_credentials = True

if not allow_all and not allow_origins:
    # Keep app running but make misconfig obvious in logs
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
        raise HTTPException(status_code=400, detail="messages_
