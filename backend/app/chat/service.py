from typing import List, Dict, Any
from openai import OpenAI

from app.chat.router import (
    route_turn,
    infer_mode_switch_request,
    ROMANTIC_ALLOWED_PLANS,
    EXPLICIT_ALLOWED_PLANS,
)
from app.rag.retriever import get_retriever
from app.chat.prompting import build_runtime_system


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
        return


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
    except FileNotFoundError:
        return ""
    except Exception:
        return ""

    boosted_query = f"[brand: AI Haven 4U] [mode: {mode}] {user_text}"
    docs = retriever.invoke(boosted_query)

    def score_doc(d):
        src = (d.metadata.get("source") or "").lower()
        text = (d.page_content or "").lower()
        score = 0
        if "ai_haven_4u" in src or "ai haven 4u" in text:
            score += 3
        if "haven" in src and "ai_haven_4u" not in src:
            score -= 1
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


def _reset_mode_switch_debug(session_state: Dict[str, Any]) -> None:
    for k in [
        "mode_switch_applied",
        "mode_switch_success",
        "mode_switch_requested",
        "mode_switch_reason",
        "mode_switch_blocked_reason",
        "ui_mode_suggestion",
        "ui_mode_suggestion_reason",
    ]:
        session_state.pop(k, None)


def _apply_mode_switch_and_ui_suggestion(
    user_text: str, session_state: Dict[str, Any]
) -> None:
    """
    Reads user text for mode-switch intent and updates session_state accordingly.

    Semantics:
    - mode_switch_applied: True only when we actually set session_state["mode"] to the requested mode.
    - mode_switch_success: same as applied (True when applied).
    - ui_mode_suggestion: set whenever a mode switch is detected (even if blocked by consent),
      so the frontend can highlight the requested pill.
    """
    _reset_mode_switch_debug(session_state)

    switch_info = infer_mode_switch_request(user_text)
    if not switch_info:
        return

    plan_name = (session_state.get("plan_name") or "").strip()
    requested_mode = switch_info["mode"]
    reason = switch_info.get("reason", "unknown")

    session_state["mode_switch_requested"] = requested_mode
    session_state["mode_switch_reason"] = reason

    # Default values
    session_state["mode_switch_applied"] = False
    session_state["mode_switch_success"] = False

    # Frontend can highlight requested pill even if we can't enable it yet
    session_state["ui_mode_suggestion"] = requested_mode
    session_state["ui_mode_suggestion_reason"] = "user_requested_mode_switch"

    if requested_mode == "friend":
        session_state["mode"] = "friend"
        session_state["pending_consent"] = None

        session_state["mode_switch_applied"] = True
        session_state["mode_switch_success"] = True
        return

    if requested_mode == "romantic":
        if plan_name not in ROMANTIC_ALLOWED_PLANS:
            session_state["mode"] = "friend"
            session_state["pending_consent"] = None
            session_state["mode_switch_blocked_reason"] = "plan_not_entitled"
            return

        if session_state.get("romance_consented", False):
            session_state["mode"] = "romantic"
            session_state["pending_consent"] = None

            session_state["mode_switch_applied"] = True
            session_state["mode_switch_success"] = True
            return

        # Consent required; keep safe mode but suggest UI highlight
        session_state["mode"] = "friend"
        session_state["mode_switch_blocked_reason"] = "romance_consent_required"
        session_state["ui_mode_suggestion_reason"] = "consent_required"
        return

    if requested_mode == "explicit":
        if plan_name not in EXPLICIT_ALLOWED_PLANS:
            session_state["mode"] = "friend"
            session_state["pending_consent"] = None
            session_state["mode_switch_blocked_reason"] = "plan_not_entitled"
            return

        if not session_state.get("adult_verified", False):
            session_state["mode"] = "friend"
            session_state["mode_switch_blocked_reason"] = "adult_verification_required"
            session_state["ui_mode_suggestion_reason"] = "consent_required"
            return

        if not session_state.get("explicit_consented", False):
            session_state["mode"] = "friend"
            session_state["mode_switch_blocked_reason"] = "explicit_consent_required"
            session_state["ui_mode_suggestion_reason"] = "consent_required"
            return

        session_state["mode"] = "explicit"
        session_state["pending_consent"] = None

        session_state["mode_switch_applied"] = True
        session_state["mode_switch_success"] = True
        return


def chat_turn(user_text: str, session_state: Dict[str, Any], history: List[Dict[str, str]]):
    client = OpenAI()

    # 1) Apply consent updates
    update_consent_from_user(user_text, session_state)

    # 2) NEW: Explicit mode-switch enforcement + UI suggestion fields
    _apply_mode_switch_and_ui_suggestion(user_text, session_state)

    # 3) Route (handles upgrade_required + consent prompts for the same text)
    action, short_msg = route_turn(user_text, session_state)

    if action == "upgrade_required":
        session_state["pending_consent"] = None
        session_state["mode"] = "friend"
        return short_msg, session_state

    if action == "need_romance_consent":
        session_state["pending_consent"] = "romance"
        # If user asked to switch to romantic, keep the UI suggestion
        if session_state.get("ui_mode_suggestion") == "romantic":
            session_state["ui_mode_suggestion_reason"] = "consent_required"
        return short_msg, session_state

    if action == "need_explicit_consent":
        session_state["pending_consent"] = (
            "adult" if not session_state.get("adult_verified", False) else "explicit"
        )
        # If user asked to switch to explicit, keep the UI suggestion
        if session_state.get("ui_mode_suggestion") == "explicit":
            session_state["ui_mode_suggestion_reason"] = "consent_required"
        return short_msg, session_state

    if action in ("crisis", "block_taboo"):
        session_state["pending_consent"] = None
        return short_msg, session_state

    # 4) Normal LLM response
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

    total_chars = sum(len(m.get("content", "")) for m in messages)
    if total_chars > 20000:
        messages = messages[:1] + messages[-3:]

    resp = client.chat.completions.create(
        model=session_state.get("model", "gpt-4o"),
        messages=messages,
        temperature=0.8,
        max_tokens=400,
    )

    assistant_text = resp.choices[0].message.content
    return assistant_text, session_state
