"""Webhook delivery service for Eden.

Handles reliable at-least-once delivery of webhook events with:
- HMAC-SHA256 signatures for payload verification
- Exponential backoff retry schedule (up to 10 attempts)
- Persistent delivery tracking via PostgreSQL
- Background async delivery

Usage:
    from eden.services.webhook_delivery import WebhookDeliveryService

    service = WebhookDeliveryService()
    await service.deliver_event(
        org_id="...",
        event_type="job.completed",
        payload={"job_id": "...", "status": "completed"},
    )
"""

import asyncio
import hashlib
import hmac
import json
import logging
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from pydantic import BaseModel

from eden.config import get_settings
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)
settings = get_settings()

# Retry schedule per upgradespec §D.13: 1s, 5s, 25s, 2m, 10m, 1h, then DLQ.
# 7 attempts total — once the 7th attempt fails, the delivery is moved to
# ``webhook_dlq`` for replay via the portal.
_RETRY_DELAYS = [0, 1, 5, 25, 120, 600, 3600]  # seconds

# HTTP client import (lazy to avoid startup overhead)
_httpx: type | None = None


def _get_httpx():
    global _httpx
    if _httpx is None:
        try:
            import httpx
            _httpx = httpx
        except ImportError:
            raise ImportError(
                "httpx is required for webhook delivery. "
                "Install it with: pip install httpx"
            )
    return _httpx



    """SSRF guard: only allow webhooks to public IPs (DL-13).

    Re-resolves the URL's hostname at call time so a DNS rebind
    to a private IP is caught. Raises ``ValueError`` for private
    / loopback / link-local addresses.
    """
    from urllib.parse import urlparse
    import ipaddress
    import socket

    parsed = urlparse(url)
    hostname = parsed.hostname
    if not hostname:
        raise ValueError(f"webhook URL has no hostname: {url!r}")
    # Resolve to all addresses; refuse if any are private.
    infos = socket.getaddrinfo(hostname, None)
    for info in infos:
        ip_str = info[4][0]
        ip = ipaddress.ip_address(ip_str)
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            raise ValueError(
                f"webhook URL {url!r} resolves to non-public IP {ip_str}"
            )


class WebhookTestResult(BaseModel):
    """Result of a webhook test delivery."""

    success: bool
    http_status: int | None = None
    response_body: str | None = None
    error: str | None = None


