"""Edge fanout for real-time event delivery.

Phase 6.2.1: distributes events from a single producer to many
geographically-distant consumers with low latency. Supports two
providers out of the box:

- **Ably** (default for managed): mature pub/sub, presence, history.
- **Cloudflare Workers** (preferred for ultra-low-latency edge): a
  Worker script fans out to KV/Durable Objects/Queues near the user.

A local Redis-backed fallback is also available for development.

Reads provider config from env vars:

- ``ABLY_ENABLED=true`` + ``ABLY_API_KEY``           — use Ably
- ``CLOUDFLARE_ENABLED=true`` + ``CLOUDFLARE_API_TOKEN`` + ``CLOUDFLARE_ACCOUNT_ID`` + ``CLOUDFLARE_WORKER_URL`` — use Workers
- ``EDGE_FANOUT_URL`` (any other case)                — POST JSON to that URL
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Protocol

import aiohttp

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Provider protocol
# ─────────────────────────────────────────────────────────────────────────────


class EdgeProvider(Protocol):
    """Interface every edge provider implements."""

    name: str

    async def publish(self, channel: str, event: dict[str, Any]) -> bool: ...

    async def close(self) -> None: ...


# ─────────────────────────────────────────────────────────────────────────────
# Ably provider
# ─────────────────────────────────────────────────────────────────────────────


class AblyProvider:
    """Publishes to Ably via the REST API.

    Channel naming: ``ABLY_CHANNEL_PREFIX + ":" + channel``, e.g.
    ``eden:trace``. Auth: a single API key with publish+history
    capabilities on the prefix.
    """

    name = "ably"
    REST_URL = "https://rest.ably.io/channels/{channel}/messages"

    def __init__(self, api_key: str, channel_prefix: str = "eden") -> None:
        if not api_key:
            raise ValueError("AblyProvider requires ABLY_API_KEY")
        # Ably basic auth: base64(api_key)
        import base64
        token = base64.b64encode(api_key.encode()).decode()
        self._auth_header = f"Basic {token}"
        self._channel_prefix = channel_prefix.rstrip(":")
        self._session: aiohttp.ClientSession | None = None

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=10),
                headers={
                    "Authorization": self._auth_header,
                    "Content-Type": "application/json",
                },
            )
        return self._session

    def _full_channel(self, channel: str) -> str:
        return f"{self._channel_prefix}:{channel}"

    async def publish(self, channel: str, event: dict[str, Any]) -> bool:
        session = await self._ensure_session()
        url = self.REST_URL.format(channel=self._full_channel(channel))
        try:
            async with session.post(
                url,
                data=json.dumps({"name": event.get("type", "message"), "data": event}),
            ) as resp:
                if resp.status >= 300:
                    body = await resp.text()
                    logger.warning(f"Ably publish failed ({resp.status}): {body[:200]}")
                    return False
                return True
        except Exception as exc:
            logger.warning(f"Ably publish error: {exc}")
            return False

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()


# ─────────────────────────────────────────────────────────────────────────────
# Cloudflare Workers provider
# ─────────────────────────────────────────────────────────────────────────────


class CloudflareWorkersProvider:
    """Publishes to a Cloudflare Worker that fans out to edge queues.

    Auth: Bearer token with Workers Scripts:Edit scope. The Worker is
    responsible for translating the JSON event into whatever edge
    delivery mechanism is appropriate (Durable Objects, Queues, KV
    writes, etc.).
    """

    name = "cloudflare"

    def __init__(
        self,
        worker_url: str,
        api_token: str,
        account_id: str,
    ) -> None:
        if not (worker_url and api_token and account_id):
            raise ValueError("CloudflareWorkersProvider requires worker_url, api_token, account_id")
        self._worker_url = worker_url
        self._api_token = api_token
        self._account_id = account_id
        self._session: aiohttp.ClientSession | None = None

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=10),
                headers={
                    "Authorization": f"Bearer {self._api_token}",
                    "Content-Type": "application/json",
                },
            )
        return self._session

    async def publish(self, channel: str, event: dict[str, Any]) -> bool:
        session = await self._ensure_session()
        try:
            async with session.post(
                self._worker_url,
                json={"channel": channel, "event": event},
            ) as resp:
                if resp.status >= 300:
                    body = await resp.text()
                    logger.warning(f"Cloudflare publish failed ({resp.status}): {body[:200]}")
                    return False
                return True
        except Exception as exc:
            logger.warning(f"Cloudflare publish error: {exc}")
            return False

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()


# ─────────────────────────────────────────────────────────────────────────────
# Local HTTP fallback
# ─────────────────────────────────────────────────────────────────────────────


class LocalHTTPProvider:
    """POSTs to a local fanout proxy (e.g. for development)."""

    name = "local"

    def __init__(self, url: str) -> None:
        if not url:
            raise ValueError("LocalHTTPProvider requires a url")
        self._url = url
        self._session: aiohttp.ClientSession | None = None

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=5),
                headers={"Content-Type": "application/json"},
            )
        return self._session

    async def publish(self, channel: str, event: dict[str, Any]) -> bool:
        session = await self._ensure_session()
        try:
            async with session.post(
                f"{self._url.rstrip('/')}/{channel}",
                json=event,
            ) as resp:
                return resp.status < 300
        except Exception as exc:
            logger.debug(f"Local fanout publish error: {exc}")
            return False

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()


# ─────────────────────────────────────────────────────────────────────────────
# Edge fanout service
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class FanoutStats:
    publishes: int = 0
    failures: int = 0
    last_failure_at: float | None = None


class EdgeFanout:
    """Single entrypoint for publishing events to a global edge."""

    def __init__(self, provider: EdgeProvider) -> None:
        self._provider = provider
        self._stats = FanoutStats()
        self._lock = asyncio.Lock()

    @classmethod
    def from_env(cls) -> EdgeFanout:
        """Build an instance from environment variables.

        Selection order: Ably > Cloudflare > Local.
        """
        if _env_truthy("ABLY_ENABLED") and os.environ.get("ABLY_API_KEY"):
            provider: EdgeProvider = AblyProvider(
                api_key=os.environ["ABLY_API_KEY"],
                channel_prefix=os.environ.get("ABLY_CHANNEL_PREFIX", "eden"),
            )
            logger.info("Edge fanout: using Ably")
        elif _env_truthy("CLOUDFLARE_ENABLED") and all(
            os.environ.get(k) for k in (
                "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_WORKER_URL"
            )
        ):
            provider = CloudflareWorkersProvider(
                worker_url=os.environ["CLOUDFLARE_WORKER_URL"],
                api_token=os.environ["CLOUDFLARE_API_TOKEN"],
                account_id=os.environ["CLOUDFLARE_ACCOUNT_ID"],
            )
            logger.info("Edge fanout: using Cloudflare Workers")
        elif os.environ.get("EDGE_FANOUT_URL"):
            provider = LocalHTTPProvider(url=os.environ["EDGE_FANOUT_URL"])
            logger.info("Edge fanout: using local HTTP fallback")
        else:
            raise RuntimeError(
                "No edge provider configured. Set ABLY_ENABLED=true or "
                "CLOUDFLARE_ENABLED=true, or EDGE_FANOUT_URL."
            )
        return cls(provider)

    @property
    def provider_name(self) -> str:
        return self._provider.name

    @property
    def stats(self) -> FanoutStats:
        return self._stats

    async def publish(self, channel: str, event: dict[str, Any]) -> bool:
        ok = await self._provider.publish(channel, event)
        async with self._lock:
            self._stats.publishes += 1
            if not ok:
                self._stats.failures += 1
                self._stats.last_failure_at = time.time()
        return ok

    async def close(self) -> None:
        await self._provider.close()


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _env_truthy(key: str) -> bool:
    val = os.environ.get(key, "").lower()
    return val in ("1", "true", "yes", "on")


# Module-level singleton
_edge_fanout: EdgeFanout | None = None


def get_edge_fanout() -> EdgeFanout:
    """Get the singleton :class:`EdgeFanout` (lazy init from env)."""
    global _edge_fanout
    if _edge_fanout is None:
        _edge_fanout = EdgeFanout.from_env()
    return _edge_fanout


async def close_edge_fanout() -> None:
    global _edge_fanout
    if _edge_fanout is not None:
        await _edge_fanout.close()
        _edge_fanout = None
