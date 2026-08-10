"""PagerDuty Events API v2 sender (FEAT-42).

``_dispatch_pagerduty`` in ``eden.realtime.alert_stream`` and the
``pagerduty`` branch of ``AnomalyDetector.dispatch_alerts`` in
``eden.data_platform.anomaly_alerts`` were both two-line no-ops: a log
statement, no HTTP call, no config lookup. ``AlertChannel.PAGERDUTY`` is
wired into the P0 ``rule_sandbox_escape`` rule and into FEAT-40's
critical-severity anomaly routing, so those alerts were silently
dropped on the floor.

This module is the real sender both call sites now use. It POSTs to
PagerDuty's Events API v2 (``https://events.pagerduty.com/v2/enqueue``)
per https://developer.pagerduty.com/docs/events-api-v2/trigger-events/.
Auth is via the ``routing_key`` in the request body — PagerDuty does not
require HMAC-signed requests the way our outbound customer webhooks do
(``eden.services.webhook_delivery.WebhookSigner``), so there's nothing to
sign here. What *is* reused from ``webhook_delivery`` is the resilience
machinery:

* the same retry ladder (``_RETRY_DELAYS`` — ``0s,1s,5s,25s,2m,10m,1h``)
  so a transient PagerDuty outage doesn't drop a P0 alert;
* the same "schedule the next attempt via ``loop.call_later`` and return"
  pattern (DL-5 in ``webhook_delivery``) so a security-critical alert
  dispatch never blocks the caller for up to an hour;
* a DLQ (``pagerduty_dlq`` — see migration
  ``150_pagerduty_integration``) once the ladder is exhausted, mirroring
  ``webhook_dlq``, for on-call visibility into events that never got
  through.

Not reused: ``_assert_public_ip`` SSRF re-resolution. That guard exists
because customer-configured webhook URLs are untrusted input; the
PagerDuty Events API URL is a fixed, hardcoded PagerDuty endpoint, not
user-supplied, so SSRF doesn't apply here.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from eden.services.webhook_delivery import _RETRY_DELAYS

logger = logging.getLogger(__name__)

PAGERDUTY_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue"

# PagerDuty Events API v2 only accepts these four severities.
_PD_SEVERITY_MAP = {
    "critical": "critical",
    "high": "error",
    "error": "error",
    "warning": "warning",
    "info": "info",
    "debug": "info",
}


def _to_pd_severity(severity: str) -> str:
    return _PD_SEVERITY_MAP.get(str(severity).lower(), "warning")


def _build_payload(
    *,
    routing_key: str,
    event_action: str,
    summary: str,
    source: str,
    severity: str,
    dedup_key: str | None,
    custom_details: dict[str, Any] | None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "routing_key": routing_key,
        "event_action": event_action,
        "client": "Eden",
    }
    if dedup_key:
        body["dedup_key"] = dedup_key
    if event_action == "trigger":
        body["payload"] = {
            "summary": summary[:1024] or "Eden alert",
            "source": source or "eden",
            "severity": _to_pd_severity(severity),
            "timestamp": datetime.now(UTC).isoformat(),
            "custom_details": custom_details or {},
        }
    return body


async def _post_once(body: dict[str, Any]) -> tuple[bool, int | None, str | None]:
    """One HTTP attempt. Returns (success, http_status, error_text)."""
    try:
        from eden.util.shared_http import shared_httpx_ctx
    except ImportError as exc:
        return False, None, str(exc)
    try:
        async with shared_httpx_ctx(timeout=10.0) as client:
            resp = await client.post(
                PAGERDUTY_EVENTS_URL,
                content=json.dumps(body).encode("utf-8"),
                headers={"Content-Type": "application/json"},
            )
        ok = 200 <= resp.status_code < 300
        return ok, resp.status_code, None if ok else resp.text[:2048]
    except Exception as exc:  # noqa: BLE001
        return False, None, str(exc)


async def _dlq(
    body: dict[str, Any],
    *,
    org_id: str | None,
    error_message: str | None,
    attempt_count: int,
) -> None:
    """Persist an exhausted-retry send to ``pagerduty_dlq``."""
    try:
        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()
        if pg is None:
            return
        payload = body.get("payload") or {}
        await pg.execute(
            """
            INSERT INTO pagerduty_dlq
                (id, org_id, event_action, dedup_key, summary, payload,
                 error_message, attempt_count)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            """,
            str(uuid.uuid4()),
            org_id,
            body.get("event_action", "trigger"),
            body.get("dedup_key"),
            str(payload.get("summary", ""))[:1024],
            json.dumps(body),
            error_message,
            attempt_count,
        )
    except Exception as exc:  # noqa: BLE001
        # DLQ insert is best-effort; the ERROR log below is the
        # guaranteed on-call signal even if Postgres is down.
        logger.debug("pagerduty_delivery: DLQ insert failed: %s", exc)


async def _retry_until_dlq(
    body: dict[str, Any],
    *,
    org_id: str | None,
    attempt: int,
    last_error: str | None,
) -> None:
    """Background continuation of the retry ladder after attempt 0 failed.

    Mirrors webhook_delivery's DL-5 pattern: each failed attempt
    schedules the next one via ``call_later`` rather than sleeping
    inline, so nothing blocks on a PagerDuty outage.
    """
    if attempt >= len(_RETRY_DELAYS):
        logger.error(
            "pagerduty_delivery: all %d attempts exhausted, DLQ'd "
            "(org_id=%s, dedup_key=%s): %s",
            len(_RETRY_DELAYS),
            org_id,
            body.get("dedup_key"),
            last_error,
        )
        await _dlq(body, org_id=org_id, error_message=last_error, attempt_count=attempt)
        return

    delay = _RETRY_DELAYS[attempt]
    ok, status, error_text = await _post_once(body)
    if ok:
        logger.info(
            "pagerduty_delivery: send succeeded on attempt %d (dedup_key=%s)",
            attempt + 1,
            body.get("dedup_key"),
        )
        return

    err = f"HTTP {status}: {error_text}" if status else (error_text or "unknown error")
    # 4xx other than 429 means the request itself is malformed (bad
    # routing key, bad payload) — retrying won't help.
    if status is not None and 400 <= status < 500 and status != 429:
        logger.error(
            "pagerduty_delivery: non-retryable %s, DLQ'd (org_id=%s): %s",
            status,
            org_id,
            err,
        )
        await _dlq(body, org_id=org_id, error_message=err, attempt_count=attempt + 1)
        return

    next_attempt = attempt + 1
    logger.warning(
        "pagerduty_delivery: attempt %d failed (%s), retrying in %ss",
        attempt + 1,
        err,
        delay,
    )
    loop = asyncio.get_event_loop()
    loop.call_later(
        delay,
        lambda: asyncio.ensure_future(
            _retry_until_dlq(
                body, org_id=org_id, attempt=next_attempt, last_error=err
            )
        ),
    )


async def send_pagerduty_event(
    *,
    org_id: str | None,
    summary: str,
    source: str,
    severity: str,
    dedup_key: str | None = None,
    event_action: str = "trigger",
    custom_details: dict[str, Any] | None = None,
) -> bool:
    """Send one PagerDuty Events API v2 event.

    Resolves the org's routing key (falling back to the platform-level
    key — see ``eden.integrations.pagerduty.store.get_routing_key``);
    if none is configured this is a documented, logged no-op, same as
    the webhook channel's ``not_configured`` skip.

    Returns ``True`` only if the *first* attempt succeeded — retries
    after that happen in the background via the retry ladder and end
    in ``pagerduty_dlq`` if the ladder is exhausted, so callers should
    treat ``False`` as "queued for retry", not "definitely failed".
    """
    from eden.integrations.pagerduty.store import get_routing_key

    routing_key = await get_routing_key(org_id)
    if not routing_key:
        logger.info("PagerDuty alert skipped:not_configured: %s", summary)
        return False

    body = _build_payload(
        routing_key=routing_key,
        event_action=event_action,
        summary=summary,
        source=source,
        severity=severity,
        dedup_key=dedup_key,
        custom_details=custom_details,
    )

    ok, status, error_text = await _post_once(body)
    if ok:
        return True

    err = f"HTTP {status}: {error_text}" if status else (error_text or "unknown error")
    logger.warning("pagerduty_delivery: first attempt failed (%s), scheduling retries", err)
    asyncio.ensure_future(
        _retry_until_dlq(body, org_id=org_id, attempt=1, last_error=err)
    )
    return False


__all__ = ["send_pagerduty_event", "PAGERDUTY_EVENTS_URL"]
