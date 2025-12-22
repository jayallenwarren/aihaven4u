from __future__ import annotations

from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel


class ChatResponse(BaseModel):
    session_id: str
    reply: str
    # This is a STATUS, not the UI persona mode.
    mode: Literal["safe", "explicit_blocked", "explicit_allowed"] = "safe"
    # Echo back state so frontend can persist consent / highlight pills.
    session_state: Optional[Dict[str, Any]] = None
