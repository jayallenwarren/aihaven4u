from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
import os

from .settings import settings
from .models import ChatResponse
from .consent_store import consent_store
from .consent_routes import router as consent_router

# --------------------------------------------------
# App setup
# --------------------------------------------------

app = FastAPI(title="AIHaven4U API")

# --------------------------------------------------
# CORS
# --------------------------------------------------

raw_origins = [o.strip() for o in settings.CORS_ALLOW_ORIGINS.split(",") if o.strip()]
allow_all = settings.CORS_ALLOW_ORIGINS.strip() == "*"

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if allow_all else raw_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --------------------------------------------------
# Routers
# --------------------------------------------------

app.include_router(consent_router)

# --------------------------------------------------
# OpenAI
# --------------------------------------------------

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    raise RuntimeError("OPENAI_API_KEY is not set")

openai_client = OpenAI(api_key=OPENAI_API_KEY)

# --------------------------------------------------
# Health
# --------------------------------------------------

@app.get("/health")
def health():
    return {"ok": True}

# --------------------------------------------------
# Optional debug (DEV ONLY)
# --------------------------------------------------

@app.get("/debug/cors")
def debug_cors():
    if not getattr(settings, "DEBUG", False):
        raise HTTPException(status_code=404, detail="Not Found")

    return {
        "CORS_ALLOW_ORIGINS_raw": settings.CORS_ALLOW_ORIGINS,
        "parsed_origins": raw_origins,
    }

# --------------------------------------------------
# Helpers
# --------------------------------------------------

def looks_explicit(text: str) -> bool:
    t = text.lower()
    keywords = [
        "explicit", "nude", "sex", "porn", "fuck", "cock",
        "pussy", "blowjob", "anal", "orgasm"
    ]
    return any(k in t for k in keywords)

def history_to_openai(history):
    return [{"role": m["role"], "content": m["content"]} for m in history]

# --------------------------------------------------
# Chat
# --------------------------------------------------

@app.post("/chat", response_model=ChatResponse)
async def chat(request: Request):
    payload = await request.json()

    # ----- Validate payload -----
    if "h
