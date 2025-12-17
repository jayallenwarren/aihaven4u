from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any
import os
import traceback

from app.chat.service import chat_turn

app = FastAPI()

# 1) CORS: keep explicit origins + add regex for Azure Static Web Apps environments
allowed_origins = [
    # local dev
    "http://localhost:3000",
    "http://127.0.0.1:3000",

    # production frontends
    "https://www.aihaven4u.com",
    "https://aihaven4u.com",

    # (optional) keep your exact SWA production url if you want
    "https://yellow-hill-0a40ae30f.3.azurestaticapps.net",

    # wix preview/editor
    "https://editor.wix.com",
    "https://manage.wix.com",
]

# This covers: https://<anything>.azurestaticapps.net
# If you don't want regex, remove this and just whitelist all needed SWA URLs.
allow_origin_regex = r"^https:\/\/.*\.azurestaticapps\.net$"

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=allow_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatReq(BaseModel):
    text: str
    session_state: Dict[str, Any]
    history: List[Dict[str, str]]

@app.post("/chat")
async def chat(req: ChatReq):
    try:
        reply, new_state = chat_turn(req.text, req.session_state, req.history)
        return {"reply": reply, "session_state": new_state}

    except FileNotFoundError as e:
        # Chroma missing / ingest not run
        raise HTTPException(
            status_code=503,
            detail=str(e),
        )

    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
def health():
    return {"ok": True}

# Optional: a root route so visiting the API in a browser shows something friendly
@app.get("/")
def root():
    return {"service": "aihaven4u-api", "status": "running"}
