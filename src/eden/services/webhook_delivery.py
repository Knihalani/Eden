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
        """DL-5/6: schedule a delivery task and track it in the
        in-flight set so ``drain()`` can wait on the queue to settle
        at shutdown.
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

    @staticmethod
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