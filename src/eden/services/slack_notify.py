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


def _safe_text(text: str) -> str:
    """M12 (§7.2): value-level redact Slack free text before send."""
    try:
        from eden.issues.fixture_export import redact_secret_values

        return redact_secret_values(text)
    except Exception:
        return text

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
    """Standard alert layout: header, body, one deep-link button, context.

    M12 (§7.2): body/header/context are value-level-redacted so secret
    substrings never reach Slack.
    """
    return [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": _safe_text(header)[:150]},
        },
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": _safe_text(body)[:2900]},
        },
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
            "elements": [
                {"type": "mrkdwn", "text": _safe_text(context)[:2900]}
            ],
        },
    ]


async def _send(
    org_id: str,
    *,
    agent_id: str | None,
    dedupe_key: str,
    text: str,
    blocks: list[dict[str, Any]],
    session_id: str | None = None,
) -> dict[str, Any]:
    """Resolve channel + token, rate-limit, post. Never raises."""
    if not await _allow_send(org_id, dedupe_key):
        return {"status": "rate_limited"}
    text = _safe_text(text)
    try:
        from eden.integrations.slack import store as slack_store
        from eden.integrations.slack.client import SlackClient

        channel = await slack_store.get_channel(org_id, agent_id=agent_id)
        if channel is None:
            return {"status": "no_channel"}
        token = await slack_store.get_bot_token(org_id)
        if not token:
            return {"status": "not_connected"}
        channel_id = str(channel["channel_id"])
        resp = await SlackClient(token).post_message(
            channel=channel_id,
            text=text,
            blocks=blocks,
        )
        ts = str(resp.get("ts") or "")
        if ts:
            try:
                await slack_store.save_pointer(
                    org_id,
                    channel_id=channel_id,
                    ts=ts,
                    agent_id=agent_id,
                    session_id=session_id,
                )
            except Exception as exc:  # noqa: BLE001
                logger.debug("slack_notify: pointer persist skipped: %s", exc)
        return {"status": "sent", "ts": ts, "channel": channel_id}
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


async def notify_ci_failure(
    org_id: str,
    *,
    plan_id: str,
    check_name: str,
    conclusion: str,
    title: str,
    pr_url: str | None = None,
    agent_id: str | None = None,
) -> dict[str, Any]:
    """M9 (§4.3): customer CI went red on an Eden improvement PR.

    Deduped per (plan, check) via ``ci:{plan_id}:{check}`` so retried
    check_run deliveries and multi-run suites don't repeat the ping.
    """
    url = pr_url or _deep_link(f"/improve?plan={plan_id}")
    return await _send(
        org_id,
        agent_id=agent_id,
        dedupe_key=f"ci:{plan_id}:{check_name}",
        text=f":rotating_light: CI failed on Eden PR: {title}",
        blocks=_blocks(
            header="Customer CI failed on an Eden PR",
            body=(
                f"*{title[:400]}*\n"
                f"Check: `{check_name}` — conclusion: `{conclusion}`\n"
                "Eden stamped the failure on the plan and, if the PR is "
                "still open, queued one regenerate with the CI excerpt."
            ),
            link_url=url,
            link_label="Review the PR / plan",
            context="Eden Soft Autonomy — CI conclusions ingested via the GitHub App",
        ),
    )


async def notify_needs_approval(
    org_id: str,
    *,
    plan_id: str,
    title: str,
    kind: str = "config",
    agent_id: str | None = None,
    queue: str | None = None,
) -> dict[str, Any]:
    """A plan landed in Needs-you. Deep link to the plan view.

    M13 (§6.2): when ``slack_notify_fix_now_only`` (default True),
    Improve-later kinds (advisory/config/cost) are suppressed — only
    Fix-now (code_patch / prompt_update) notifies Slack.
    """
    kind_l = (kind or "").lower()
    queue_l = (queue or "").lower()
    try:
        from eden.config import get_settings

        fix_now_only = bool(
            getattr(get_settings(), "slack_notify_fix_now_only", True)
        )
    except Exception:
        fix_now_only = True
    if fix_now_only:
        fix_now_kinds = {"code_patch", "prompt_update"}
        if queue_l == "improve_later" or (
            queue_l != "fix_now" and kind_l not in fix_now_kinds
        ):
            return {
                "status": "skipped",
                "reason": "improve_later_no_slack",
                "kind": kind_l,
            }
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


