"""Shared signal extractors for Layer A (fast, deterministic NLP-lite)."""

from __future__ import annotations

import math
import re
from typing import Any

# ── Lexicons ──────────────────────────────────────────────────────

CHITCHAT_RE = re.compile(
    r"""
    ^\s*(
        (hi|hello|hey|yo|sup|howdy|hiya)\b[\s!.]*
      | (thanks|thank\s+you|thx|ty|cheers)\b[\s!.]*
      | (ok|okay|k|cool|great|awesome|perfect|got\s+it|sounds\s+good)\b[\s!.]*
      | (bye|goodbye|see\s+ya|cya|good\s+night|take\s+care)\b[\s!.]*
      | (good\s+(morning|afternoon|evening|night))\b[\s!.]*
      | (how\s+are\s+you|what'?s\s+up|how'?s\s+it\s+going)\b[\s!.?]*
      | (nice\s+to\s+meet\s+you)\b[\s!.]*
      | (lol|haha|👍|🙏)\s*
    )\s*$
    """,
    re.IGNORECASE | re.VERBOSE,
)

# Soft UTU: short social / ack messages that almost never need tools.
SOFT_UTU_RE = re.compile(
    r"""
    ^\s*(
        (just\s+checking\s+in|checking\s+in)\b.*
      | (nm|n\/m|never\s+mind)\b[\s!.]*
      | (that'?s\s+all|all\s+good|no\s+worries|no\s+problem)\b[\s!.]*
      | (appreciate\s+it|much\s+appreciated)\b[\s!.]*
      | (have\s+a\s+(good|nice|great)\s+(one|day|night))\b[\s!.]*
      | (who\s+are\s+you|what\s+can\s+you\s+do)\b[\s!.?]*
    )\s*$
    """,
    re.IGNORECASE | re.VERBOSE,
)

FRUSTRATION_RE = re.compile(
    r"\b("
    r"try\s+again|wrong|not\s+helpful|doesn'?t\s+work|does\s+not\s+work|"
    r"frustrated|useless|broken|still\s+wrong|this\s+is\s+wrong|"
    r"you\s+already|i\s+(already|just)\s+(told|said|asked)|"
    r"stop\s+(looping|repeating)|are\s+you\s+(dumb|stupid|broken)|"
    r"not\s+what\s+i\s+(asked|wanted)|give\s+up"
    r")\b",
    re.IGNORECASE,
)

CLARIFICATION_RE = re.compile(
    r"(\?\s*$|could\s+you\s+clarify|what\s+do\s+you\s+mean|"
    r"can\s+you\s+(provide|share|tell)|which\s+(one|account|option)|"
    r"need\s+more\s+(info|information|details)|please\s+specify)",
    re.IGNORECASE,
)

INCOMPLETE_RE = re.compile(
    r"\b("
    r"i\s+(can'?t|cannot|unable\s+to)\b|"
    r"let\s+me\s+know\s+if|"
    r"i'?ll\s+(need|have)\s+to|"
    r"as\s+soon\s+as|"
    r"still\s+working|"
    r"i\s+don'?t\s+have\s+(enough|access)|"
    r"please\s+try\s+again\s+later|"
    r"unable\s+to\s+complete|"
    r"could\s+not\s+complete|"
    r"not\s+able\s+to\s+finish"
    r")\b",
    re.IGNORECASE,
)

REFUSAL_RE = re.compile(
    r"\b("
    r"i\s+(can'?t|cannot|won'?t|will\s+not)\s+(help|assist|do\s+that)|"
    r"against\s+(my|the)\s+policy|"
    r"i'?m\s+not\s+able\s+to\s+(help|assist)|"
    r"refuse|declin(e|ing)"
    r")\b",
    re.IGNORECASE,
)

JAILBREAK_RE = re.compile(
    r"("
    r"ignore\s+(all\s+)?(previous|prior)\s+instructions|"
    r"dan\s+mode|developer\s+mode|"
    r"jailbreak|"
    r"bypass\s+(the\s+)?(safety|filter|guard)|"
    r"pretend\s+you\s+(have\s+no|don'?t\s+have)\s+(rules|limits)|"
    r"do\s+anything\s+now"
    r")",
    re.IGNORECASE,
)

PII_RE = re.compile(
    r"("
    r"\b\d{3}-\d{2}-\d{4}\b|"  # SSN-like
    r"\b(?:\d[ -]*?){13,19}\b|"  # card-like
    r"\b[A-Z]{1,2}\d{6,9}\b"  # passport-ish
    r")",
)

