"""Webhook delivery service for Eden.

Handles reliable at-least-once delivery of webhook events with:
- HMAC-SHA256 signatures (Stripe-style ``X-Eden-Signature``)
- Exponential backoff retry schedule via ``loop.call_later``
- Persistent delivery tracking via PostgreSQL with atomic CAS
- In-flight task tracking + ``drain()`` for clean shutdown
- Delivery-time SSRF guard (re-resolves hostname to public IP)
- Dead-letter queue (DLQ) with bounded replay

Usage:
    from eden.services.webhook_delivery import WebhookDeliveryService

    service = WebhookDeliveryService()
    await service.deliver_event(
        event_id="...",
        org_id="...",
    )
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import json
import logging
import socket
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

from pydantic import BaseModel

from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

# Retry schedule per upgradespec §D.13: 0s, 1s, 5s, 25s, 2m, 10m, 1h, then DLQ.
# 7 attempts total — once the 7th attempt fails, the delivery is moved to
# ``webhook_dlq`` for replay via the portal.
_RETRY_DELAYS = [0, 1, 5, 25, 120, 600, 3600]  # seconds

# Replay controls (DL-8).
_MAX_REPLAY_COUNT = 3
_MIN_REPLAY_GAP_SECONDS = 60

# HTTP module reference, lazy-loaded to avoid startup overhead.
_httpx_mod = None


def _get_httpx():
    """Lazy import of httpx; raises if not installed."""
    global _httpx_mod
    if _httpx_mod is None:
        try:
            import httpx

            _httpx_mod = httpx
        except ImportError as exc:
            raise ImportError(
                "httpx is required for webhook delivery. "
                "Install it with: pip install httpx"
            ) from exc
    return _httpx_mod


def _assert_public_ip(url: str) -> None:
    """SSRF guard: only allow webhooks to public IPs (DL-13 / S-20).

    Re-resolves the URL's hostname at call time so a DNS rebind
    to a private IP is caught. Refuses:
      * non-https schemes
      * URLs without a hostname
      * hostnames that fail to resolve
      * resolved IPs that are private / loopback / link-local /
        multicast / reserved / unspecified
    """
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ValueError(
            f"webhook URL {url!r} has non-https scheme "
            f"{parsed.scheme!r}; only https is allowed"
        )
    hostname = parsed.hostname
    if not hostname:
        raise ValueError(f"webhook URL {url!r} has no hostname")
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror as exc:
        raise ValueError(
            f"webhook URL hostname {hostname!r} could not be "
            f"resolved: {exc}"
        ) from exc
    if not infos:
        raise ValueError(
            f"webhook URL hostname {hostname!r} resolved to "
            f"no addresses"
        )
    for info in infos:
        ip_str = info[4][0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            raise ValueError(
                f"webhook URL hostname {hostname!r} resolved to "
                f"non-IP value {ip_str!r}"
            )
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            raise ValueError(
                f"webhook URL {url!r} resolves to non-public IP "
                f"{ip_str}"
            )


class WebhookTestResult(BaseModel):
    """Result of a synchronous webhook test delivery."""

    success: bool
    http_status: int | None = None
    response_body: str | None = None
    error: str | None = None


class WebhookSigner:
    """HMAC-SHA256 webhook signer / verifier (Stripe-style v1)."""

    @staticmethod
    def sign_v1(
        secret: str,
        payload: str,
        *,
        timestamp: int | None = None,
    ) -> str:
        """Return ``t=<unix_ts>,v1=<hex>``.

        The v1 signature is ``HMAC-SHA256(secret, "<ts>.<payload>")``,
        so the timestamp binds the signature to a specific moment
        and lets consumers reject replays older than
        ``tolerance_seconds``.
        """
        ts = int(
            timestamp if timestamp is not None else datetime.now(UTC).timestamp()
        )
        signed_payload = f"{ts}.{payload}".encode()
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

        Used by customer-side code to validate a payload before
        trusting it. Constant-time comparison via
        ``hmac.compare_digest``.
        """
        try:
            parts = dict(
                kv.split("=", 1)
                for kv in header_value.split(",")
                if "=" in kv
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
        now = int(datetime.now(UTC).timestamp())
        if abs(now - ts_int) > tolerance_seconds:
            return False
        signed_payload = f"{ts_int}.{payload}".encode()
        expected = hmac.new(
            secret.encode("utf-8"),
            signed_payload,
            hashlib.sha256,
        ).hexdigest()
        return hmac.compare_digest(expected, sig)


class WebhookDeliveryService:
    """Service for reliable webhook event delivery."""

    # Audit 2026-07-03 B-25 — bound concurrent outbound deliveries
    # to the same value as httpx's default connection-pool size
    # (16). Without a semaphore, a webhook burst could open N
    # parallel connections per worker and pin the upstream at
    # the receiving end (Stripe / GitHub / Slack all rate-limit
    # at 16 simultaneous open sockets). Per-class so tests can
    # tune it without patching ``__init__``; not exposed at the
    # module level so external code can't accidentally raise it
    # past the upstream pools.
    _HTTP_CONCURRENCY = 16

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        # DL-6: in-flight task tracking. Every concurrent delivery
        # adds its asyncio.Task here so ``drain()`` can wait on
        # the queue at shutdown.
        self._in_flight: set[asyncio.Task] = set()
        # Shared HTTP client + concurrency cap (B-25 fix). Created
        # on first use so tests can patch ``_ensure_http_client``.
        self._http_client = None
        self._http_semaphore: asyncio.Semaphore | None = None

    # ─── public entry points ────────────────────────────────────────

    async def deliver_event(self, event_id: str, org_id: str) -> None:
        """Resolve an event row and schedule a delivery task.

        The actual delivery work runs in a tracked background
        task so the request handler can return immediately.
        """
        try:
            pg = await get_postgres_client()
            row = await pg.fetchrow(
                "SELECT id, webhook_id, url, secret, payload "
                "FROM webhook_events WHERE id = $1 AND org_id = $2",
                event_id,
                org_id,
            )
            if row is None:
                logger.warning(
                    "webhook_delivery.deliver_event: event %s not "
                    "found for org %s",
                    event_id,
                    org_id,
                )
                return
            await self._schedule_delivery(
                delivery_id=row["id"],
                url=row["url"],
                secret=row["secret"],
                payload=json.loads(row["payload"]) if row["payload"] else {},
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning(
                "webhook_delivery.deliver_event failed for %s: %s",
                event_id,
                exc,
            )

    async def deliver_test(
        self,
        *,
        webhook_id: str,
        url: str,
        secret: str,
    ) -> WebhookTestResult:
        """Synchronous test delivery (used by the portal
        "Send test event" button). No retry, no DLQ — fail-fast."""
        try:
            _assert_public_ip(url)
        except ValueError as exc:
            return WebhookTestResult(success=False, error=str(exc))
        try:
            httpx = _get_httpx()
        except ImportError as exc:
            return WebhookTestResult(success=False, error=str(exc))
        body = json.dumps(
            {
                "event_type": "webhook.test",
                "webhook_id": webhook_id,
                "ts": datetime.now(UTC).isoformat(),
            }
        ).encode("utf-8")
        signature = WebhookSigner.sign_v1(secret, body.decode("utf-8"))
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    url,
                    content=body,
                    headers={
                        "Content-Type": "application/json",
                        "X-Eden-Signature": signature,
                        "X-Eden-Event": "webhook.test",
                    },
                )
            return WebhookTestResult(
                success=200 <= resp.status_code < 300,
                http_status=resp.status_code,
                response_body=resp.text[:4096],
            )
        except Exception as exc:
            return WebhookTestResult(success=False, error=str(exc))

    async def list_dlq(
        self, org_id: str, *, limit: int = 50,
    ) -> list[dict[str, Any]]:
        """Return the most recent DLQ entries for ``org_id``."""
        pg = await get_postgres_client()
        rows = await pg.fetch(
            "SELECT id, webhook_id, event_type, payload, "
            "response_status, error_message, attempt_count, "
            "replay_count, last_replayed_at, created_at "
            "FROM webhook_dlq "
            "WHERE org_id = $1 "
            "ORDER BY created_at DESC "
            "LIMIT $2",
            org_id,
            max(1, min(limit, 500)),
        )
        return [dict(r) for r in rows]

    async def replay_dlq(self, dlq_id: str) -> dict[str, Any]:
        """Re-fire a DLQ entry. Caps replay_count at 3 and requires
        ≥60s since the last replay."""
        pg = await get_postgres_client()
        row = await pg.fetchrow(
            "SELECT id, webhook_id, event_type, payload, "
            "replay_count, signature_v1, last_replayed_at, "
            "EXTRACT(EPOCH FROM (NOW() - last_replayed_at)) "
            "  AS seconds_since_last_replay "
            "FROM webhook_dlq WHERE id = $1",
            dlq_id,
        )
        if row is None:
            return {"status": "not_found", "dlq_id": dlq_id}
        replay_count = int(row["replay_count"] or 0)
        if replay_count >= _MAX_REPLAY_COUNT:
            return {
                "status": "replay_cap_reached",
                "dlq_id": dlq_id,
                "replay_count": replay_count,
                "max_replay_count": _MAX_REPLAY_COUNT,
            }
        seconds_since = row["seconds_since_last_replay"]
        if (
            seconds_since is not None
            and float(seconds_since) < _MIN_REPLAY_GAP_SECONDS
        ):
            return {
                "status": "replay_rate_limited",
                "dlq_id": dlq_id,
                "seconds_since_last_replay": float(seconds_since),
                "min_replay_gap_seconds": _MIN_REPLAY_GAP_SECONDS,
            }
        wh = await pg.fetchrow(
            "SELECT url, secret FROM webhooks WHERE id = $1",
            row["webhook_id"],
        )
        if wh is None:
            return {
                "status": "webhook_not_found",
                "dlq_id": dlq_id,
                "webhook_id": row["webhook_id"],
            }
        await pg.execute(
            "UPDATE webhook_dlq "
            "SET replay_count = replay_count + 1, "
            "    last_replayed_at = NOW() "
            "WHERE id = $1",
            dlq_id,
        )
        payload = row["payload"]
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except json.JSONDecodeError:
                payload = {"raw": payload}
        self._schedule_delivery(
            delivery_id=dlq_id,
            url=wh["url"],
            secret=wh["secret"],
            payload=payload or {},
        )
        return {
            "status": "ok",
            "dlq_id": dlq_id,
            "replay_count": replay_count + 1,
            "max_replay_count": _MAX_REPLAY_COUNT,
        }

    # ─── shutdown / lifecycle ───────────────────────────────────────

    async def drain(self, timeout: float = 30.0) -> int:
        """DL-6: wait for all in-flight deliveries to complete.

        Returns the count of tasks still in-flight when the
        timeout fires. Tasks that finish within the budget are
        removed from the set as they complete.
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
        except TimeoutError:
            remaining = len(self._in_flight)
            logger.warning(
                "webhook_delivery: drain timed out with %d "
                "tasks still in flight",
                remaining,
            )
            return remaining

    async def _ensure_http_client(self) -> tuple[Any, asyncio.Semaphore]:
        """Return a shared ``(client, semaphore)`` pair.

        Created lazily so tests can patch the method directly
        without needing real network access.
        """
        if self._http_client is None or self._http_semaphore is None:
            httpx = _get_httpx()
            self._http_client = httpx.AsyncClient(timeout=10.0)
            # Audit 2026-07-03 B-25 — class-level constant so the
            # cap can be tuned / observed in tests without patching
            # ``__init__``.
            self._http_semaphore = asyncio.Semaphore(
                self._HTTP_CONCURRENCY
            )
        return self._http_client, self._http_semaphore

    # ─── internal scheduling / delivery ─────────────────────────────

    def _schedule_delivery(
        self,
        *,
        delivery_id: str,
        url: str,
        secret: str,
        payload: Any,
    ) -> asyncio.Task:
        """Spawn the delivery task and track it in ``_in_flight``.

        Synchronous: returns the :class:`asyncio.Task` directly
        so callers (tests + production) can ``await`` it without
        the function itself being a coroutine. The task body
        ``_attempt_delivery`` does the actual async work.
        """
        loop = asyncio.get_event_loop()
        task = loop.create_task(
            self._attempt_delivery(
                delivery_id=delivery_id,
                url=url,
                secret=secret,
                payload=payload,
            )
        )
        self._in_flight.add(task)
        task.add_done_callback(self._in_flight.discard)
        return task

    async def _attempt_delivery(
        self,
        *,
        delivery_id: str,
        url: str,
        secret: str,
        payload: Any,
    ) -> None:
        """Attempt one delivery with CAS, retries, and DLQ on exhaustion.

        DL-7: single ``UPDATE … RETURNING`` claim — if the row is
        already in a terminal state, another worker won the race
        and we silently return.

        DL-5: retries are scheduled via ``loop.call_later`` so the
        current task ends and the worker is not pinned.

        S-20: ``_assert_public_ip`` is called BEFORE the HTTP POST
        so a DNS-rebinding attack cannot reach the customer's network.
        """
        pg = await get_postgres_client()
        claimed = await pg.fetchrow(
            "UPDATE webhook_deliveries "
            "SET status = 'in_flight', "
            "    last_attempt_at = NOW() "
            "WHERE id = $1 "
            "  AND status IN ('pending', 'retrying') "
            "RETURNING attempt_count, max_attempts, webhook_id",
            delivery_id,
        )
        if claimed is None:
            # Another worker already claimed it (or it's terminal).
            return

        # SSRF guard (S-20). Re-resolve at delivery time.
        try:
            _assert_public_ip(url)
        except ValueError as exc:
            await pg.execute(
                "UPDATE webhook_deliveries "
                "SET status = 'failed', "
                "    error_message = $2, "
                "    completed_at = NOW() "
                "WHERE id = $1",
                delivery_id,
                f"SSRF guard rejected URL: {exc}",
            )
            logger.error(
                "webhook_delivery: SSRF guard rejected delivery %s: %s",
                delivery_id,
                exc,
            )
            await self._move_to_dlq(
                delivery_id, webhook_id=claimed["webhook_id"],
            )
            return

        attempt = int(claimed["attempt_count"]) + 1
        max_attempts = int(claimed["max_attempts"] or len(_RETRY_DELAYS))
        body_str = json.dumps(payload, default=str, sort_keys=True)
        signature = WebhookSigner.sign_v1(secret, body_str)

        try:
            client, sem = await self._ensure_http_client()
            async with sem:
                resp = await client.post(
                    url,
                    content=body_str.encode("utf-8"),
                    headers={
                        "Content-Type": "application/json",
                        "X-Eden-Signature": signature,
                        "X-Eden-Event": payload.get("event_type", "")
                        if isinstance(payload, dict)
                        else "",
                        "X-Eden-Delivery-Id": delivery_id,
                    },
                )
        except Exception as exc:
            resp = None
            http_status = None
            error_text = str(exc)[:1024]
        else:
            http_status = resp.status_code
            error_text = None

        if resp is not None and 200 <= resp.status_code < 300:
            await pg.execute(
                "UPDATE webhook_deliveries "
                "SET status = 'succeeded', "
                "    response_status = $2, "
                "    attempt_count = $3, "
                "    completed_at = NOW() "
                "WHERE id = $1",
                delivery_id,
                http_status,
                attempt,
            )
            return

        # Failure path — schedule a retry or move to DLQ.
        await pg.execute(
            "UPDATE webhook_deliveries "
            "SET status = 'retrying', "
            "    response_status = $2, "
            "    error_message = $3, "
            "    attempt_count = $4, "
            "    next_attempt_at = NOW() + "
            "        ($5 || ' seconds')::interval "
            "WHERE id = $1",
            delivery_id,
            http_status,
            error_text or f"HTTP {http_status}",
            attempt,
            str(_RETRY_DELAYS[attempt] if attempt < len(_RETRY_DELAYS) else 0),
        )
        if attempt >= max_attempts:
            await pg.execute(
                "UPDATE webhook_deliveries "
                "SET status = 'failed', completed_at = NOW() "
                "WHERE id = $1",
                delivery_id,
            )
            await self._move_to_dlq(
                delivery_id, webhook_id=claimed["webhook_id"],
            )
            return

        # DL-5: schedule the next attempt via loop.call_later so
        # the current task ends. ``call_later`` keeps the worker
        # free during the backoff window.
        delay = _RETRY_DELAYS[attempt] if attempt < len(_RETRY_DELAYS) else 0
        loop = asyncio.get_event_loop()
        loop.call_later(
            delay,
            lambda: asyncio.ensure_future(
                self._attempt_delivery(
                    delivery_id=delivery_id,
                    url=url,
                    secret=secret,
                    payload=payload,
                )
            ),
        )

    async def _move_to_dlq(
        self,
        delivery_id: str,
        *,
        webhook_id: str,
    ) -> None:
        """Archive a failed delivery to ``webhook_dlq``.

        DL-4: any failure here is logged at ERROR with the
        ``delivery_id`` for on-call correlation — never silently
        swallowed.
        """
        try:
            pg = await get_postgres_client()
            row = await pg.fetchrow(
                "SELECT id, webhook_id, event_type, payload, "
                "       response_status, error_message, "
                "       attempt_count, max_attempts, created_at, "
                "       signature_v1, webhook_org_id "
                "FROM webhook_deliveries WHERE id = $1",
                delivery_id,
            )
            if row is None:
                logger.error(
                    "webhook_delivery._move_to_dlq: delivery %s "
                    "not found in webhook_deliveries",
                    delivery_id,
                )
                return
            await pg.execute(
                "INSERT INTO webhook_dlq ("
                "  id, webhook_id, event_type, payload, "
                "  response_status, error_message, "
                "  attempt_count, max_attempts, "
                "  signature_v1, org_id, replay_count, "
                "  last_replayed_at, created_at"
                ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, "
                "          $10, 0, NULL, NOW())",
                row["id"],
                row["webhook_id"],
                row["event_type"],
                row["payload"],
                row["response_status"],
                row["error_message"],
                row["attempt_count"],
                row["max_attempts"],
                row.get("signature_v1") or "",
                row.get("webhook_org_id") or "",
            )
            await pg.execute(
                "UPDATE webhook_deliveries "
                "SET status = 'dlq', completed_at = NOW() "
                "WHERE id = $1",
                delivery_id,
            )
        except Exception as exc:
            # DL-4: surface the failure at ERROR with delivery_id.
            logger.error(
                "webhook_delivery._move_to_dlq failed for "
                "delivery_id=%s webhook_id=%s: %s",
                delivery_id,
                webhook_id,
                exc,
                exc_info=True,
            )
