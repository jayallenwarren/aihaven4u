from typing import List, Dict, Any
from openai import OpenAI

from app.chat.router import route_turn
from app.rag.retriever import get_retriever
from app.chat.prompting import build_runtime_system

ROMANTIC_ALLOWED_PLANS = {
    "Week - Trial",
    "Weekly - Romantic",
    "Weekly - Intimate (18+)",
    "Test - Romantic",
    "Test - Intimate (18+)",
}

EXPLICIT_ALLOWED_PLANS = {
    "Weekly - Intimate (18+)",
    "Test - Intimate (18+)",
}

def update_consent_from_user(user_text: str, session_state: Dict[str, Any]):
    t = (user_text or "").lower().strip()
    plan_name = (session_state.get("plan_name") or "").strip()

    if t in ["yes", "yeah", "yep", "i do", "sure"]:
        if session_state.get("pending_consent") == "romance":
            if plan_name in ROMANTIC_ALLOWED_PLANS:
                session_state["romance_consented"] = True
                session_state["mode"] = "romantic"
            else:
                session_state["romance_consented"] = False
                session_state["mode"] = "friend"
            session_state["pending_consent"] = None

        elif session_state.get("pending_consent") == "explicit":
            if plan_name in EXPLICIT_ALLOWED_PLANS:
                session_state["explicit_consented"] = True
                session_state["mode"] = "explicit"
            else:
                session_state["explicit_consented"] = False
                session_state["mode"] = "friend"
            session_state["pending_consent"] = None

        elif session_state.get("pending_consent") == "adult":
            session_state["adult_verified"] = True
            session_state["pending_consent"] = None

    if t in ["no", "nope", "nah", "i don't", "do not"]:
        session_state["pending_consent"] = None
        session_state["mode"] = "friend"

def format_history(history):
    if not isinstance(history, list):
        return []
    cleaned = []
    for m in history:
        if isinstance(m, dict) and "role" in m and "content" in m:
            cleaned.append({"role": m["role"], "content": m["content"]})
    return cleaned[-6:]

def retrieve_context(user_text: str, mode: str, k: int = 3) -> str:
    try:
        retriever = get_retriever(k=k)
    except Exception:
        return ""

    boosted_query = f"[brand: AI Haven 4U] [mode: {mode}] {user_text}"
    docs = retriever.invoke(boosted_query)

    blocks = []
    for d in docs[:k]:
        txt = (d.page_content or "").strip()
        src = d.metadata.get("source", "kb")
        blocks.append(f"[source: {src}]\n{txt[:1500]}")

    rag = "\n\n---\n\n".join(blocks)
    return rag[:6000]

def chat_turn(user_text: str, session_state: Dict[str, Any], history: List[Dict[str, str]]):
    client = OpenAI()

    update_consent_from_user(user_text, session_state)

    action, short_msg = route_turn(user_text, session_state)

    if action == "upgrade_required":
        session_state["pending_consent"] = None
        session_state["mode"] = "friend"
        return short_msg, session_state

    if action == "need_romance_consent":
        session_state["pending_consent"] = "romance"
        return short_msg, session_state

    if action == "need_explicit_consent":
        session_state["pending_consent"] = (
            "adult" if not session_state.get("adult_verified", False) else "explicit"
        )
        return short_msg, session_state

    if action in ("crisis", "block_taboo"):
        session_state["pending_consent"] = None
        return short_msg, session_state

    mode = session_state.get("mode", "friend")
    rag_context = retrieve_context(user_text, mode, k=2)

    system_msg = build_runtime_system(
        rag_context=rag_context,
        mode=mode,
        session_state=session_state,
        user_text=user_text,
    )

    messages = [{"role": "system", "content": system_msg}]
    messages.extend(format_history(history))
    messages.append({"role": "user", "content": user_text})

    resp = client.chat.completions.create(
        model=session_state.get("model", "gpt-4o"),
        messages=messages,
        temperature=0.8,
        max_tokens=400,
    )

    assistant_text = resp.choices[0].message.content
    return assistant_text, session_state
