"""Sparse email alerts (replaces Slack paging).

Sends only high-signal events:
- P0/P1 issue created
- first-ever issue detected per org (any severity, OOM W2-7)
- verify failed
- human escalation
- NL real_incident (confidence >= 0.7)
- budget hard-limit (100%) breach

Uses Redis SETNX dedupe + hourly org cap from Settings
(``issue_alert_dedup_minutes``, ``issue_alert_max_per_hour``).
From-address is always ``alerts@edenobservability.com`` via
``EmailService(purpose="alert")``.

OOM W2-7 (finding O5): first-detection email
  State lives in ``organizations.settings`` JSONB:
    ``first_detection_email_sent``     – durable "already sent" flag
    ``first_detection_email_opt_out``  – set by the tour opt-out checkbox
  A 24-hour Redis burst-dedupe (``eden:alert_email:first_detection:{org_id}``)
  prevents a flood when many issues arrive simultaneously before the durable
  flag is written.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from eden.config import get_settings
from eden.services.email_service import get_email_service

logger = logging.getLogger(__name__)

_MAX_RECIPIENTS = 25


def _parse_org_settings(raw: Any) -> dict[str, Any]:
    if raw is None:
        return {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return {}
    return raw if isinstance(raw, dict) else {}


async def _org_extra_alert_recipients(org_id: str) -> list[str]:
    """Org-level soft-alert emails from ``organizations.settings`` (FEAT-106)."""
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return []
        row = await client.fetchrow(
            "SELECT settings FROM organizations WHERE id = $1",
            org_id,
        )
        settings = _parse_org_settings(row["settings"] if row else None)
        emails: list[str] = []
        for key in ("budget_alert_emails", "soft_alert_recipients"):
            val = settings.get(key)
            if isinstance(val, list):
                emails.extend(str(e).strip() for e in val if e)
        return emails
    except Exception as exc:  # noqa: BLE001
        logger.debug("alert_email: extra recipient lookup failed: %s", exc)
        return []


async def _org_alert_recipients(org_id: str) -> list[str]:
    """Resolve owner/admin emails plus org settings extras (best-effort)."""
    admins: list[str] = []
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
            ORDER BY u.email ASC
            LIMIT 10
            """,
            org_id,
        )
        admins = [str(r["email"]) for r in rows if r.get("email")]
    except Exception as exc:  # noqa: BLE001
        logger.debug("alert_email: recipient lookup failed: %s", exc)

    extras = await _org_extra_alert_recipients(org_id)
    seen: set[str] = set()
    merged: list[str] = []
    for email in [*admins, *extras]:
        key = email.lower()
        if not key or key in seen:
            continue
        seen.add(key)
        merged.append(email)
        if len(merged) >= _MAX_RECIPIENTS:
            break
    return merged


# ---------------------------------------------------------------------------
# OOM W2-7 — org-level notification-prefs helpers (first-detection email)
# ---------------------------------------------------------------------------

async def _get_org_setting(org_id: str, key: str) -> Any:
    """Read a single key from ``organizations.settings`` JSONB (best-effort)."""
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return None
        row = await client.fetchrow(
            "SELECT settings FROM organizations WHERE id = $1",
            org_id,
        )
        settings = _parse_org_settings(row["settings"] if row else None)
        return settings.get(key)
    except Exception as exc:  # noqa: BLE001
        logger.debug("alert_email: org setting read failed key=%s: %s", key, exc)
        return None