MCP_AUTH_RE = re.compile(
    r"(unauthorized|401|403|forbidden|invalid[_\s-]?token|"
    r"auth(entication|orization)?\s+(failed|error)|mcp.*auth|"
    r"access[_\s-]?denied|not\s+authenticated)",
    re.IGNORECASE,
)

PLAN_MARKER_RE = re.compile(
    r"\b(i\s+will|i'?ll|plan:|steps?:|first[,:]|then[,:]|next[,:])\b",
    re.IGNORECASE,
)

SUCCESS_CLAIM_RE = re.compile(
    r"\b(done|completed|successfully|transferred|sent|cancelled|canceled|"
    r"updated|created|deleted|booked|scheduled)\b",
    re.IGNORECASE,
)

STOP_SALIENT = frozenset(
    {
        "true", "false", "null", "none", "status", "error", "message", "result",
        "data", "ok", "success", "failed", "failure", "type", "name", "value",
        "count", "total", "items", "id", "ids", "user", "tool", "call", "content",
        "role", "assistant", "system", "function", "arguments", "http", "https",
        "json", "text", "unknown", "temp", "city", "units", "metric",
        # JSON key names — never treat as factual anchors
        "txn_id", "order_id", "user_id", "trace_id", "span_id", "tool_call_id",
        "amount_usd", "price_usd", "balance_usd", "account", "tracking",
        "sku", "email", "phone", "created_at", "updated_at", "eta",
        "from", "to", "amount", "currency", "price", "balance",
    }
)

SALIENT_RE = re.compile(
    r"""
    (?:
        [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}
      | [A-Z]{2,}_[A-Z0-9_]{3,}
      | (?:acc_|ord_|txn_|user_|sess_|trace_|span_|call_|trk_|sku_)[A-Za-z0-9_-]{3,}
      | \$?\d+(?:\.\d+)?
      | [A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}
      | \b[A-Z0-9]{8,}\b
      | [A-Za-z][A-Za-z0-9_-]{5,}
    )
    """,
    re.VERBOSE | re.IGNORECASE,
)

NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?")


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def tokenize(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9_]+", normalize_text(text)))


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def extract_salient_tokens(text: str) -> set[str]:
    if not text:
        return set()
    found: set[str] = set()
    for m in SALIENT_RE.finditer(text):
        tok = m.group(0)
        low = tok.lower().lstrip("$")
        if low in STOP_SALIENT:
            continue
        if low.isdigit() and len(low) <= 2:
            continue
        found.add(low)
        found.add(tok)
    return found


def strong_anchors(tokens: set[str]) -> set[str]:
    """High-precision subset for result_ignore / fabrication."""
    out: set[str] = set()
    for t in tokens:
        low = t.lower()
        if low in STOP_SALIENT:
            continue
        # Bare years are not decisive factual anchors
        if re.fullmatch(r"20\d{2}|19\d{2}", t):
            continue
        if re.fullmatch(r"\d{3,}(?:\.\d+)?", t):
            out.add(t)
        elif "@" in t:
            out.add(t)
        elif t.startswith(("acc_", "ord_", "txn_", "user_", "sess_", "trk_", "sku_")):
            out.add(t)
        elif re.fullmatch(r"[0-9a-f]{8}-[0-9a-f-]{27,}", t):
            out.add(t)
        elif re.fullmatch(r"\d{4}-\d{2}-\d{2}", t):
            out.add(t)
        elif re.fullmatch(r"[a-z0-9]{10,}", t) and any(c.isdigit() for c in t):
            out.add(t)
    return out


def normalize_number_token(tok: str) -> str:
    t = tok.lstrip("$").replace(",", "")
    try:
        v = float(t)
        if v == int(v) and abs(v) < 1e15:
            return str(int(v))
        return f"{v:.4g}"
    except ValueError:
        return tok.lower()


def numbers_in(text: str) -> set[str]:
    return {normalize_number_token(m.group(0)) for m in NUMBER_RE.finditer(text or "")}


