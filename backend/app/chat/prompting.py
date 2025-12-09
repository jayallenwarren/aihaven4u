from pathlib import Path

PROMPTS_DIR = Path(__file__).resolve().parents[1] / "prompts"

SYSTEM_PROMPT = (PROMPTS_DIR / "system.txt").read_text(encoding="utf-8")
POLICY_PROMPT = (PROMPTS_DIR / "policy.txt").read_text(encoding="utf-8")

# Optional prompts (only if you add these files)
CRISIS_PROMPT_PATH = PROMPTS_DIR / "crisis.txt"
CRISIS_PROMPT = CRISIS_PROMPT_PATH.read_text(encoding="utf-8") if CRISIS_PROMPT_PATH.exists() else ""

MODE_PROMPTS = {}
for m in ["friend", "romantic", "explicit"]:
    p = PROMPTS_DIR / "modes" / f"{m}.txt"
    if p.exists():
        MODE_PROMPTS[m] = p.read_text(encoding="utf-8")

def crisis_triggered(user_text: str, session_state: dict) -> bool:
    """MVP heuristic. Replace with classifier later."""
    t = (user_text or "").lower()
    keywords = [
        "kill myself", "end my life", "suicide", "can't go on",
        "hurt myself", "self harm", "want to die"
    ]
    return any(k in t for k in keywords) or session_state.get("crisis_flag", False)

def build_runtime_system(
    rag_context: str,
    mode: str,
    session_state: dict,
    user_text: str,
):
    """
    Compose final system message in strict priority order:
    system -> policy -> mode -> consent -> crisis override -> RAG.
    """
    mode = mode if mode in MODE_PROMPTS else "friend"
    mode_prompt = MODE_PROMPTS.get(mode, "")

    consent_block = f"""
CONSENT STATE:
- adult_verified: {session_state.get("adult_verified", False)}
- romance_consented: {session_state.get("romance_consented", False)}
- explicit_consented: {session_state.get("explicit_consented", False)}

RULES:
- If mode == romantic and romance_consented is false, do NOT produce romance. Offer checkpoint.
- If mode == explicit and (adult_verified is false OR explicit_consented is false), do NOT produce explicit. Offer checkpoint.
""".strip()

    crisis_block = CRISIS_PROMPT.strip() if (CRISIS_PROMPT and crisis_triggered(user_text, session_state)) else ""

    rag_block = f"""
RAG CONTEXT (authoritative; follow over model priors):
{rag_context}
""".strip()

    parts = [
        SYSTEM_PROMPT.strip(),
        POLICY_PROMPT.strip(),
    ]

    if mode_prompt:
        parts.append(mode_prompt.strip())

    parts.append(consent_block)

    if crisis_block:
        parts.append(crisis_block)

    parts.append(rag_block)

    return "\n\n---\n\n".join(parts)
