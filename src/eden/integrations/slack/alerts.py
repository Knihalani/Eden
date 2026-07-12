"""Slack Block Kit alerts for closed-loop issues (F47, Wave 7).

The orchestrator calls :func:`alert_issue_event` at three moments:

* a **P0/P1 issue is created** (or regressed),
* a **verify fails** (a fix didn't hold), and
* an issue is **escalated to a human**.

Lower-severity issue creation is intentionally *not* paged — the portal
issue list is the surface for those. Two storm caps protect on-call:

* **dedupe** — an identical ``(issue_id, event)`` alert is suppressed for
  ``issue_alert_dedup_minutes`` (Redis ``SET NX EX``), so a re-delivery or
  a flapping verify doesn't double-page; and
* **rate cap** — an org is limited to ``issue_alert_max_per_hour`` alerts
  per rolling hour (Redis counter), after which alerts are dropped with a
  single "storm" log line.

The webhook URL is resolved per-org (``org_integrations`` when present)
with a global ``slack_webhook_url`` fallback; with no webhook configured
the function no-ops (returns ``False``) so nothing breaks in dev.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# Events that are allowed to page. Issue creation only pages for P0/P1
# (enforced separately on severity); verify_failed / human_escalation
# always page.
_ALERTABLE = {"issue_created", "verify_failed", "human_escalation"}
_PAGE_SEVERITIES = {"p0", "p1"}

_EMOJI = {
    "issue_created": ":rotating_light:",
    "verify_failed": ":x:",
    "human_escalation": ":raising_hand:",
}


async def alert_issue_event(
    org_id: str,
    *,
    issue_id: str,
    payload: dict[str, Any] | None = None,
    triage_result: dict[str, Any] | None = None,
    human_escalation: bool = False,
) -> bool:
    """Post a Slack alert for a closed-loop issue event.

    Returns True when an alert was actually delivered, False when it was
    skipped (disabled, deduped, storm-capped, below severity, or no
    webhook). Never raises.
    """
    try:
        return await _alert_issue_event_inner(
            org_id,
            issue_id=issue_id,
            payload=payload or {},
            triage_result=triage_result or {},
            human_escalation=human_escalation,
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("slack alerts: alert_issue_event failed: %s", exc)
        return False


async def _alert_issue_event_inner(
    org_id: str,
    *,
    issue_id: str,
    payload: dict[str, Any],
    triage_result: dict[str, Any],
    human_escalation: bool,
) -> bool:
    from eden.config import get_settings

    settings = get_settings()
    if not getattr(settings, "issue_alerts_enabled", True):
        return False

    event, severity = _classify(payload, human_escalation)
    if event not in _ALERTABLE:
        return False
    if event == "issue_created" and severity not in _PAGE_SEVERITIES:
        return False

    webhook = await _resolve_webhook(org_id, settings)
    if not webhook:
        logger.debug("slack alerts: no webhook for org=%s; skipping", org_id)
        return False

    redis = await _redis()
    if redis is not None and not await _pass_storm_caps(
        redis, org_id, issue_id, event, settings
    ):
        return False

    blocks = _build_blocks(
        org_id,
        issue_id=issue_id,
        event=event,
        severity=severity,
        payload=payload,
        triage_result=triage_result,
    )
    return await _post(webhook, blocks, event, severity)


def _classify(
    payload: dict[str, Any], human_escalation: bool
) -> tuple[str, str]:
    if human_escalation:
        event = "human_escalation"
    elif payload.get("verify") is not None or payload.get("event") == "verify_failed":
        event = "verify_failed"
    else:
        event = "issue_created"
    severity = str(payload.get("severity") or "p2").lower()
    return event, severity


async def _pass_storm_caps(
    redis: Any,
    org_id: str,
    issue_id: str,
    event: str,
    settings: Any,
) -> bool:
    dedup_min = int(getattr(settings, "issue_alert_dedup_minutes", 15))
    max_hr = int(getattr(settings, "issue_alert_max_per_hour", 30))

    # Dedup: identical (issue, event) within the window → suppress.
    try:
        was_set = await redis.set(
            f"alert:dedup:{org_id}:{issue_id}:{event}",
            "1",
            ex=dedup_min * 60,
            nx=True,
        )
        if not was_set:
            logger.debug("slack alerts: deduped %s/%s", issue_id, event)
            return False
    except Exception:
        pass

    # Rate cap: per-org rolling hour.
    try:
        key = f"alert:rate:{org_id}"
        count = await redis.incr(key)
        if count == 1:
            await redis.expire(key, 3600)
        if count > max_hr:
            if count == max_hr + 1:
                logger.warning(
                    "slack alerts: org=%s hit storm cap (%s/hr) — suppressing",
                    org_id,
                    max_hr,
                )
            return False
    except Exception:
        pass
    return True


def _build_blocks(
    org_id: str,
    *,
    issue_id: str,
    event: str,
    severity: str,
    payload: dict[str, Any],
    triage_result: dict[str, Any],
) -> list[dict[str, Any]]:
    emoji = _EMOJI.get(event, ":bell:")
    title = payload.get("title") or triage_result.get("summary") or issue_id
    kind = payload.get("kind") or "issue"
    headline = {
        "issue_created": f"{emoji} New {severity.upper()} issue",
        "verify_failed": f"{emoji} Fix verification FAILED",
        "human_escalation": f"{emoji} Issue escalated for human review",
    }.get(event, f"{emoji} Issue update")

    fields = [
        {"type": "mrkdwn", "text": f"*Severity:*\n{severity.upper()}"},
        {"type": "mrkdwn", "text": f"*Kind:*\n{kind}"},
    ]
    src = triage_result.get("source")
    if src:
        fields.append({"type": "mrkdwn", "text": f"*Triage:*\n{src}"})
    if payload.get("regressed"):
        fields.append({"type": "mrkdwn", "text": "*Regressed:*\n:warning: yes"})

    context_line = f"org `{org_id}` · issue `{issue_id}`"
    reason = (payload.get("verify") or {}).get("reason") if isinstance(
        payload.get("verify"), dict
    ) else None

    blocks: list[dict[str, Any]] = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": headline[:150], "emoji": True},
        },
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": f"*{str(title)[:280]}*"},
            "fields": fields,
        },
    ]
    if reason:
        blocks.append(
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": f"_Reason:_ {str(reason)[:280]}"},
            }
        )
    blocks.append(
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": context_line}],
        }
    )
    return blocks


async def _post(
    webhook: str, blocks: list[dict[str, Any]], event: str, severity: str
) -> bool:
    fallback = f"[{severity.upper()}] {event}"
    body = {"text": fallback, "blocks": blocks}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(webhook, json=body)
        if resp.status_code in (200, 204):
            return True
        logger.warning(
            "slack alerts: webhook returned %s: %s",
            resp.status_code,
            resp.text[:200],
        )
        return False
    except httpx.RequestError as exc:
        logger.warning("slack alerts: post failed: %s", exc)
        return False


async def _resolve_webhook(org_id: str, settings: Any) -> str:
    # Per-org override first (org_integrations), then global fallback.
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is not None:
            row = await client.fetchrow(
                "SELECT config FROM org_integrations "
                "WHERE org_id = $1 AND provider = 'slack' AND enabled = true "
                "LIMIT 1",
                org_id,
            )
            if row:
                cfg = row.get("config") or {}
                if isinstance(cfg, str):
                    import json

                    try:
                        cfg = json.loads(cfg)
                    except (TypeError, ValueError):
                        cfg = {}
                url = (cfg or {}).get("webhook_url")
                if url:
                    return str(url)
    except Exception as exc:
        logger.debug("slack alerts: per-org webhook lookup failed: %s", exc)
    return str(getattr(settings, "slack_webhook_url", "") or "")


async def _redis() -> Any | None:
    try:
        from eden.storage.redis import get_redis_client

        return await get_redis_client()
    except Exception:
        return None
