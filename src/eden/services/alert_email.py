"""Sparse email alerts (replaces Slack paging).

Sends only high-signal events:
- P0/P1 issue created
- verify failed
- human escalation
- NL real_incident (confidence >= 0.7)
- budget hard-limit (100%) breach

Uses Redis SETNX dedupe + hourly org cap from Settings
(``issue_alert_dedup_minutes``, ``issue_alert_max_per_hour``).
From-address is always ``alerts@edenobservability.com`` via
``EmailService(purpose="alert")``.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.config import get_settings
from eden.services.email_service import get_email_service

logger = logging.getLogger(__name__)


async def _org_alert_recipients(org_id: str) -> list[str]:
    """Resolve owner/admin emails for an org (best-effort)."""
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return []
        rows = await client.fetch(
            """
            SELECT DISTINCT u.email
            FROM users u
            JOIN org_members m ON m.user_id = u.id
            WHERE m.org_id = $1
              AND m.role IN ('owner', 'admin')
              AND u.email IS NOT NULL
              AND u.email <> ''
            LIMIT 10
            """,
            org_id,
        )
        return [str(r["email"]) for r in rows if r.get("email")]
    except Exception as exc:  # noqa: BLE001
        logger.debug("alert_email: recipient lookup failed: %s", exc)
        return []


async def _allow_send(org_id: str, dedupe_key: str) -> bool:
    """Redis dedupe + hourly rate cap. Fail-open if Redis unavailable."""
    settings = get_settings()
    if not getattr(settings, "issue_alerts_enabled", True):
        return False
    try:
        from eden.storage.redis import get_redis_client

        redis = await get_redis_client()
        if redis is None:
            return True
        dedup_min = int(getattr(settings, "issue_alert_dedup_minutes", 15) or 15)
        max_per_hour = int(getattr(settings, "issue_alert_max_per_hour", 30) or 30)
        fingerprint = f"eden:alert_email:dedup:{org_id}:{dedupe_key}"
        ok = await redis.set(fingerprint, "1", nx=True, ex=max(60, dedup_min * 60))
        if not ok:
            return False
        hour_key = f"eden:alert_email:hour:{org_id}"
        count = await redis.incr(hour_key)
        if count == 1:
            await redis.expire(hour_key, 3600)
        return not count > max_per_hour
    except Exception as exc:  # noqa: BLE001
        logger.debug("alert_email: allow_send redis skipped: %s", exc)
        return True


async def send_issue_alert_email(
    *,
    org_id: str,
    event_kind: str,
    issue_id: str | None = None,
    severity: str | None = None,
    title: str | None = None,
    detail: str | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    """Send a sparse issue/closed-loop alert email to org admins."""
    sev = (severity or "").upper()
    kind = (event_kind or "").lower()

    # Sparse policy: only P0/P1 for issue_created; always allow verify/human.
    if kind in ("issue_created", "created") and sev not in ("P0", "P1", "CRITICAL", "HIGH"):
        return

    dedupe = f"{kind}:{issue_id or 'none'}:{sev}"
    if not await _allow_send(org_id, dedupe):
        return

    recipients = await _org_alert_recipients(org_id)
    if not recipients:
        logger.debug("alert_email: no recipients for org=%s", org_id)
        return

    subject_title = title or f"Eden {kind.replace('_', ' ')}"
    subject = f"[Eden {sev or 'ALERT'}] {subject_title}"
    body_lines = [
        f"<p><strong>Event:</strong> {kind}</p>",
        f"<p><strong>Org:</strong> {org_id}</p>",
    ]
    if issue_id:
        body_lines.append(f"<p><strong>Issue:</strong> {issue_id}</p>")
    if severity:
        body_lines.append(f"<p><strong>Severity:</strong> {severity}</p>")
    if detail:
        body_lines.append(f"<p>{detail}</p>")
    if extra:
        body_lines.append(f"<pre>{extra!s}</pre>")
    html = (
        "<html><body style='font-family:sans-serif;line-height:1.5'>"
        + "".join(body_lines)
        + "<p style='color:#666;font-size:12px'>You received this because you are an "
        "owner/admin of this Eden org. Alert volume is rate-limited.</p>"
        "</body></html>"
    )

    svc = get_email_service()
    for to in recipients:
        try:
            await svc.send_email(
                to_email=to,
                subject=subject,
                html_content=html,
                purpose="alert",
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("alert_email: send failed: %s", exc)


async def send_nl_incident_email(
    *,
    org_id: str,
    alert_event_id: str,
    rule_name: str,
    reason: str | None = None,
    confidence: float | None = None,
) -> None:
    """Email for NL alert real_incident verdicts (sparse)."""
    dedupe = f"nl:{alert_event_id}"
    if not await _allow_send(org_id, dedupe):
        return
    recipients = await _org_alert_recipients(org_id)
    if not recipients:
        return
    conf = f"{confidence:.2f}" if confidence is not None else "n/a"
    html = (
        "<html><body style='font-family:sans-serif;line-height:1.5'>"
        f"<p><strong>NL alert ruled a real incident</strong></p>"
        f"<p>Rule: {rule_name}</p>"
        f"<p>Confidence: {conf}</p>"
        f"<p>Reason: {reason or 'n/a'}</p>"
        f"<p>Event id: {alert_event_id}</p>"
        "<p style='color:#666;font-size:12px'>Rate-limited alert from Eden.</p>"
        "</body></html>"
    )
    svc = get_email_service()
    for to in recipients:
        await svc.send_email(
            to_email=to,
            subject=f"[Eden ALERT] Real incident: {rule_name}",
            html_content=html,
            purpose="alert",
        )


async def send_self_obs_degraded_email(
    *,
    org_id: str,
    component: str,
    status: str,
    detail: dict[str, Any] | None = None,
) -> None:
    """Email when a self-observability probe transitions to degraded/fail.

    Called by ``eden.self_obs.scheduler.run_scheduled_probes`` only on
    a state *transition* (healthy → degraded/fail) — this function's
    own dedupe window is a secondary safety net against duplicate
    sends for the same transition, not the primary anti-spam control.
    """
    dedupe = f"self_obs:{component}:{status}"
    if not await _allow_send(org_id, dedupe):
        return
    recipients = await _org_alert_recipients(org_id)
    if not recipients:
        logger.debug("alert_email: no recipients for self_obs alert org=%s", org_id)
        return

    html = (
        "<html><body style='font-family:sans-serif;line-height:1.5'>"
        "<p><strong>Eden self-observability probe degraded</strong></p>"
        f"<p><strong>Component:</strong> {component}</p>"
        f"<p><strong>Status:</strong> {status}</p>"
        f"<p><strong>Org:</strong> {org_id}</p>"
        f"<pre>{detail or {}}</pre>"
        "<p style='color:#666;font-size:12px'>Rate-limited alert from Eden "
        "self-monitoring.</p>"
        "</body></html>"
    )
    svc = get_email_service()
    for to in recipients:
        try:
            await svc.send_email(
                to_email=to,
                subject=f"[Eden ALERT] {component} degraded ({status})",
                html_content=html,
                purpose="alert",
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("alert_email: self_obs send failed: %s", exc)


async def send_budget_hard_limit_email(
    *,
    org_id: str,
    used: float,
    hard: float,
) -> None:
    """Email only on 100% hard-limit breach (skip soft 80%)."""
    dedupe = "budget:100"
    if not await _allow_send(org_id, dedupe):
        return
    recipients = await _org_alert_recipients(org_id)
    if not recipients:
        return
    html = (
        "<html><body style='font-family:sans-serif;line-height:1.5'>"
        "<p><strong>Budget hard limit reached (100%)</strong></p>"
        f"<p>Spend: ${used:.4f} / hard limit ${hard:.4f}</p>"
        f"<p>Org: {org_id}</p>"
        "</body></html>"
    )
    svc = get_email_service()
    for to in recipients:
        await svc.send_email(
            to_email=to,
            subject="[Eden ALERT] Budget hard limit reached",
            html_content=html,
            purpose="alert",
        )
