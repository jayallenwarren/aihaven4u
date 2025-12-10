import json
from app.chat.router import route_turn
from typing import List, Dict, Any
from openai import OpenAI

from app.rag.retriever import get_retriever
from app.chat.prompting import build_runtime_system

client = OpenAI()

def update_consent_from_user(user_text: str, session_state: Dict[str, Any]):
    t = user_text.lower().strip()

    if t in ["yes", "yeah", "yep", "i do", "sure"]:
        # If we were asking romance consent
        if session_state.get("pending_consent") == "romance":
            session_state["romance_consented"] = True
            session_state["mode"] = "romantic"
            session_state["pending_consent"] = None

        # If we were asking explicit consent
        if session_state.get("pending_consent") == "explicit":
            session_state["explicit_consented"] = True
            session_state["mode"] = "explicit"
            session_state["pending_consent"] = None

        # If we were asking adult verification
        if session_state.get("pending_consent") == "adult":
    	    session_state["adult_verified"] = True
    	    session_state["pending_consent"] = None


def format_history(history):
    """Keep history tiny for MVP + guard against bad shapes."""
    if not isinstance(history, list):
        return []
    cleaned = []
    for m in history:
        if isinstance(m, dict) and "role" in m and "content" in m:
            cleaned.append({"role": m["role"], "content": m["content"]})
    return cleaned[-6:]  # last 6 messages max

def retrieve_context(user_text: str, mode: str, k: int = 3) -> str:
    """
    Retrieve small, bounded RAG context.
    Bias toward AI Haven 4U + correct mode.
    """
    retriever = get_retriever(k=k)

    # Query boost to prefer correct brand + mode docs
    boosted_query = f"[brand: AI Haven 4U] [mode: {mode}] {user_text}"
    docs = retriever.invoke(boosted_query)

    # Post-rerank: prefer AI Haven 4U / latest docs by filename
    def score_doc(d):
        src = (d.metadata.get("source") or "").lower()
        text = (d.page_content or "").lower()
        score = 0
        if "ai_haven_4u" in src or "ai haven 4u" in text:
            score += 3
        if "haven" in src and "ai_haven_4u" not in src:
            score -= 1  # downweight legacy docs
        if f"mode: {mode}" in text:
            score += 1
        return score

    docs = sorted(docs, key=score_doc, reverse=True)

    blocks = []
    for d in docs[:k]:
        txt = (d.page_content or "").strip()
        src = d.metadata.get("source", "kb")
        blocks.append(f"[source: {src}]\n{txt[:1500]}")

    rag = "\n\n---\n\n".join(blocks)
    return rag[:6000]


def chat_turn(user_text: str, session_state: Dict[str, Any], history: List[Dict[str, str]]):
    mode = session_state.get("mode", "friend")

    # 0) Update consent from user replies first
    update_consent_from_user(user_text, session_state)

    # 1) Route for safety/consent
    action, short_msg = route_turn(user_text, session_state)

    if action == "need_romance_consent":
        session_state["pending_consent"] = "romance"
        return short_msg, session_state

    if action == "need_explicit_consent":
        # decide which consent we're asking for
        if not session_state.get("adult_verified", False):
            session_state["pending_consent"] = "adult"
        else:
            session_state["pending_consent"] = "explicit"
        return short_msg, session_state

    if action == "crisis" or action == "block_taboo":
        # short-circuit hard safety cases
        session_state["pending_consent"] = None
        return short_msg, session_state

    # 2) Normal RAG + LLM path
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

    # FINAL safety cap on total prompt size
    total_chars = sum(len(m["content"]) for m in messages)
    if total_chars > 20000:
        messages = messages[:1] + messages[-3:]
        total_chars = sum(len(m["content"]) for m in messages)

    resp = client.chat.completions.create(
        model=session_state.get("model", "gpt-4o"),
        messages=messages,
        temperature=0.8,
        max_tokens=400,  # correct param
    )

    assistant_text = resp.choices[0].message.content
    return assistant_text, session_state