async def _set_org_setting(org_id: str, key: str, value: Any) -> None:
    """Atomically merge ``{key: value}`` into ``organizations.settings`` JSONB."""
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return
        await client.execute(
            "UPDATE organizations "
            "SET settings = COALESCE(settings, '{}'::jsonb) || $1::jsonb "
            "WHERE id = $2",
            json.dumps({key: value}),
            org_id,
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("alert_email: org setting write failed key=%s: %s", key, exc)


async def _should_send_first_detection_email(org_id: str) -> bool:
    """True when the org should receive its first-detection email.

    Returns False when the org has opted out (``first_detection_email_opt_out``
    is truthy in org settings) or has already received one
    (``first_detection_email_sent`` is truthy).  Fails open so a Postgres
    outage does not permanently silence new-org notifications.
    """
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return True  # fail-open
        row = await client.fetchrow(
            "SELECT settings FROM organizations WHERE id = $1",
            org_id,
        )
        settings = _parse_org_settings(row["settings"] if row else None)
        if settings.get("first_detection_email_opt_out", False):
            return False
        if settings.get("first_detection_email_sent", False):
            return False
        return True
    except Exception as exc:  # noqa: BLE001
        logger.debug(
            "alert_email: first-detection eligibility check failed: %s", exc
        )
        return True  # fail-open


async def _allow_first_detection_send(org_id: str) -> bool:
    """24-hour Redis burst-dedupe for the first-detection email.

    Uses SETNX with a 24-hour TTL so a burst of simultaneous low-severity
    issues for the same org only triggers one send while the durable
    ``first_detection_email_sent`` flag is being persisted.  Fails open
    if Redis is unavailable.
    """
    try:
        from eden.storage.redis import get_redis_client

        redis = await get_redis_client()
        if redis is None:
            return True
        key = f"eden:alert_email:first_detection:{org_id}"  # OOM W2-7
        ok = await redis.set(key, "1", nx=True, ex=86400)  # 24 h
        return bool(ok)
    except Exception as exc:  # noqa: BLE001
        logger.debug(
            "alert_email: first-detection redis dedupe skipped: %s", exc
        )
        return True  # fail-open


async def _mark_first_detection_sent(org_id: str) -> None:
    """Durably record that the first-detection email was sent (OOM W2-7)."""
    await _set_org_setting(org_id, "first_detection_email_sent", True)


# ---------------------------------------------------------------------------

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

    # OOM W2-7: guard early — log explicitly when the key is absent so the
    # silence is visible in logs rather than swallowed inside EmailService.
    _api_key = (getattr(get_settings(), "sendkit_api_key", None) or "").strip()
    if not _api_key:
        logger.info(  # OOM W2-7
            "alert_email: send skipped org=%s event=%s — sendkit_api_key not configured",
            org_id,
            kind,
        )
        return

    is_issue_created = kind in ("issue_created", "created")
    is_high_severity = sev in ("P0", "P1", "CRITICAL", "HIGH")

    # OOM W2-7: first-detection path — send once per org for any severity,
    # bypassing the normal P0/P1-only gate.
    _first_detection = False
    if is_issue_created and not is_high_severity:
        if not await _should_send_first_detection_email(org_id):
            return  # already sent or opted out
        if not await _allow_first_detection_send(org_id):
            return  # 24-hour burst-dedupe
        await _mark_first_detection_sent(org_id)
        _first_detection = True

    # Sparse policy: only P0/P1 for non-first-detection issue_created.
    if is_issue_created and not is_high_severity and not _first_detection:
        return

    dedupe = f"{kind}:{issue_id or 'none'}:{sev}"
    if not _first_detection and not await _allow_send(org_id, dedupe):
        return

    recipients = await _org_alert_recipients(org_id)
    if not recipients:
        logger.debug("alert_email: no recipients for org=%s", org_id)
        return

    subject_title = title or f"Eden {kind.replace('_', ' ')}"
    if _first_detection:  # OOM W2-7
        subject = f"[Eden] First issue detected in your project — {subject_title}"
    else:
        subject = f"[Eden {sev or 'ALERT'}] {subject_title}"
    body_lines = [
        f"<p><strong>Event:</strong> {kind}</p>",
        f"<p><strong>Org:</strong> {org_id}</p>",
    ]
    if _first_detection:  # OOM W2-7
        body_lines.insert(
            0,
            "<p><strong>Eden detected an issue in your project for the first time."
            "</strong> You will receive future alerts only for P0/P1 severity issues.</p>",
        )
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


_NL_INCIDENT_MESSAGING_CHANNELS = ("email", "slack", "pagerduty")


def _nl_incident_channel_flags(channels: dict[str, Any] | None) -> tuple[bool, bool, bool]:
    """Resolve (send_email, send_slack, send_pagerduty) from a
    ``nl_alert_rules.channels`` dict (see ``eden.alerts.repo``).

    Each key is an independent on/off toggle (a rule can page both
    Slack and email), matching the portal's create-rule form which
    saves ``{"email": <bool>, "slack": <bool>}``. Backward compatible:
    when the rule has no messaging channel explicitly configured
    (``channels`` is ``None``/empty, or only carries non-messaging
    keys such as the storage default ``{"in_app": true}``), the
    pre-FEAT-43 behaviour of a single email send is preserved.
    """
    channels = channels or {}
    explicitly_configured = any(k in channels for k in _NL_INCIDENT_MESSAGING_CHANNELS)
    send_email = bool(channels.get("email")) if explicitly_configured else True
    send_slack = bool(channels.get("slack"))
    send_pagerduty = bool(channels.get("pagerduty"))
    return send_email, send_slack, send_pagerduty


async def _send_nl_incident_slack(
    *,
    org_id: str,
    alert_event_id: str,
    rule_name: str,
    reason: str | None,
    confidence: float | None,
) -> None:
    try:
        from eden.services.slack_notify import notify_nl_incident

        await notify_nl_incident(
            org_id,
            alert_event_id=alert_event_id,
            rule_name=rule_name,
            reason=reason,
            confidence=confidence,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("alert_email: nl incident slack dispatch failed: %s", exc)


async def _send_nl_incident_pagerduty(
    *,
    org_id: str,
    alert_event_id: str,
    rule_name: str,
    reason: str | None,
    confidence: float | None,
) -> None:
    try:
        from eden.services.pagerduty_delivery import send_pagerduty_event

        await send_pagerduty_event(
            org_id=org_id,
            summary=f"NL alert real incident: {rule_name}"[:1024],
            source="eden-nl-alerts",
            severity="critical" if (confidence or 0) >= 0.9 else "error",
            dedup_key=f"nl_incident:{alert_event_id}",
            custom_details={
                "rule_name": rule_name,
                "reason": reason or "n/a",
                "confidence": confidence,
                "alert_event_id": alert_event_id,
            },
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("alert_email: nl incident pagerduty dispatch failed: %s", exc)


async def send_nl_incident_email(
    *,
    org_id: str,
    alert_event_id: str,
    rule_name: str,
    reason: str | None = None,
    confidence: float | None = None,
    channels: dict[str, Any] | None = None,
) -> None:
    """Route an NL alert real_incident verdict to its configured
    channels (FEAT-43).

    ``channels`` is the rule's stored ``nl_alert_rules.channels``
    dict — see :func:`_nl_incident_channel_flags` for the toggle
    semantics. Despite the function's (legacy) name, this is now the
    single dispatch entrypoint for NL-alert paging: it may also send
    to Slack and/or PagerDuty, in addition to or instead of email,
    depending on ``channels``. Each channel send is independently
    best-effort — a Slack/PagerDuty failure never blocks email, and
    vice versa.
    """
    send_email, send_slack, send_pagerduty = _nl_incident_channel_flags(channels)

    if send_slack:
        await _send_nl_incident_slack(
            org_id=org_id,
            alert_event_id=alert_event_id,
            rule_name=rule_name,
            reason=reason,
            confidence=confidence,
        )
    if send_pagerduty:
        await _send_nl_incident_pagerduty(
            org_id=org_id,
            alert_event_id=alert_event_id,
            rule_name=rule_name,
            reason=reason,
            confidence=confidence,
        )

    if not send_email:
        return

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
