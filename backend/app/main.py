from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import List, Dict, Any
import traceback

from app.chat.service import chat_turn
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

allowed_origins = [
    # local dev
    "http://localhost:3000",
    "http://127.0.0.1:3000",

    # production frontends
    "https://yellow-hill-0a40ae30f.3.azurestaticapps.net",
    "https://www.aihaven4u.com",
    "https://aihaven4u.com",

    # wix preview/editor
    "https://editor.wix.com",
    "https://manage.wix.com",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatReq(BaseModel):
    text: str
    session_state: Dict[str, Any]
    history: List[Dict[str, str]]

@app.post("/chat")
def chat(req: ChatReq):
    try:
        reply, new_state = chat_turn(req.text, req.session_state, req.history)
        return JSONResponse(
            content={"reply": reply, "session_state": new_state},
            media_type="application/json; charset=utf-8",
        )
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
def health():
    return {"ok": True}
