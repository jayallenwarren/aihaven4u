import re
from typing import Tuple, Dict, Any

CRISIS_PATTERNS = [
    r"\bkill myself\b",
    r"\bsuicide\b",
    r"\bend my life\b",
    r"\bwant to die\b",
    r"\bself[- ]?harm\b",
]

EXPLICIT_PATTERNS = [
    r"\bsex\b", r"\bfuck\b", r"\bmake love\b", r"\berotic\b",
    r"\bexplicit\b", r"\bnude\b", r"\borgasm\b",
]

ROMANCE_PATTERNS = [
    r"\bdate\b", r"\bgirlfriend\b", r"\bboyfriend\b",
    r"\blove you\b", r"\bkiss\b", r"\bromantic\b", r"\bflirt\b",
]

TABOO_PATTERNS = [
    r"\bminor\b", r"\bund(er)?age\b", r"\bchild\b", r"\bteen\b",
    r"\bincest\b", r"\bdad\b", r"\bmom\b", r"\bsister\b", r"\bbrother\b",
    r"\brape\b", r"\bnon[- ]?consensual\b", r"\bcoerc(e|ion)\b",
]

def _matches_any(text: str, patterns) -> bool:
    t = text.lower()
    return any(re.search(p, t) for p in patterns)

def route_turn(user_text: str, session_state: Dict[str, Any]) -> Tuple[str, str]:
    """
    Returns (action, message)
    action in:
      - "crisis"
      - "block_taboo"
      - "need_romance_consent"
      - "need_explicit_consent"
      - "ok"
    message is assistant text for short-circuit cases.
    """
    if _matches_any(user_text, CRISIS_PATTERNS):
        return ("crisis",
                "I’m really sorry you’re feeling this way. You matter, and I’m worried about your safety. "
                "If you’re in immediate danger or thinking about harming yourself, please contact emergency services "
                "or a crisis line right now. I can stay with you while you reach out. "
                "You don’t have to go through this alone.")

    if _matches_any(user_text, TABOO_PATTERNS):
        return ("block_taboo",
                "I can’t help with anything involving minors, coercion, or other unsafe/illegal sexual content. "
                "If you want to talk about feelings or safe, consensual adult intimacy, I’m here for that.")

    wants_explicit = _matches_any(user_text, EXPLICIT_PATTERNS)
    wants_romance = _matches_any(user_text, ROMANCE_PATTERNS)

    # Explicit requests require adult_verified + explicit_consented
    if wants_explicit:
        if not session_state.get("adult_verified", False):
            return ("need_explicit_consent",
                    "Before we go further, I need to confirm you’re 18+ and that you want explicit adult conversation. "
                    "Are you 18 or older, and do you want to opt into Explicit Mode?")
        if not session_state.get("explicit_consented", False):
            return ("need_explicit_consent",
                    "I can do explicit adult conversation only with your clear opt-in. "
                    "Do you want to enter Explicit Mode? You can say yes or no.")

    # Romance requests require romance_consented
    if wants_romance and not session_state.get("romance_consented", False):
        return ("need_romance_consent",
                "I can be romantic only if you want that. "
                "Would you like to opt into Romantic Mode? You can say yes or no.")

    return ("ok", "")
