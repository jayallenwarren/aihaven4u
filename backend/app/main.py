from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import List, Dict, Any
import traceback

from app.chat.service import chat_turn

from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],  # Next dev server
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# app = FastAPI()  # ✅ must be defined before decorators

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
            media_type="application/json; charset=utf-8"
        )
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
def health():
    return {"ok": True}
