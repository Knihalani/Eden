"""Ambient Slack listen pipeline — Stages 0–3 (keywords only).

Stage 4 (cloud LLM / embedding) is OFF this slice. Persist an
``extra_work_events`` row ONLY on fire. Unmapped / no-contract /
no-keyword / thanks / bots store nothing. Uncertain is not produced
without embeddings, so ``extra_work_candidates`` is unused here.
This slice does not write ``session_summaries.helped``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from eden.integrations.slack import store as slack_store

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

#: message.channels / message.groups. DMs (im) are never consumed.
LISTEN_CHANNEL_TYPES = frozenset({"channel", "group"})

_THANKS_RE = re.compile(
    r"^\s*(?:thanks|thank you|lgtm|shipped|✅|👍|:\+1:)[\s!.]*$",
    re.IGNORECASE,
)
_THANKS_TOKEN_RE = re.compile(
    r"\bthanks\b|\bthank you\b|\blgtm\b|\bshipped\b|✅|👍|:\+1:",
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


def is_dm(event: dict[str, Any]) -> bool:
    """True for Slack DMs (``message.im``). Never indexed this slice."""
    if str(event.get("channel_type") or "") == "im":
        return True
    return str(event.get("channel") or "").startswith("D")


def is_emoji_only(text: str) -> bool:
    stripped = _EMOJI_TOKEN_RE.sub("", text)
    stripped = _EMOJI_GLYPH_RE.sub("", stripped)
    return not stripped.strip()


def is_thanks(text: str) -> bool:
    """Allow-list acknowledgements — not extra work, also not helped.

    Case-insensitive word match: the message is thanks if it is only
    allow-list tokens (thanks / thank you / lgtm / shipped / ✅ / 👍 / :+1:)
    plus whitespace/punctuation.
    """
    raw = text or ""
    if _THANKS_RE.match(raw):
        return True
    if not _THANKS_TOKEN_RE.search(raw):
        return False
    remainder = _THANKS_TOKEN_RE.sub(" ", raw)
    remainder = re.sub(r"[\s!.?,]+", "", remainder)
    return not remainder


def derive_keywords(contract: dict[str, Any]) -> list[str]:
    existing = [
        str(k).strip() for k in (contract.get("x_keywords") or []) if str(k).strip()
    ]
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


def _observed_at(ts: str) -> str:
    try:
        return datetime.fromtimestamp(float(ts), tz=UTC).isoformat()
    except (TypeError, ValueError):
        return datetime.now(UTC).isoformat()


async def process_message(
    *,
    org_id: str,
    event_id: str,
    event: dict[str, Any],
) -> AmbientDecision:
    """Stages 0–3 + persist-on-fire. No Slack Web API calls."""
    if event_id and await slack_store.event_id_seen(org_id, event_id):
        return AmbientDecision(action="drop", reason="duplicate_event_id")

    reason = stage0_drop(event)
    if reason:
        return AmbientDecision(action="drop", reason=reason)

    channel_id = str(event.get("channel") or "")
    mapping = await slack_store.get_agent_for_channel(org_id, channel_id)
    if not mapping or not mapping.get("agent_id"):
        return AmbientDecision(action="drop", reason="stage1_unmapped")

    agent_id = str(mapping["agent_id"])
    contract = await slack_store.get_current_help_contract(org_id, agent_id)
    decision = classify(event=event, contract=contract)
    if decision.action != "fire" or not contract:
        return decision

    message_ts = str(event.get("ts") or "")
    thread_ts = str(event.get("thread_ts") or "") or None
    await slack_store.insert_extra_work_event(
        org_id,
        agent_id=agent_id,
        event_id=event_id or None,
        user_id=str(event.get("user") or "") or None,
        help_contract_id=str(contract.get("id") or "") or None,
        surface=decision.surface,
        kind=decision.kind,
        path=decision.path,
        join_key={
            "system": "slack",
            "slack_channel_id": channel_id,
            "slack_message_ts": message_ts,
            "slack_thread_ts": thread_ts,
        },
        snippet=decision.snippet,
        confidence=decision.confidence,
        polarity=decision.polarity,
        raw={
            "event_id": event_id,
            "ts": message_ts,
            "kind": decision.kind,
            "stage": 3,
        },
        observed_at=_observed_at(message_ts),
        session_id=None,
    )
    return decision



_MENTION_RE = re.compile(r"<@(U[A-Z0-9]+)>")
_PERMALINK_RE = re.compile(r"p(\d{10})(\d+)")


def parse_permalink_ts(value: str) -> str | None:
    if not value:
        return None
    raw = str(value).strip()
    m = _PERMALINK_RE.search(raw)
    if m:
        return f"{m.group(1)}.{m.group(2).rjust(6, "0")[:6]}"
    if re.fullmatch(r"\d+\.\d+", raw):
        return raw
    return None


def classify_pointer_message(
    *,
    message: dict[str, Any],
    y_slack_user_id: str | None = None,
    bot_user_id: str | None = None,
    bot_ts: str | None = None,
    bot_permalink: str | None = None,
) -> AmbientDecision | None:
    """P0 pointer detectors on one joined-thread message. No LLM."""
    if not isinstance(message, dict):
        return None
    user = str(message.get("user") or "")
    if bot_user_id and user == bot_user_id:
        return None
    if message.get("bot_id") or message.get("subtype") in {
        "bot_message",
        "message_changed",
        "channel_join",
    }:
        return None
    text = str(message.get("text") or "")
    ts = str(message.get("ts") or "")
    # 1. explicit_negative from feedback_buttons
    for block in message.get("blocks") or []:
        for el in (block.get("elements") or []) if isinstance(block, dict) else []:
            if not isinstance(el, dict):
                continue
            action = str(el.get("action_id") or el.get("value") or "").lower()
            if el.get("type") == "feedback_buttons" or "thumbsdown" in action or action in {
                "negative",
                "feedback_negative",
            }:
                selected = str(el.get("selected") or el.get("value") or "").lower()
                if selected in {"negative", "thumbsdown", "false", "1"}:
                    return AmbientDecision(
                        action="fire",
                        reason="explicit_negative",
                        kind="explicit_negative",
                        confidence="high",
                        snippet=text[:280],
                        polarity="extra_work",
                        path="pointer_thread",
                        surface="slack",
                    )
    if "feedback_negative" in text.lower() or text.strip() == ":-1:":
        return AmbientDecision(
            action="fire",
            reason="explicit_negative",
            kind="explicit_negative",
            confidence="high",
            snippet=text[:280],
            polarity="extra_work",
            path="pointer_thread",
            surface="slack",
        )
    # 2. mention intended owner
    if y_slack_user_id:
        for uid in _MENTION_RE.findall(text):
            if uid == y_slack_user_id:
                return AmbientDecision(
                    action="fire",
                    reason="mention_intended_owner",
                    y_weighted=True,
                    kind="mention_intended_owner",
                    confidence="medium",
                    snippet=text[:280],
                    polarity="extra_work",
                    path="pointer_thread",
                    surface="slack",
                )
    # 3. cleanup_thread — new top-level containing the bot permalink
    thread_ts = str(message.get("thread_ts") or "")
    is_top = not thread_ts or thread_ts == ts
    if is_top and bot_permalink and bot_permalink in text:
        return AmbientDecision(
            action="fire",
            reason="cleanup_thread",
            kind="cleanup_thread",
            confidence="medium",
            snippet=text[:280],
            polarity="extra_work",
            path="pointer_thread",
            surface="slack",
        )
    parsed = parse_permalink_ts(text)
    if is_top and bot_ts and parsed and parsed == bot_ts:
            return AmbientDecision(
                action="fire",
                reason="cleanup_thread",
                kind="cleanup_thread",
                confidence="medium",
                snippet=text[:280],
                polarity="extra_work",
                path="pointer_thread",
                surface="slack",
            )
    # 4. human in-thread not thanks
    if is_thanks(text):
        return AmbientDecision(
            action="drop",
            reason="thanks",
            path="pointer_thread",
            surface="slack",
        )
    if text.strip():
        return AmbientDecision(
            action="buffer",
            reason="thread_takeover_low",
            kind="thread_takeover",
            confidence="low",
            snippet=text[:280],
            polarity="unscored",
            path="pointer_thread",
            surface="slack",
        )
    return None


def classify_pointer_replies(
    *,
    replies: list[dict[str, Any]],
    y_slack_user_id: str | None = None,
    bot_user_id: str | None = None,
    bot_ts: str | None = None,
    bot_permalink: str | None = None,
) -> list[AmbientDecision]:
    """Window-close reader. Zero leftover -> caller leaves unknown."""
    hits: list[AmbientDecision] = []
    for msg in replies:
        # skip the original bot post
        if bot_ts and str(msg.get("ts") or "") == bot_ts:
            continue
        decision = classify_pointer_message(
            message=msg,
            y_slack_user_id=y_slack_user_id,
            bot_user_id=bot_user_id,
            bot_ts=bot_ts,
            bot_permalink=bot_permalink,
        )
        if decision is not None:
            hits.append(decision)
    return hits



async def close_pointer_windows(
    org_id: str,
    *,
    token: str,
    pointers: list[dict[str, Any]],
    y_slack_user_id: str | None = None,
    bot_user_id: str | None = None,
) -> list[dict[str, Any]]:
    """conversations.replies at window close. Zero leftover -> unknown (no write)."""
    from datetime import UTC, datetime

    from eden.integrations.slack import store as slack_store
    from eden.integrations.slack.client import SlackClient

    if not token or not pointers:
        return []
    client = SlackClient(token)
    fired: list[dict[str, Any]] = []
    for pointer in pointers:
        channel_id = str(pointer.get("channel_id") or "")
        ts = str(pointer.get("ts") or "")
        session_id = pointer.get("session_id")
        agent_id = str(pointer.get("agent_id") or "")
        if not channel_id or not ts or not session_id or not agent_id:
            continue
        replies = await client.conversations_replies(channel=channel_id, ts=ts)
        hits = classify_pointer_replies(
            replies=replies,
            y_slack_user_id=y_slack_user_id,
            bot_user_id=bot_user_id,
            bot_ts=ts,
        )
        for decision in hits:
            if decision.action != "fire":
                continue
            row = await slack_store.insert_extra_work_event(
                org_id,
                agent_id=agent_id,
                event_id=None,
                user_id=None,
                help_contract_id=None,
                surface="slack",
                kind=decision.kind,
                path="pointer_thread",
                join_key={
                    "system": "slack",
                    "slack_channel_id": channel_id,
                    "slack_thread_ts": ts,
                },
                snippet=decision.snippet,
                confidence=decision.confidence,
                polarity=decision.polarity,
                raw={"kind": decision.kind, "stage": "pointer"},
                observed_at=datetime.now(UTC).isoformat(),
                session_id=str(session_id),
            )
            if row:
                fired.append(row)
        if any(d.action == "fire" for d in hits):
            try:
                from eden.sessions.rollup import recompute_session_helped

                await recompute_session_helped(org_id, str(session_id))
            except Exception:
                pass
    return fired



#: Spec default; no existing constant in-tree.
INVITE_BACKFILL_HOURS = 24
_INVITE_EVENTS_SEEN: set[str] = set()
_BACKFILLED_CHANNELS: set[tuple[str, str]] = set()


async def close_due_pointer_windows() -> dict[str, object]:
    """Scheduled Path B close. Reused by ``run_maintenance_due``.

    conversations.replies only. Zero leftover -> unknown (no helped write).
    """
    from collections import defaultdict

    from eden.integrations.slack import store as slack_store

    memory = slack_store.list_due_pointers()
    durable = await slack_store.list_due_pointers_from_sessions()
    seen: set[tuple[str, str, str]] = set()
    by_org: dict[str, list[dict]] = defaultdict(list)
    for p in [*memory, *durable]:
        key = (
            str(p.get("org_id") or ""),
            str(p.get("channel_id") or ""),
            str(p.get("ts") or ""),
        )
        if not all(key) or key in seen:
            continue
        seen.add(key)
        by_org[key[0]].append(p)
    closed = 0
    fired = 0
    for org_id, pointers in by_org.items():
        token = await slack_store.get_bot_token(org_id)
        if not token:
            continue
        install = await slack_store.get_install(org_id)
        bot_user_id = str((install or {}).get("bot_user_id") or "") or None
        y_id = None
        agent_id = next((str(p.get("agent_id") or "") for p in pointers if p.get("agent_id")), "")
        if agent_id:
            contract = await slack_store.get_current_help_contract(org_id, agent_id)
            if contract:
                y_id = str(contract.get("y_slack_user_id") or "") or None
        rows = await close_pointer_windows(
            org_id,
            token=token,
            pointers=pointers,
            y_slack_user_id=y_id,
            bot_user_id=bot_user_id,
        )
        fired += len(rows)
        for p in pointers:
            await slack_store.mark_pointer_closed(
                org_id,
                session_id=p.get("session_id"),
                channel_id=str(p.get("channel_id") or ""),
                ts=str(p.get("ts") or ""),
            )
            closed += 1
    return {"closed": closed, "fired": fired, "orgs": len(by_org)}


async def backfill_on_invite(
    org_id: str,
    *,
    channel_id: str,
    joining_user: str = "",
    event_id: str = "",
) -> dict[str, object]:
    """One-time conversations.history on invite. Same Stage 0–3. Then stop."""
    import time

    from eden.integrations.slack import store as slack_store
    from eden.integrations.slack.client import SlackClient

    if not org_id or not channel_id:
        return {"skipped": True, "reason": "missing_ids"}
    if event_id and event_id in _INVITE_EVENTS_SEEN:
        return {"skipped": True, "reason": "event_seen"}
    if (org_id, channel_id) in _BACKFILLED_CHANNELS or await slack_store.is_channel_backfilled(org_id, channel_id):
        return {"skipped": True, "reason": "already_backfilled"}
    install = await slack_store.get_install(org_id)
    bot = str((install or {}).get("bot_user_id") or "")
    if joining_user and bot and joining_user != bot:
        return {"skipped": True, "reason": "not_bot_join"}
    token = await slack_store.get_bot_token(org_id)
    if not token:
        return {"skipped": True, "reason": "no_token"}
    if event_id:
        _INVITE_EVENTS_SEEN.add(event_id)
    _BACKFILLED_CHANNELS.add((org_id, channel_id))
    await slack_store.mark_channel_backfilled(org_id, channel_id)
    oldest = str(time.time() - INVITE_BACKFILL_HOURS * 3600)
    try:
        messages = await SlackClient(token).conversations_history(
            channel=channel_id, oldest=oldest
        )
    except Exception as exc:
        return {"errors": [str(exc)]}
    processed = 0
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        ev = dict(msg)
        ev["channel"] = channel_id
        ts = str(msg.get("ts") or "")
        await process_message(
            org_id=org_id,
            event_id=f"backfill:{channel_id}:{ts}" if ts else "",
            event=ev,
        )
        processed += 1
    return {
        "backfilled": processed,
        "channel_id": channel_id,
        "hours": INVITE_BACKFILL_HOURS,
    }


__all__ = [
    "AmbientDecision",
    "LISTEN_CHANNEL_TYPES",
    "STAGE0_SUBTYPES",
    "classify",
    "derive_keywords",
    "is_dm",
    "is_emoji_only",
    "is_thanks",
    "keyword_hits",
    "process_message",
    "stage0_drop",
    "classify_pointer_message",
    "classify_pointer_replies",
    "close_pointer_windows",
    "close_due_pointer_windows",
    "backfill_on_invite",
    "parse_permalink_ts",
    "INVITE_BACKFILL_HOURS",
]