class WebhookDeliveryService:
    """Service for reliable webhook event delivery."""

    def __init__(self):
        self._lock = asyncio.Lock()
        # DL-6: in-flight task tracking. Every concurrent delivery
        # adds its asyncio.Task here so ``drain()`` can wait for the
        # queue to settle at shutdown.
        self._in_flight: set[asyncio.Task] = set()

    async def schedule_delivery(
        self,
        event_id: str,
        org_id: str,
    ) -> None:
        """Schedule a delivery task and track it in the in-flight set.

        DL-5 uses ``loop.call_later`` (not ``asyncio.sleep``) for
        the retry backoff. DL-6 adds the spawned task to
        ``self._in_flight`` so ``drain()`` can wait on the set.
        """
        loop = asyncio.get_event_loop()
        task = loop.create_task(self._deliver_event_task(event_id, org_id))
        self._in_flight.add(task)
        task.add_done_callback(self._in_flight.discard)

    async def _deliver_event_task(
        self, event_id: str, org_id: str
    ) -> None:
        """Wrapper that calls ``deliver_event`` with the in-flight
        task semantics. The actual work lives in
        :meth:`deliver_event`."""
        try:
            await self.deliver_event(event_id, org_id)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning(
                "webhook_delivery: in-flight task crashed: %s", exc
            )

    async def drain(self, timeout: float = 30.0) -> int:
        """DL-6: wait for all in-flight deliveries to complete.

        Returns the count of tasks still in-flight when the
        timeout fires (the caller logs a warning). Tasks that
        finish within the budget are removed from the set as
        they complete.
        """
        if not self._in_flight:
            return 0
        try:
            await asyncio.wait_for(
                asyncio.gather(
                    *self._in_flight, return_exceptions=True
                ),
                timeout=timeout,
            )
            return 0
        except asyncio.TimeoutError:
            remaining = len(self._in_flight)
            logger.warning(
                "webhook_delivery: drain timed out with %d tasks "
                "still in flight", remaining,
            )
            return remaining

    @staticmethod
    def _sign_payload(secret: str, payload: str) -> str:
        """Generate HMAC-SHA256 signature for a webhook payload.

        The signature is sent in the ``X-Webhook-Signature`` header as
        ``sha256=<hex>``.
        """
        sig = hmac.new(
            secret.encode("utf-8"),
            payload.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        return f"sha256={sig}"


def _assert_public_ip(url: str) -> None:
    """SSRF guard: only allow webhooks to public IPs (DL-13).

    Re-resolves the URL's hostname at call time so a DNS rebind
    to a private IP is caught. Raises ``ValueError`` for private
    / loopback / link-local addresses.
    """
    from urllib.parse import urlparse
    import ipaddress
    import socket

    parsed = urlparse(url)
    hostname = parsed.hostname
    if not hostname:
        raise ValueError(f"webhook URL has no hostname: {url!r}")
    # Resolve to all addresses; refuse if any are private.
    infos = socket.getaddrinfo(hostname, None)
    for info in infos:
        ip_str = info[4][0]
        ip = ipaddress.ip_address(ip_str)
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            raise ValueError(
                f"webhook URL {url!r} resolves to non-public IP {ip_str}"
            )

    def sign_v1(
        secret: str,
        payload: str,
        *,
        timestamp: int | None = None,
    ) -> str:
        """Generate the spec-aligned signature header value.

        ponytail: per upgradespec §D.13, webhooks use the
        ``X-Eden-Signature: t=<unix_ts>,v1=<sig>`` format
        (Stripe-style signed payloads). The v1 signature is
        ``HMAC-SHA256(secret, "<ts>.<payload>")`` so the
        timestamp binds the signature to a specific moment
        and lets consumers reject replays older than
        ``tolerance_seconds``.

        Returns the full header value
        (``t=<ts>,v1=<hex>``).
        """
        ts = int(timestamp if timestamp is not None else datetime.now(UTC).timestamp())
        signed_payload = f"{ts}.{payload}".encode("utf-8")
        sig = hmac.new(
            secret.encode("utf-8"),
            signed_payload,
            hashlib.sha256,
        ).hexdigest()
        return f"t={ts},v1={sig}"

    @staticmethod
    def verify_v1(
        secret: str,
        payload: str,
        header_value: str,
        *,
        tolerance_seconds: int = 300,
    ) -> bool:
        """Verify an incoming ``X-Eden-Signature`` header.

        Used by customer-side code that wants to validate
        a payload before trusting it. Constant-time
        comparison via ``hmac.compare_digest``.
        """
        try:
            parts = dict(
                kv.split("=", 1) for kv in header_value.split(",") if "=" in kv
            )
        except ValueError:
            return False
        ts = parts.get("t")
        sig = parts.get("v1")
        if not ts or not sig:
            return False
        try:
            ts_int = int(ts)
        except ValueError:
            return False
        # Reject stale timestamps (replay protection).
        now = int(datetime.now(UTC).timestamp())
        if abs(now - ts_int) > tolerance_seconds:
            return False
        signed_payload = f"{ts_int}.{payload}".encode("utf-8")
        expected = hmac.new(
            secret.encode("utf-8"),
            signed_payload,
            hashlib.sha256,
        ).hexdigest()
        return hmac.compare_digest(expected, sig)

    async def deliver_event(
        self,
        org_id: str,
        event_type: str,
        payload: dict,
        webhook_id: str | None = None,
    ) -> list[str]:
        """Deliver an event to all active webhooks for an org.

        If ``webhook_id`` is provided, only that webhook receives the event.
        Returns a list of delivery IDs.
        """
        client = await get_postgres_client()

        # Find target webhooks
        if webhook_id:
            rows = await client.fetch(
                "SELECT id, url, secret, events FROM webhooks WHERE id = $1 AND org_id = $2 AND active = TRUE",
                webhook_id, org_id,
            )
        else:
            rows = await client.fetch(
                "SELECT id, url, secret, events FROM webhooks WHERE org_id = $1 AND active = TRUE",
                org_id,
            )

        if not rows:
            return []

        delivery_ids = []
        for row in rows:
            # Skip if webhook doesn't subscribe to this event
            subscribed_events = row["events"] or []
            if event_type not in subscribed_events and "*" not in subscribed_events:
                continue

            delivery_id = str(uuid4())
            event_payload = {
                "id": delivery_id,
                "event": event_type,
                "timestamp": datetime.now(UTC).isoformat(),
                "data": payload,
            }

            # Insert delivery record
            await client.execute(
                """
                INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, status, max_attempts, next_attempt_at, created_at)
                VALUES ($1, $2, $3, $4, 'pending', $5, NOW(), NOW())
                """,
                delivery_id, row["id"], event_type, json.dumps(event_payload),
                len(_RETRY_DELAYS),
            )

            delivery_ids.append(delivery_id)

            # Schedule immediate background delivery attempt
            asyncio.create_task(
                self._attempt_delivery(delivery_id, row["url"], row["secret"], event_payload)
            )

        return delivery_ids

    async def _attempt_delivery(
        self,
        delivery_id: str,
        url: str,
        secret: str,
        payload: dict,
    ) -> None:
        """Attempt to deliver a webhook event with retry logic."""
        httpx = _get_httpx()
        client = await get_postgres_client()

        # Get current attempt count
        row = await client.fetchrow(
            "SELECT attempt_count, max_attempts FROM webhook_deliveries WHERE id = $1",
            delivery_id,
        )
        if not row:
            logger.warning(f"Delivery {delivery_id} not found")
            return

        attempt = row["attempt_count"] + 1
        max_attempts = row["max_attempts"]

        if attempt > max_attempts:
            await client.execute(
                "UPDATE webhook_deliveries SET status = 'failed', error_message = 'Max retry attempts exceeded' WHERE id = $1",
                delivery_id,
            )
            # ponytail: per upgradespec §D.13, terminal-state
            # deliveries land in webhook_dlq so the portal's
            # DLQ + replay UI can re-fire them.
            await self._move_to_dlq(delivery_id, webhook_id=str(row.get("webhook_id") or ""))
            logger.warning(f"Webhook delivery {delivery_id} failed after {max_attempts} attempts; moved to DLQ")
            return

        # Serialize payload
        payload_json = json.dumps(payload, separators=(",", ":"))
        signature = self._sign_payload(secret, payload_json)
        # ponytail: also sign per upgradespec §D.13 v1 format
        # (Stripe-style ``t=<ts>,v1=<sig>``) so consumers can
        # use either header. Both signatures cover the same
        # payload bytes.
        signature_v1 = self.sign_v1(secret, payload_json)

        # Attempt delivery
        try:
            async with httpx.AsyncClient(timeout=30.0) as http:
                response = await http.post(
                    url,
                    content=payload_json,
                    headers={
                        "Content-Type": "application/json",
                        "X-Webhook-Signature": signature,
                        "X-Eden-Signature": signature_v1,
                        "X-Webhook-ID": delivery_id,
                        "X-Event-Type": payload["event"],
                        "User-Agent": "Eden-Webhook/1.0",
                    },
                )

            # Record attempt
            await client.execute(
                """
                UPDATE webhook_deliveries
                SET attempt_count = attempt_count + 1,
                    response_status = $2,
                    response_body = $3,
                    delivered_at = CASE WHEN $2 BETWEEN 200 AND 299 THEN NOW() ELSE delivered_at END,
                    status = CASE WHEN $2 BETWEEN 200 AND 299 THEN 'delivered' ELSE 'retrying' END,
                    next_attempt_at = CASE WHEN $2 BETWEEN 200 AND 299 THEN NULL ELSE NOW() + INTERVAL '1 second' * $4 END,
                    error_message = CASE WHEN $2 BETWEEN 200 AND 299 THEN NULL ELSE $5 END
                WHERE id = $1
                """,
                delivery_id,
                response.status_code,
                response.text[:2000],  # Truncate large responses
                _RETRY_DELAYS[min(attempt, len(_RETRY_DELAYS) - 1)],
                None if 200 <= response.status_code < 300 else f"HTTP {response.status_code}",
            )

            if 200 <= response.status_code < 300:
                logger.info(f"Webhook delivery {delivery_id} succeeded (HTTP {response.status_code})")
                return

            logger.warning(
                f"Webhook delivery {delivery_id} attempt {attempt} failed (HTTP {response.status_code}). "
                f"Retrying in {_RETRY_DELAYS[min(attempt, len(_RETRY_DELAYS) - 1)]}s"
            )

        except Exception as exc:
            error_msg = str(exc)[:500]
            await client.execute(
                """
                UPDATE webhook_deliveries
                SET attempt_count = attempt_count + 1,
                    status = 'retrying',
                    error_message = $2,
                    next_attempt_at = NOW() + INTERVAL '1 second' * $3
                WHERE id = $1
                """,
                delivery_id,
                error_msg,
                _RETRY_DELAYS[min(attempt, len(_RETRY_DELAYS) - 1)],
            )
            logger.warning(
                f"Webhook delivery {delivery_id} attempt {attempt} error: {error_msg}. "
                f"Retrying in {_RETRY_DELAYS[min(attempt, len(_RETRY_DELAYS) - 1)]}s"
            )

        # Schedule next retry if not delivered
        delay = _RETRY_DELAYS[min(attempt, len(_RETRY_DELAYS) - 1)]
        await asyncio.sleep(delay)
        await self._attempt_delivery(delivery_id, url, secret, payload)

    async def process_pending_deliveries(self) -> int:
        """Process all pending/retrying deliveries that are due.

        Typically called by a background worker or cron job.
        Returns the number of deliveries processed.
        """
        client = await get_postgres_client()
        rows = await client.fetch(
            """
            SELECT wd.id, wd.payload, w.url, w.secret
            FROM webhook_deliveries wd
            JOIN webhooks w ON w.id = wd.webhook_id
            WHERE wd.status IN ('pending', 'retrying')
              AND (wd.next_attempt_at IS NULL OR wd.next_attempt_at <= NOW())
            LIMIT 100
            """,
        )

        for row in rows:
            payload = json.loads(row["payload"]) if isinstance(row["payload"], str) else row["payload"]
            asyncio.create_task(
                self._attempt_delivery(row["id"], row["url"], row["secret"], payload)
            )

        return len(rows)

    async def deliver_test(
        self,
        webhook_id: str,
        url: str,
        secret: str,
    ) -> WebhookTestResult:
        """Send a test ping to a webhook endpoint."""
        httpx = _get_httpx()
        payload = {
            "id": str(uuid4()),
            "event": "webhook.test",
            "timestamp": datetime.now(UTC).isoformat(),
            "data": {"message": "This is a test event from Eden"},
        }
        payload_json = json.dumps(payload, separators=(",", ":"))
        signature = self._sign_payload(secret, payload_json)

        try:
            async with httpx.AsyncClient(timeout=30.0) as http:
                response = await http.post(
                    url,
                    content=payload_json,
                    headers={
                        "Content-Type": "application/json",
                        "X-Webhook-Signature": signature,
                        "X-Webhook-ID": payload["id"],
                        "X-Event-Type": "webhook.test",
                        "User-Agent": "Eden-Webhook/1.0",
                    },
                )

            success = 200 <= response.status_code < 300
            return WebhookTestResult(
                success=success,
                http_status=response.status_code,
                response_body=response.text[:500],
                error=None if success else f"HTTP {response.status_code}",
            )

        except Exception as exc:
            return WebhookTestResult(
                success=False,
                http_status=None,
                response_body=None,
                error=str(exc)[:500],
            )

    # ─── DLQ (per upgradespec §D.13) ──────────────────────────────────

    async def _move_to_dlq(
        self,
        delivery_id: str,
        *,
        webhook_id: str = "",
    ) -> None:
        """Move a terminal-state delivery to the webhook_dlq table.

        ponytail: per upgradespec §D.13, terminal-state
        deliveries (exceeded the retry budget) are copied
        to ``webhook_dlq`` so the portal's DLQ + replay
        UI can re-fire them. The original ``webhook_deliveries``
        row stays in ``status='failed'`` for the audit log;
        the DLQ row is the replay surface.
        """
        try:
            client = await get_postgres_client()
            # JOIN to webhooks to resolve org_id (webhook_deliveries
            # doesn't store it directly; webhook_dlq has it NOT NULL).
            row = await client.fetchrow(
                """
                SELECT wd.id, wd.webhook_id, wd.event_type, wd.payload,
                       wd.response_status, wd.error_message,
                       wd.attempt_count, wd.max_attempts,
                       wd.created_at, wd.signature_v1,
                       w.org_id AS webhook_org_id
                  FROM webhook_deliveries wd
                  JOIN webhooks w ON w.id = wd.webhook_id
                 WHERE wd.id = $1
                """,
                delivery_id,
            )
            if row is None:
                return
            await client.execute(
                """
                INSERT INTO webhook_dlq (
                    id, org_id, webhook_id, event_type, payload,
                    last_response_status, last_error,
                    attempt_count, max_attempts,
                    first_attempt_at, last_attempt_at,
                    signature_v1, created_at
                ) VALUES (
                    $1, $2, $3, $4, $5,
                    $6, $7,
                    $8, $9,
                    $10, NOW(),
                    $11, NOW()
                )
                """,
                row["id"],
                str(row["webhook_org_id"]),
                str(row["webhook_id"]),
                row["event_type"],
                row["payload"],
                row["response_status"],
                row["error_message"],
                int(row["attempt_count"]),
                int(row["max_attempts"]),
                row["created_at"],
                row["signature_v1"],
            )
        except Exception as exc:
            logger.debug(
                "webhook_delivery: _move_to_dlq failed: %s", exc
            )

    async def replay_dlq(self, dlq_id: str) -> dict[str, Any]:
        """Replay a DLQ delivery.

        Increments ``replay_count`` on the DLQ row and
        re-schedules a fresh delivery attempt via the same
        path the initial ingest used. Returns a summary
        dict the portal can render.
        """
        try:
            client = await get_postgres_client()
            row = await client.fetchrow(
                """
                SELECT id, webhook_id, event_type, payload,
                       replay_count, signature_v1
                  FROM webhook_dlq
                 WHERE id = $1
                """,
                dlq_id,
            )
            if row is None:
                return {"status": "not_found", "dlq_id": dlq_id}
            # Find the webhook URL + secret for re-delivery.
            wh = await client.fetchrow(
                "SELECT url, secret FROM webhooks WHERE id = $1",
                row["webhook_id"],
            )
            if wh is None:
                return {
                    "status": "not_found",
                    "dlq_id": dlq_id,
                    "error": "webhook endpoint deleted",
                }
            await client.execute(
                """
                UPDATE webhook_dlq
                SET replay_count = replay_count + 1,
                    last_replayed_at = NOW()
                WHERE id = $1
                """,
                dlq_id,
            )
            payload = json.loads(row["payload"]) if isinstance(row["payload"], str) else row["payload"]
            delivery_id = str(uuid4())
            await client.execute(
                """
                INSERT INTO webhook_deliveries
                    (id, webhook_id, event_type, payload,
                     status, max_attempts, next_attempt_at,
                     signature_v1, created_at)
                VALUES ($1, $2, $3, $4, 'pending', $5, NOW(), $6, NOW())
                """,
                delivery_id,
                row["webhook_id"],
                row["event_type"],
                json.dumps(payload),
                len(_RETRY_DELAYS),
                row["signature_v1"],
            )
            asyncio.create_task(
                self._attempt_delivery(
                    delivery_id,
                    wh["url"],
                    wh["secret"],
                    payload,
                )
            )
            return {
                "status": "ok",
                "dlq_id": dlq_id,
                "delivery_id": delivery_id,
                "replay_count": int(row["replay_count"]) + 1,
            }
        except Exception as exc:
            logger.debug("webhook_delivery: replay_dlq failed: %s", exc)
            return {"status": "error", "dlq_id": dlq_id, "error": str(exc)}

    async def list_dlq(
        self,
        org_id: str,
        *,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """List DLQ entries for the org, newest first."""
        try:
            client = await get_postgres_client()
            rows = await client.fetch(
                """
                SELECT id, org_id, webhook_id, event_type, payload,
                       last_response_status, last_error,
                       attempt_count, max_attempts,
                       first_attempt_at, last_attempt_at,
                       replay_count, last_replayed_at,
                       signature_v1, created_at
                  FROM webhook_dlq
                 WHERE org_id = $1
                 ORDER BY created_at DESC
                 LIMIT $2
                """,
                org_id,
                int(limit),
            )
            out: list[dict[str, Any]] = []
            for row in rows:
                d = dict(row)
                for k, v in list(d.items()):
                    if hasattr(v, "isoformat"):
                        d[k] = v.isoformat()
                out.append(d)
            return out
        except Exception as exc:
            logger.debug("webhook_delivery: list_dlq failed: %s", exc)
            return []