def fuzzy_token_in_text(tok: str, text_norm: str) -> bool:
    """Match token allowing $ prefixes, int/float equiv, and cents→dollars."""
    low = tok.lower().lstrip("$")
    if low in text_norm or tok.lower() in text_norm:
        return True
    num = normalize_number_token(tok)
    if num in text_norm:
        return True
    if "." in num:
        whole = num.split(".", 1)[0]
        if whole and re.search(rf"(?<!\d){re.escape(whole)}(?!\d)", text_norm):
            return True
    # cents → dollars (4200 ↔ 42.00 / $42)
    try:
        v = float(num)
        if v >= 100 and v == int(v):
            whole = str(int(v // 100))
            dollars = f"{v / 100:.2f}".rstrip("0").rstrip(".")
            if dollars in text_norm or re.search(
                rf"(?<!\d){re.escape(whole)}(?!\d)", text_norm
            ):
                return True
    except ValueError:
        pass
    return False


def intent_keywords(user_text: str) -> set[str]:
    """Map user text to coarse intent buckets (expanded synonym patterns)."""
    t = normalize_text(user_text)
    hits: set[str] = set()
    patterns = {
        "weather": r"\b(weather|forecast|temperature|rain|sunny|humid|umbrella)\b",
        "transfer": r"\b(transfer|send\s+\$|pay|wire|move\s+\$|venmo|zelle)\b",
        "email": r"\b(email|e-mail|send\s+(an?\s+)?mail|inbox)\b",
        "search": r"\b(search|look\s*up|find|google|query|retrieve|docs?\s+on)\b",
        "order": r"\b(order|shipment|tracking|package|delivery|parcel)\b",
        "cancel": r"\b(cancel|void|refund|revoke|undo\s+the\s+order)\b",
        "calendar": r"\b(calendar|schedule|meeting|appoint|book\s+a\s+slot)\b",
        "code": r"\b(github|pull\s*request|\bpr\b|repo|commit|codebase|merge)\b",
        "database": r"\b(sql|database|postgres|query\s+the\s+db|run\s+a\s+query)\b",
        "file": r"\b(read\s+file|write\s+file|upload|s3|filesystem|document)\b",
        "message": r"\b(slack|sms|text\s+me|notify|ping\s+me|send\s+a\s+message)\b",
        "user": r"\b(my\s+profile|user\s+profile|customer\s+record|crm|account\s+details)\b",
    }
    for intent, pat in patterns.items():
        if re.search(pat, t):
            hits.add(intent)
    return hits


def tool_matches_intent(tool_name: str, intent: str) -> bool:
    from eden.evaluation.descriptors.taxonomy import INTENT_TOOL_AFFINITY

    frags = INTENT_TOOL_AFFINITY.get(intent, ())
    low = tool_name.lower().replace("-", "_")
    return any(f in low for f in frags)


def is_soft_utu(user_text: str) -> bool:
    """True when the user message almost certainly needs no tools."""
    u = (user_text or "").strip()
    if not u:
        return False
    if CHITCHAT_RE.match(u) or SOFT_UTU_RE.match(u):
        return True
    # Very short non-question acknowledgements
    if len(u.split()) <= 3 and not re.search(r"\?|please|can\s+you|could\s+you", u, re.I):
        if re.match(r"^(yep|yeah|nah|sure|fine|alright|np)\W*$", u, re.I):
            return True
    return False


def content_overlap_ratio(a: str, b: str) -> float:
    """Semantic-lite overlap: content tokens only (drop stopwords)."""
    stop = {
        "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "is", "are",
        "was", "were", "be", "been", "it", "this", "that", "with", "as", "at",
        "by", "from", "your", "you", "i", "we", "they", "have", "has", "had",
    }
    ta = {t for t in tokenize(a) if t not in stop and len(t) > 2}
    tb = {t for t in tokenize(b) if t not in stop and len(t) > 2}
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def normalize_args_for_similarity(args_canonical: str) -> str:
    """Strip volatile fields so near-identical retries still match."""
    if not args_canonical:
        return ""
    # Drop ISO timestamps / UUIDs / nonce-like keys from JSON-ish strings
    s = re.sub(
        r'"?(timestamp|ts|nonce|request_id|trace_id|span_id|idempotency_key|session_id|created_at|updated_at|uuid)"?\s*:\s*"[^"]*"\s*,?',
        "",
        args_canonical,
        flags=re.I,
    )
    s = re.sub(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        "",
        s,
        flags=re.I,
    )
    s = re.sub(r"\s+", "", s)
    return s

def entropy_of_args(arg_strings: list[str]) -> float:
    """Rough diversity of argument blobs (0 = all identical)."""
    if not arg_strings:
        return 0.0
    counts: dict[str, int] = {}
    for a in arg_strings:
        counts[a] = counts.get(a, 0) + 1
    n = len(arg_strings)
    h = 0.0
    for c in counts.values():
        p = c / n
        h -= p * math.log(p + 1e-12, 2)
    return h


def is_empty_payload(content: str | None) -> bool:
    if content is None:
        return True
    s = content.strip()
    if not s:
        return True
    if s in {"{}", "[]", "null", "None", '""', "''"}:
        return True
    if re.fullmatch(r'\{\s*\}', s) or re.fullmatch(r'\[\s*\]', s):
        return True
    return False
