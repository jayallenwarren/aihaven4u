import re
from typing import Tuple, Dict, Any, Optional

CRISIS_PATTERNS = [
    r"\bkill myself\b",
    r"\bsuicide\b",
    r"\bend my life\b",
    r"\bwant to die\b",
    r"\bself[- ]?harm\b",
]

# ✅ Explicit patterns (includes your additions)
EXPLICIT_PATTERNS = [
    r"\bsex\b",
    r"\bfuck\b",
    r"\bmake love\b",
    r"\berotic\b",
    r"\bexplicit\b",
    r"\bnude\b",
    r"\borgasm\b",
    r"\bblowjob\b",
    r"\bsquirt\b",
    r"\bpee\b",
    r"\bfart\b",
    r"\bbj\b",
    r"\bpussy\b",
    r"\banal\b",
    r"\bdeep throat\b",
]

ROMANCE_PATTERNS = [
    r"\bdate\b",
    r"\bgirlfriend\b",
    r"\bboyfriend\b",
    r"\blove you\b",
    r"\bkiss\b",
    r"\bromantic\b",
    r"\bromance\b",
    r"\bflirt\b",
]

TABOO_PATTERNS = [
    r"\bminor\b",
    r"\bund(er)?age\b",
    r"\bchild\b",
    r"\bteen\b",
    r"\bincest\b",
    r"\bdad\b",
    r"\bmom\b",
    r"\bsister\b",
    r"\bbrother\b",
    r"\brape\b",
    r"\bnon[- ]?consensual\b",
    r"\bcoerc(e|ion)\b",
]

UPGRADE_URL = "https://www.aihaven4u.com/pricing-plans/list"

# ✅ Plan names incl Test plans
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

def _matches_any(text: str, patterns) -> bool:
    t = (text or "").lower()
    return any(re.search(p, t) for p in patterns)

def _upgrade_msg(mode_label: str) -> str:
    return (
        f"The requested {mode_label} mode is not available for your current plan. "
        f"Your plan will need to be upgraded to complete your request.\n\n"
        f"Upgrade here: {UPGRADE_URL}"
    )

def infer_mode_switch_request(user_text: str) -> Optional[Dict[str, str]]:
    """
    Detect user-typed mode switch intent.
    Returns:
      {"mode": "friend"|"romantic"|"explicit", "reason": "<matched rule>"} or None

    Conservative to avoid false positives like "my friend said..."
    """
    t = (user_text or "").lower().strip()

    switchy = (
        re.search(r"\b(switch|change|go|return|get|set|move|put)\b", t)
        or re.search(r"\b(back to|go back to|switch back to|return to)\b", t)
        or re.search(r"\bmode\b", t)
        or re.search(r"\bkeep it\b", t)
        or re.search(r"\bstay\b", t)
    )
    if not switchy:
        return None

    # Friend
    if re.search(r"\b(stay|keep)\s+(it\s+)?friendly\b", t):
        return {"mode": "friend", "reason": "stay/keep friendly"}
    if re.search(r"\b(back to|go back to|switch back to|return to)\s+friend( mode)?\b", t):
        return {"mode": "friend", "reason": "back to friend"}
    if re.search(r"\b(switch|change|go|return|set|move|put)\s+(to\s+)?friend( mode)?\b", t):
        return {"mode": "friend", "reason": "switch to friend"}
    if re.search(r"\bfriend\s+mode\b", t):
        return {"mode": "friend", "reason": "friend mode"}

    # Romantic
    if re.search(r"\bromantic\b", t) or re.search(r"\bromance\b", t):
        return {"mode": "romantic", "reason": "romantic keyword"}

    # Explicit / Intimate
    if (
        re.search(r"\bexplicit\b", t)
        or re.search(r"\bintimate\b", t)
        or re.search(r"\b18\+\b", t)
        or re.search(r"\bnsfw\b", t)
    ):
        return {"mode": "explicit", "reason": "explicit/intimate keyword"}

    return None

def route_turn(user_text: str, session_state: Dict[str, Any]) -> Tuple[str, str]:
    """
    Returns (action, message)

    action in:
      - "crisis"
      - "block_taboo"
      - "upgrade_required"
      - "need_romance_consent"
      - "need_explicit_consent"
      - "ok"
    """
    if _matches_any(user_text, CRISIS_PATTERNS):
        return (
            "crisis",
            "I’m really sorry you’re feeling this way. You matter, and I’m worried about your safety. "
            "If you’re in immediate danger or thinking about harming yourself, please contact emergency services "
            "or a crisis line right now. I can stay with you while you reach out. You don’t have to go through this alone.",
        )

    if _matches_any(user_text, TABOO_PATTERNS):
        return (
            "block_taboo",
            "I can’t help with anything involving minors, coercion, or other unsafe/illegal sexual content. "
            "If you want to talk about feelings or safe, consensual adult intimacy, I’m here for that.",
        )

    wants_explicit = _matches_any(user_text, EXPLICIT_PATTERNS)
    wants_romance = _matches_any(user_text, ROMANCE_PATTERNS)

    plan_name = (session_state.get("plan_name") or "").strip()

    # ✅ PLAN ENFORCEMENT (blocks prompt-based bypass BEFORE consent prompts)
    if wants_explicit and plan_name not in EXPLICIT_ALLOWED_PLANS:
        return ("upgrade_required", _upgrade_msg("Intimate (18+)"))

    if wants_romance and plan_name not in ROMANTIC_ALLOWED_PLANS:
        return ("upgrade_required", _upgrade_msg("Romantic"))

    # Consent gates
    if wants_explicit:
        if not session_state.get("adult_verified", False):
            return (
                "need_explicit_consent",
                "Before we go further, I need to confirm you’re 18+ and that you want explicit adult conversation. "
                "Are you 18 or older, and do you want to opt into Explicit Mode?",
            )
        if not session_state.get("explicit_consented", False):
            return (
                "need_explicit_consent",
                "I can do explicit adult conversation only with your clear opt-in. "
                "Do you want to enter Explicit Mode? You can say yes or no.",
            )

    if wants_romance and not session_state.get("romance_consented", False):
        return (
            "need_romance_consent",
            "I can be romantic only if you want that. Would you like to opt into Romantic Mode? You can say yes or no.",
        )

    return ("ok", "")