async def notify_loop_dead(
    org_id: str,
    *,
    reasons: list[str],
    outbox_depth: int,
    publish_failure_age_s: float | None,
) -> dict[str, Any]:
    """M2 loop-dead: event publishing is failing or the outbox is backing up."""
    age = (
        f"{int(publish_failure_age_s)}s"
        if publish_failure_age_s is not None
        else "n/a"
    )
    return await _send(
        org_id,
        agent_id=None,
        dedupe_key="loop_dead",
        text=":rotating_light: Eden closed loop is dead: " + "; ".join(reasons),
        blocks=_blocks(
            header="Closed loop dead",
            body=(
                "*The improvement loop is not moving.*\n"
                + "\n".join(f"• {r}" for r in reasons)
                + f"\nOutbox depth: `{outbox_depth}` — publish failing for: `{age}`"
            ),
            link_url=_deep_link("/loop-health"),
            link_label="Open loop health",
            context="Eden loop-dead watchdog — verify worker idle chore",
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


async def notify_nl_incident(
    org_id: str,
    *,
    alert_event_id: str,
    rule_name: str,
    reason: str | None = None,
    confidence: float | None = None,
    agent_id: str | None = None,
) -> dict[str, Any]:
    """NL alert rule ruled a ``real_incident`` — routed to Slack when
    the rule's ``channels`` config enables it (FEAT-43). Mirrors
    ``eden.services.alert_email.send_nl_incident_email``'s content;
    the two are independent per-channel toggles, not a fallback pair.
    """
    conf = f"{confidence:.2f}" if confidence is not None else "n/a"
    url = _deep_link(f"/signals?event={alert_event_id}")
    return await _send(
        org_id,
        agent_id=agent_id,
        dedupe_key=f"nl_incident:{alert_event_id}",
        text=f":rotating_light: NL alert ruled a real incident: {rule_name}",
        blocks=_blocks(
            header=":rotating_light: NL alert — real incident",
            body=(
                f"*Rule:* {rule_name}\n"
                f"*Confidence:* {conf}\n"
                f"*Reason:* {reason or 'n/a'}"
            ),
            link_url=url,
            link_label="Open in Eden",
            context="Eden NL alert triage — rate-limited alert",
        ),
    )



async def notify_help_miss(
    org_id: str,
    *,
    agent_id: str,
    fingerprint: str,
    sentence: str = "",
    channel_name: str = "",
    path: str = "ambient",
    person: str = "still did X",
    snippet: str = "",
    session_id: str | None = None,
    helped_n: int = 0,
    not_helped_n: int = 0,
    unknown_n: int = 0,
    leftover_n: int = 0,
) -> dict[str, Any]:
    """HelpMiss card. Dedup helpmiss:{agent_id}:{fingerprint}. No Approve-in-Slack."""
    where = "ambient hit" if path == "ambient" else "thread takeover"
    channel_bit = f"#{channel_name}" if channel_name else "mapped channel"
    session_url = _deep_link(f"/traces?view=sessions&session={session_id}") if session_id else ""
    change_url = _deep_link("/improve")
    snippet_line = f'"{(snippet or "")[:280]}"' if snippet else ""
    body = (
        f"*Job:* {sentence or '(no HelpContract)'}\n"
        f"*Where:* {channel_bit}  ·  {where}\n"
        f"*Person:* {person}\n"
        + (f"*Snippet:* {snippet_line}\n" if snippet_line else "")
        + f"*Counts:* {helped_n} helped · {not_helped_n} didn’t · {unknown_n} unknown · {leftover_n} ambient leftover (7d)"
    )
    elements = [
        {
            "type": "button",
            "text": {"type": "plain_text", "text": "Review change"[:75]},
            "url": change_url,
        }
    ]
    if session_url:
        elements.insert(
            0,
            {
                "type": "button",
                "text": {"type": "plain_text", "text": "Open session"[:75]},
                "url": session_url,
            },
        )
    blocks = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": _safe_text(f"{agent_id} didn’t help")[:150]},
        },
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": _safe_text(body)[:2900]},
        },
        {"type": "actions", "elements": elements},
        {
            "type": "context",
            "elements": [
                {
                    "type": "mrkdwn",
                    "text": _safe_text("Did it actually help? — leftover work, not a second pager")[:2900],
                }
            ],
        },
    ]
    return await _send(
        org_id,
        agent_id=agent_id,
        dedupe_key=f"helpmiss:{agent_id}:{fingerprint}",
        text=f"{agent_id} didn’t help",
        blocks=blocks,
        session_id=session_id,
    )



async def notify_help_miss_applied(
    org_id: str,
    *,
    agent_id: str,
    plan_id: str,
    apply_kind: str,
    pr_url: str | None = None,
    pr_error: str | None = None,
) -> dict[str, Any]:
    """Slack 2 after Do it. Posts to the picked agent channel, never a DM."""
    change_url = _deep_link(f"/improve?plan={plan_id}")
    if apply_kind == "code_pr" and pr_url:
        body = (
            "Change is in. Watching leftover work on invited channels.\n\n"
            f"File PR: {pr_url}\n"
            "Merge the PR for the file to go live in the repo."
        )
    elif pr_error:
        body = (
            f"Change is in Eden. The file PR failed: {pr_error}\n\n"
            "Watching leftover work on invited channels."
        )
    else:
        body = (
            "Change is in Eden.\n\n"
            "Watching leftover work on invited channels."
        )
    blocks = [
        {
            "type": "header",
            "text": {
                "type": "plain_text",
                "text": _safe_text("Change is in")[:150],
            },
        },
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": _safe_text(body)[:2900]},
        },
        {
            "type": "actions",
            "elements": [
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Open in Eden"[:75]},
                    "url": change_url,
                }
            ],
        },
    ]
    return await _send(
        org_id,
        agent_id=agent_id or None,
        dedupe_key=f"helpmiss_applied:{plan_id}",
        text="Change is in",
        blocks=blocks,
    )

__all__ = [
    "notify_issue_detected",
    "notify_needs_approval",
    "notify_nl_incident",
    "notify_pr_opened",
    "notify_help_miss",
    "notify_help_miss_applied",
    "notify_regression",
    "send_test_message",
]
