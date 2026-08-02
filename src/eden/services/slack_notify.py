"""Slack alert dispatcher — Soft Autonomy Phase 5/6.

Turns Eden events into Slack messages with per-agent channel routing:

* Issue detected (P0/P1) → the agent's channel (or org default)
* Fix PR opened → the agent's channel, with a deep link to the portal
  Improve plan (Approve happens in the portal, never in Slack)
* Plan needs approval → the agent's channel, deep link to the plan
* Post-merge regression → the agent's channel, deep link to the issue

Rate limiting mirrors :mod:`eden.services.alert_email` — Redis SETNX
dedupe per fingerprint + an hourly org cap, fail-open when Redis is
unavailable. Slack is the primary alert channel; email stays the
P0/P1 emergency fallback.

All sends are best-effort: a Slack failure must never break the
detection / PR pipeline, so every public function swallows transport
errors after logging.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.config import get_settings

logger = logging.getLogger(__name__)


def _portal_base() -> str:
    """Base URL for deep links into the portal."""
    s = get_settings()
    for attr in ("portal_base_url", "app_url"):
        base = (getattr(s, attr, "") or "").strip().rstrip("/")
        if base and "example.com" not in base:
            return base
    return ""


def _deep_link(path: str) -> str:
    base = _portal_base()
    return f"{base}{path}" if base else path


async def _allow_send(org_id: str, dedupe_key: str) -> bool:
    """Redis dedupe + hourly org cap. Fail-open if Redis unavailable.

    Same policy as ``alert_email._allow_send`` but keyed separately so
    Slack and email don't eat each other's budget.
    """
    settings = get_settings()
    if not getattr(settings, "slack_alerts_enabled", True):
        return False
    try:
        from eden.storage.redis import get_redis_client

        redis = await get_redis_client()
        if redis is None:
            return True
        dedup_min = int(getattr(settings, "slack_alert_dedup_minutes", 15) or 15)
        max_per_hour = int(getattr(settings, "slack_alert_max_per_hour", 30) or 30)
        fingerprint = f"eden:slack_alert:dedup:{org_id}:{dedupe_key}"
        ok = await redis.set(fingerprint, "1", nx=True, ex=max(60, dedup_min * 60))
        if not ok:
            return False
        hour_key = f"eden:slack_alert:hour:{org_id}"
        count = await redis.incr(hour_key)
        if count == 1:
            await redis.expire(hour_key, 3600)
        return not count > max_per_hour
    except Exception as exc:  # noqa: BLE001
        logger.debug("slack_notify: allow_send redis skipped: %s", exc)
        return True


_SEV_EMOJI = {"P0": ":rotating_light:", "P1": ":warning:", "P2": ":large_yellow_circle:"}


def _blocks(
    *,
    header: str,
    body: str,
    link_url: str,
    link_label: str,
    context: str,
) -> list[dict[str, Any]]:
    """Standard alert layout: header, body, one deep-link button, context."""
    return [
        {"type": "header", "text": {"type": "plain_text", "text": header[:150]}},
        {"type": "section", "text": {"type": "mrkdwn", "text": body[:2900]}},
        {
            "type": "actions",
            "elements": [
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": link_label[:75]},
                    "url": link_url,
                }
            ],
        },
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": context[:2900]}],
        },
    ]


async def _send(
    org_id: str,
    *,
    agent_id: str | None,
    dedupe_key: str,
    text: str,
    blocks: list[dict[str, Any]],
) -> dict[str, Any]:
    """Resolve channel + token, rate-limit, post. Never raises."""
    if not await _allow_send(org_id, dedupe_key):
        return {"status": "rate_limited"}
    try:
        from eden.integrations.slack import store as slack_store
        from eden.integrations.slack.client import SlackClient

        channel = await slack_store.get_channel(org_id, agent_id=agent_id)
        if channel is None:
            return {"status": "no_channel"}
        token = await slack_store.get_bot_token(org_id)
        if not token:
            return {"status": "not_connected"}
        resp = await SlackClient(token).post_message(
            channel=str(channel["channel_id"]),
            text=text,
            blocks=blocks,
        )
        return {"status": "sent", "ts": str(resp.get("ts") or "")}
    except Exception as exc:  # noqa: BLE001
        logger.warning("slack_notify: send failed org=%s: %s", org_id, exc)
        return {"status": "error", "reason": str(exc)[:200]}


# ── Event senders ───────────────────────────────────────────────────


async def notify_issue_detected(
    org_id: str,
    *,
    issue_id: str,
    title: str,
    severity: str,
    agent_id: str | None = None,
    impact: str = "",
) -> dict[str, Any]:
    """New grouped issue. Sparse policy: P0/P1 only (P2 lives in-app)."""
    sev = (severity or "").upper()
    if sev not in ("P0", "P1", "CRITICAL", "HIGH"):
        return {"status": "skipped_severity"}
    emoji = _SEV_EMOJI.get(sev, ":warning:")
    url = _deep_link(f"/issues?issue={issue_id}")
    impact_line = f"\n*Impact:* {impact[:300]}" if impact else ""
    return await _send(
        org_id,
        agent_id=agent_id,
        dedupe_key=f"issue:{issue_id}:{sev}",
        text=f"{emoji} [{sev}] {title}",
        blocks=_blocks(
            header=f"{emoji} {sev} issue detected",
            body=f"*{title[:400]}*{impact_line}",
            link_url=url,
            link_label="Open issue in Eden",
            context="Eden Soft Autonomy — reply volume is rate-limited",
        ),
    )


async def notify_pr_opened(
    org_id: str,
    *,
    plan_id: str,
    pr_url: str,
    title: str,
    agent_id: str | None = None,
    issue_id: str | None = None,
) -> dict[str, Any]:
    """Eden drafted/opened a fix PR. Approve is a deep link to the
    portal Improve plan — never an in-Slack action."""
    url = _deep_link(f"/improve?plan={plan_id}")
    issue_line = f"\nFixes issue `{issue_id}`" if issue_id else ""
    return await _send(
        org_id,
        agent_id=agent_id,
        dedupe_key=f"pr:{plan_id}",
        text=f":hammer_and_wrench: Fix PR opened: {title}",
        blocks=_blocks(
            header="Fix PR opened",
            body=(
                f"*{title[:400]}*{issue_line}\n"
                f"<{pr_url}|View the pull request on GitHub>"
            ),
            link_url=url,
            link_label="Review & approve in Eden",
            context="Approval happens in the portal — this button deep-links to the plan",
        ),
    )


async def notify_needs_approval(
    org_id: str,
    *,
    plan_id: str,
    title: str,
    kind: str = "config",
    agent_id: str | None = None,
) -> dict[str, Any]:
    """A plan landed in Needs-you. Deep link to the plan view."""
    url = _deep_link(f"/improve?plan={plan_id}")
    return await _send(
        org_id,
        agent_id=agent_id,
        dedupe_key=f"approve:{plan_id}",
        text=f":raising_hand: Approval needed: {title}",
        blocks=_blocks(
            header="Approval needed",
            body=f"*{title[:400]}*\nPlan kind: `{kind}`",
            link_url=url,
            link_label="Approve or reject in Eden",
            context="Eden Soft Autonomy — one click in the portal decides",
        ),
    )


async def notify_regression(
    org_id: str,
    *,
    plan_id: str,
    issue_id: str,
    title: str,
    agent_id: str | None = None,
    action: str = "follow_up",
) -> dict[str, Any]:
    """Post-merge guardian found a regression caused by a merged PR."""
    url = _deep_link(f"/issues?issue={issue_id}")
    action_line = (
        "Eden opened a revert PR." if action == "revert" else "Eden drafted a follow-up fix."
    )
    return await _send(
        org_id,
        agent_id=agent_id,
        dedupe_key=f"regression:{issue_id}",
        text=f":chart_with_downwards_trend: Regression after PR: {title}",
        blocks=_blocks(
            header="Regression detected after merge",
            body=f"*{title[:400]}*\n{action_line} (plan `{plan_id}`)",
            link_url=url,
            link_label="Open regression issue",
            context="Eden post-PR guardian — Eden only ever helps",
        ),
    )


async def send_test_message(
    org_id: str,
    *,
    agent_id: str | None = None,
    requested_by: str = "",
) -> dict[str, Any]:
    """Portal "Send test" button — bypasses dedupe, still resolves the
    same channel + token path so the test proves the real route."""
    try:
        from eden.integrations.slack import store as slack_store
        from eden.integrations.slack.client import SlackClient

        channel = await slack_store.get_channel(org_id, agent_id=agent_id)
        if channel is None:
            return {"status": "no_channel", "reason": "No channel bound for this agent (or org default)."}
        token = await slack_store.get_bot_token(org_id)
        if not token:
            return {"status": "not_connected", "reason": "Slack is not connected for this org."}
        who = f" by {requested_by}" if requested_by else ""
        resp = await SlackClient(token).post_message(
            channel=str(channel["channel_id"]),
            text="Eden test alert — Slack is connected",
            blocks=_blocks(
                header="Eden test alert",
                body=f"Slack alerts are wired up{who}. Issues, fix PRs, and approval requests for this agent will land here.",
                link_url=_deep_link("/settings?tab=integrations"),
                link_label="Open Eden settings",
                context="Sent from the portal Slack settings page",
            ),
        )
        return {"status": "sent", "ts": str(resp.get("ts") or "")}
    except Exception as exc:  # noqa: BLE001
        logger.warning("slack_notify: test send failed org=%s: %s", org_id, exc)
        return {"status": "error", "reason": str(exc)[:200]}


__all__ = [
    "notify_issue_detected",
    "notify_needs_approval",
    "notify_pr_opened",
    "notify_regression",
    "send_test_message",
]
