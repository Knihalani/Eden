"""Ambient Slack listen pipeline — Stages 0–3 (keywords only).

Stage 4 (cloud LLM / embedding) is OFF this slice. Persist an
``extra_work_events`` row ONLY on fire. Unmapped / no-contract /
no-keyword / thanks / bots store nothing. Uncertain is not produced
without embeddings, so ``extra_work_candidates`` is unused here.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

STAGE0_SUBTYPES = frozenset(
    {
        "channel_join",
        "channel_topic",
        "channel_purpose",
        "channel_name",
        "channel_archive",
        "channel_unarchive",
        "message_changed",
        "message_deleted",
        "bot_message",
    }
)

_THANKS_RE = re.compile(
    r"^\s*(?:thanks|thank you|lgtm|shipped|✅|👍|:\+1:)[\s!.]*$",
    re.IGNORECASE,
)
_EMOJI_TOKEN_RE = re.compile(r":[a-z0-9_+-]+:", re.IGNORECASE)
_EMOJI_GLYPH_RE = re.compile(
    r"[\U0001F300-\U0001FAFF\U00002700-\U000027BF✅👍]+"
)
_WORD_RE = re.compile(r"[a-z0-9]+", re.IGNORECASE)
_STOPWORDS = frozenset(
    {
        "a",
        "an",
        "the",
        "to",
        "of",
        "for",
        "and",
        "or",
        "is",
        "this",
        "supposed",
        "take",
        "off",
    }
)

LISTEN_CHANNEL_TYPES = frozenset({"channel", "group", "mpim"})


@dataclass(frozen=True)
class AmbientDecision:
    action: str  # drop | fire
    reason: str
    y_weighted: bool = False
    keywords_hit: tuple[str, ...] = field(default_factory=tuple)
    kind: str = ""
    confidence: str = ""
    snippet: str = ""
    polarity: str = ""
    path: str = ""
    surface: str = ""


def is_emoji_only(text: str) -> bool:
    stripped = _EMOJI_TOKEN_RE.sub("", text)
    stripped = _EMOJI_GLYPH_RE.sub("", stripped)
    return not stripped.strip()


def is_thanks(text: str) -> bool:
    return bool(_THANKS_RE.match(text or ""))


def derive_keywords(contract: dict[str, Any]) -> list[str]:
    existing = [str(k).strip() for k in (contract.get("x_keywords") or []) if str(k).strip()]
    if existing:
        return existing
    blob = f"{contract.get('sentence') or ''} {contract.get('x_job') or ''}"
    toks = _WORD_RE.findall(blob.lower())
    return [t for t in toks if t not in _STOPWORDS and len(t) > 1]


def keyword_hits(text: str, keywords: list[str]) -> list[str]:
    lower = (text or "").lower()
    words = set(_WORD_RE.findall(lower))
    hits: list[str] = []
    for kw in keywords:
        kw_n = kw.lower().strip()
        if not kw_n:
            continue
        if " " in kw_n:
            if re.search(r"\b" + re.escape(kw_n) + r"\b", lower):
                hits.append(kw_n)
        elif kw_n in words:
            hits.append(kw_n)
    return hits


def stage0_drop(event: dict[str, Any]) -> str | None:
    """Return a drop reason or None if the event survives Stage 0."""
    if event.get("bot_id") or event.get("subtype") in STAGE0_SUBTYPES:
        return "stage0_bot_or_subtype"
    text = str(event.get("text") or "")
    if not text.strip():
        return "stage0_empty"
    if is_emoji_only(text):
        return "stage0_emoji_only"
    if is_thanks(text):
        return "stage0_thanks"
    return None


def classify(
    *,
    event: dict[str, Any],
    contract: dict[str, Any] | None,
) -> AmbientDecision:
    """Stages 0 + 2 + 3. Stage 1 (channel map) is the caller's job."""
    reason = stage0_drop(event)
    if reason:
        return AmbientDecision(action="drop", reason=reason)

    if not contract:
        return AmbientDecision(action="drop", reason="stage3_no_contract")

    keywords = derive_keywords(contract)
    if not keywords:
        return AmbientDecision(action="drop", reason="stage3_no_keywords")

    text = str(event.get("text") or "")
    hits = keyword_hits(text, keywords)
    if not hits:
        return AmbientDecision(action="drop", reason="stage3_unrelated")

    speaker = str(event.get("user") or "")
    y_id = str(contract.get("y_slack_user_id") or "")
    y_weighted = bool(y_id) and speaker == y_id
    snippet = text[:280]
    return AmbientDecision(
        action="fire",
        reason="stage3_keyword",
        y_weighted=y_weighted,
        keywords_hit=tuple(hits),
        kind="human_did_agents_job",
        confidence="medium" if y_weighted else "low",
        snippet=snippet,
        polarity="extra_work",
        path="ambient",
        surface="slack",
    )


__all__ = [
    "AmbientDecision",
    "LISTEN_CHANNEL_TYPES",
    "STAGE0_SUBTYPES",
    "classify",
    "derive_keywords",
    "is_emoji_only",
    "is_thanks",
    "keyword_hits",
    "stage0_drop",
]
