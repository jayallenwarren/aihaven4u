from __future__ import annotations

from pydantic import BaseModelfrom pydantic import BaseModel, Field
from typing import Literal, List, Any, Dict, Literal, Optional
from datetime import datetime

Role = Literal["user", "assistant", "system"]

class ChatMessage(BaseModel):
    role: Role
    content: str

class ChatRequest(BaseModel):
    session_id: str = Field(..., description="Client-generated session id (UUID recommended).")
    messages: List[ChatMessage]
    # Client hint only; server still enforces consent.
    wants_explicit: bool = False


class ChatResponse(BaseModel):
    session_id: str
    reply: str
    # This is a STATUS for the frontend (NOT the persona mode).
    mode: Literal["safe", "explicit_blocked", "explicit_allowed"] = "safe"

    # Echo state so frontend can keep pills/consent UI in sync.
    session_state: Optional[Dict[str, Any]] = None

class ExplicitConsentRequest(BaseModel):
    session_id: str
    # “double age verification” — two independent confirmations
    age_confirmed_18_plus: bool
    age_confirmed_18_plus_again: bool
    wants_explicit_now: bool

class ExplicitConsentStatus(BaseModel):
    session_id: str
    explicit_allowed: bool
    updated_at: datetime
    reason: Optional[str] = None
