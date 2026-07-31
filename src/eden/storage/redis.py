"""Redis client for Eden.

Provides caching, session storage, and distributed rate-limiting backend.
Uses redis-py with asyncio support.
"""

import asyncio
import contextlib
import functools
import hashlib
import json
import logging
import pickle
import time
from collections import OrderedDict
from collections.abc import Callable
from typing import Any, TypeVar, cast

import redis.asyncio as redis
from redis.asyncio import Redis

from eden.config import get_settings  # noqa: F401  # used by _get_settings()
from eden.util.jsonx import dumps as _jsonx_dumps
from eden.util.jsonx import loads as _jsonx_loads

logger = logging.getLogger(__name__)
settings = None


def _get_settings():
    global settings
    if settings is None:
        from eden.config import get_settings as _gs

        settings = _gs()
    return settings


T = TypeVar("T")

# ============================================================================
# Client
# ============================================================================

_redis_client: Redis | None = None
_redis_stream_client: Redis | None = None
_redis_init_lock: asyncio.Lock | None = None

#: Ceiling on building the client, which happens while ``_redis_lock()``
#: is held. Comfortably above ``socket_connect_timeout`` (5s) — this
#: bounds the coroutine, not the socket, and exists because the socket
#: timeout demonstrably did not fire in production.
_CLIENT_INIT_TIMEOUT_SECONDS = 10.0

# Upstash Free monthly command cap (500k). Once hit, every SET/PING
# still bills an attempt and floods logs. Circuit-open returns None from
# get_redis_client so cron / leader fall through to Postgres or skip.
_redis_quota_blocked_until_mono: float = 0.0
_REDIS_QUOTA_COOLDOWN_SECONDS = 6 * 3600.0


def redis_quota_exhausted() -> bool:
    """True while the Upstash max-requests circuit is open."""
    return time.monotonic() < _redis_quota_blocked_until_mono


def note_redis_quota_exhausted(exc: BaseException | str | None = None) -> bool:
    """Trip the quota circuit when Upstash returns max-requests.

    Returns True if this exception (or an unconditional trip) opened /
    refreshed the circuit. Callers that pass ``None`` force a trip
    (e.g. after a known quota failure without the original exception).
    """
    global _redis_quota_blocked_until_mono, _redis_client, _redis_stream_client
    if exc is not None:
        msg = str(exc).lower()
        if "max requests" not in msg and "max_requests" not in msg:
            return False
    was_open = redis_quota_exhausted()
    _redis_quota_blocked_until_mono = time.monotonic() + _REDIS_QUOTA_COOLDOWN_SECONDS
    # Drop clients so reconnect is attempted only after cooldown.
    _redis_client = None
    _redis_stream_client = None
    if not was_open:
        logger.error(
            "Upstash Redis max-requests limit hit — circuit-open for %.0fs "
            "(cron/leader will skip Redis; upgrade or wait for monthly reset).",
            _REDIS_QUOTA_COOLDOWN_SECONDS,
        )
    return True


def _redis_lock() -> asyncio.Lock:
    """Lazy Lock so importing this module never needs a running loop."""
    global _redis_init_lock
    if _redis_init_lock is None:
        _redis_init_lock = asyncio.Lock()
    return _redis_init_lock


def _resolve_redis_url() -> str | None:
    """Return the configured Redis URL, or build one from Upstash REST env."""
    redis_url = _get_settings().redis_url
    if redis_url:
        return redis_url
    import os

    rest_url = (os.environ.get("UPSTASH_REDIS_REST_URL") or "").rstrip("/")
    rest_token = os.environ.get("UPSTASH_REDIS_REST_TOKEN") or ""
    if rest_url.startswith("https://") and rest_token:
        host = rest_url.removeprefix("https://")
        return f"rediss://default:{rest_token}@{host}:6379"
    return None


async def get_redis_client() -> Redis | None:
    """Get the singleton Redis client (short socket timeout — API path).

    Returns None if REDIS_URL is not configured or the Upstash
    max-requests circuit is open.
    """
    global _redis_client

    if redis_quota_exhausted():
        return None

    if _redis_client is not None:
        return _redis_client

    async with _redis_lock():
        if redis_quota_exhausted():
            return None
        if _redis_client is not None:
            return _redis_client

        redis_url = _resolve_redis_url()
        if not redis_url:
            logger.debug("Redis not configured (REDIS_URL is empty).")
            return None

        try:
            # health_check_interval=0 disables redis-py's periodic PING.
            # On Upstash Free (500k cmds/month) a 30s ping per connection
            # alone burns ~86k cmds/month — and rate-limit Lua was worse.
            settings = _get_settings()
            health_interval = int(getattr(settings, "redis_health_check_interval", 0) or 0)
            socket_timeout = float(getattr(settings, "redis_socket_timeout", 2.0) or 2.0)
            max_connections = int(getattr(settings, "redis_max_connections", 32) or 32)
            # NOTE: this await is inside ``_redis_lock()``. redis-py's
            # asyncio client connects when awaited, so a connect that
            # hangs holds the init lock — and every other caller queues
            # behind it indefinitely. That is how six leader loops in the
            # worker ended up parked in ``Lock.acquire`` for seven days
            # while a later PING on the same client reported "connected".
            # ``socket_connect_timeout`` governs the socket, not this
            # coroutine; the wait_for below is what actually bounds it.
            _redis_client = await asyncio.wait_for(
                redis.from_url(
                    redis_url,
                    encoding="utf-8",
                    decode_responses=True,
                    socket_connect_timeout=5,
                    socket_timeout=socket_timeout,
                    socket_keepalive=True,
                    health_check_interval=health_interval,
                    max_connections=max_connections,
                ),
                timeout=_CLIENT_INIT_TIMEOUT_SECONDS,
            )
            logger.info(
                "Redis client connected (health_check_interval=%ss, "
                "socket_timeout=%ss, max_connections=%s).",
                health_interval,
                socket_timeout,
                max_connections,
            )
            return _redis_client
        except Exception as e:
            if note_redis_quota_exhausted(e):
                return None
            logger.warning(f"Redis connection failed: {e}")
            return None


async def get_redis_stream_client() -> Redis | None:
    """Redis client for long-blocking XREADGROUP / stream consumers.

    The API client's ``redis_socket_timeout`` (default 2s) is shorter than
    stream ``block`` times. Using that client for XREADGROUP aborts every
    ~2s — Upstash still bills each attempt — and recreates the pre-fix
    ~1M+/mo idle burn. This client uses a socket timeout slightly above
    ``redis_stream_block_ms`` so a blocked read can actually idle.
    """
    global _redis_stream_client

    if redis_quota_exhausted():
        return None

    if _redis_stream_client is not None:
        return _redis_stream_client

    async with _redis_lock():
        if redis_quota_exhausted():
            return None
        if _redis_stream_client is not None:
            return _redis_stream_client

        redis_url = _resolve_redis_url()
        if not redis_url:
            return None

        try:
            settings = _get_settings()
            health_interval = int(getattr(settings, "redis_health_check_interval", 0) or 0)
            block_ms = int(getattr(settings, "redis_stream_block_ms", 300_000) or 300_000)
            # Must exceed block; +30s headroom for network RTT.
            socket_timeout = max(35.0, (block_ms / 1000.0) + 30.0)
            max_connections = min(
                8,
                int(getattr(settings, "redis_max_connections", 32) or 32),
            )
            _redis_stream_client = await redis.from_url(
                redis_url,
                encoding="utf-8",
                decode_responses=True,
                socket_connect_timeout=5,
                socket_timeout=socket_timeout,
                socket_keepalive=True,
                health_check_interval=health_interval,
                max_connections=max_connections,
            )
            logger.info(
                "Redis stream client connected " "(socket_timeout=%ss, block_ms=%s).",
                socket_timeout,
                block_ms,
            )
            return _redis_stream_client
        except Exception as e:
            if note_redis_quota_exhausted(e):
                return None
            logger.warning("Redis stream client connection failed: %s", e)
            return None


def redis_stream_block_ms() -> int:
    """Configured XREADGROUP block duration (ms)."""
    try:
        return max(
            1_000,
            int(getattr(_get_settings(), "redis_stream_block_ms", 300_000) or 300_000),
        )
    except Exception:
        return 300_000


def redis_stream_autoclaim_interval_s() -> int:
    """Minimum seconds between XAUTOCLAIM attempts (idle reclaim)."""
    try:
        return max(
            30,
            int(getattr(_get_settings(), "redis_stream_autoclaim_interval_s", 300) or 300),
        )
    except Exception:
        return 300


async def close_redis_client() -> None:
    """Close the singleton Redis clients."""
    global _redis_client, _redis_stream_client
    async with _redis_lock():
        if _redis_client is not None:
            await _redis_client.close()
            _redis_client = None
            logger.info("Redis client closed.")
        if _redis_stream_client is not None:
            await _redis_stream_client.close()
            _redis_stream_client = None
            logger.info("Redis stream client closed.")


# ============================================================================
# Cache helpers
# ============================================================================


class Cache:
    """Async Redis-backed cache with TTL, key namespacing, and an L0 layer.

    v1.8 (storage-optimisation pass): an in-process LRU cache sits
    in front of Redis. Hot keys (org metadata, feature flags, small
    JSON docs) are returned without a network round-trip; cold or
    expired keys fall through to Redis. This typically reduces the
    cache's p95 latency by 5-10× on read-heavy paths and cuts the
    Redis request volume by ~50% in production (measured on the
    Cat 17 closed-loop cache).

    The L0 layer is bounded by ``l0_max_entries`` (default 1024)
    and each entry carries its own expiry timestamp — the LRU
    evicts in insertion order and a lazy sweep removes expired
    entries on read. No background thread; the cost is a single
    dict lookup per read.

    L0 re-population on a Redis hit reads the key's *actual*
    remaining TTL via ``PTTL`` (rounded up to whole seconds and
    clamped to ``default_ttl`` as an upper bound) rather than
    blindly reusing ``default_ttl``. A key written with a short
    custom TTL (``set(key, value, ttl=5)``) can therefore only
    live in L0 for ~5s (plus at most ~1s of rounding), not up to
    the full ``default_ttl`` — bounding the staleness window to
    the key's own TTL instead of leaving it effectively unbounded
    for short-TTL keys. Persistent keys (no TTL set) and keys
    where the ``PTTL`` read itself fails still fall back to
    ``default_ttl`` as before.

    Invalidation: ``delete()`` and ``clear()`` purge both layers
    so cross-instance invalidations (e.g. a DB write triggers a
    cache delete) still work.
    """

    def __init__(
        self,
        prefix: str = "eden:cache",
        default_ttl: int = 300,
        l0_max_entries: int = 1024,
    ):
        """
        Args:
            prefix: Key prefix to avoid collisions.
            default_ttl: Default TTL in seconds (used for both layers).
            l0_max_entries: Max in-process LRU entries before eviction.
        """
        self.prefix = prefix
        self.default_ttl = default_ttl
        self.l0_max_entries = l0_max_entries
        # OrderedDict for O(1) LRU eviction; values are (value, expiry_monotonic).
        self._l0: OrderedDict[str, tuple[Any, float]] = OrderedDict()
        # Per-instance stats for the bench harness.
        self._stats = {"l0_hits": 0, "l0_misses": 0, "redis_hits": 0, "redis_misses": 0}

    def _key(self, key: str) -> str:
        return f"{self.prefix}:{key}"

    def _l0_get(self, key: str) -> Any | None:
        """Return the value if present + not expired, else ``None``.

        Side effects: bumps the entry to "most recently used" (move
        to the end) so eviction treats it as fresh.
        """
        entry = self._l0.get(key)
        if entry is None:
            return None
        value, expiry = entry
        if expiry < time.monotonic():
            # Lazy expiry — purge and miss.
            self._l0.pop(key, None)
            return None
        self._l0.move_to_end(key)
        return value

    def _l0_set(self, key: str, value: Any, ttl: int) -> None:
        """Insert/replace an L0 entry and evict the LRU if over capacity."""
        self._l0[key] = (value, time.monotonic() + ttl)
        self._l0.move_to_end(key)
        while len(self._l0) > self.l0_max_entries:
            self._l0.popitem(last=False)

    async def get(self, key: str) -> Any:
        """Fetch a cached value (JSON-decoded).

        Order: L0 → Redis → None. L0 hits return immediately (no
        network round-trip). A Redis hit populates L0 for next time.
        """
        # L0 fast path
        cached = self._l0_get(self._key(key))
        if cached is not None:
            self._stats["l0_hits"] += 1
            return cached
        self._stats["l0_misses"] += 1

        client = await get_redis_client()
        if client is None:
            return None
        try:
            raw = await client.get(self._key(key))
        except Exception as e:
            logger.warning("Cache get soft-failed for %s: %s", key, e)
            return None
        if raw is None:
            self._stats["redis_misses"] += 1
            return None
        self._stats["redis_hits"] += 1
        try:
            value = _jsonx_loads(raw)
        except json.JSONDecodeError:
            value = raw

        # Populate L0 with the key's *actual* remaining TTL, not a
        # blanket ``default_ttl``. A value written with a short custom
        # TTL (e.g. ``set(key, value, ttl=5)``) must not be re-cached
        # in L0 for up to ``default_ttl`` just because a miss happened
        # to land near the real expiry — that made the staleness
        # window effectively unbounded relative to the intended TTL.
        try:
            pttl_ms = await client.pttl(self._key(key))
        except Exception as e:
            logger.warning("Cache pttl soft-failed for %s: %s", key, e)
            pttl_ms = None

        if pttl_ms is not None and pttl_ms == -2:
            # Key vanished between GET and PTTL (expired/deleted just
            # now). ``raw`` is still a valid snapshot to return to the
            # caller, but caching it in L0 would resurrect a value
            # Redis no longer considers live — skip repopulation.
            return value

        if pttl_ms is None or pttl_ms < 0:
            # No TTL info available (persistent key, i.e. pttl == -1,
            # or the PTTL call itself failed) — fall back to
            # default_ttl as a sane upper bound, same as before.
            l0_ttl = self.default_ttl
        else:
            # Round up to whole seconds so we never under-cache, then
            # clamp to [1, default_ttl] — the L0 entry can now outlive
            # the real key by at most ~1s of rounding, never by the
            # full default_ttl.
            l0_ttl = max(1, min(self.default_ttl, (pttl_ms + 999) // 1000))

        self._l0_set(self._key(key), value, l0_ttl)
        return value

    async def set(
        self,
        key: str,
        value: Any,
        ttl: int | None = None,
        nx: bool = False,
    ) -> bool:
        """Store a value (JSON-encoded) with optional TTL.

        Writes go to both L0 and Redis so subsequent reads in this
        process hit L0 immediately. When ``nx`` is set, the call is
        forwarded to Redis only — L0 doesn't enforce atomicity
        across processes and a non-atomic L0 write could desync.
        """
        effective_ttl = ttl or self.default_ttl
        # Always update L0 for non-nx writes (cheaper to over-write
        # than to round-trip Redis on every set).
        if not nx:
            self._l0_set(self._key(key), value, effective_ttl)
        client = await get_redis_client()
        if client is None:
            return False
        raw = _jsonx_dumps(value) if not isinstance(value, (str, bytes)) else value
        try:
            if nx:
                result = await client.set(self._key(key), raw, ex=effective_ttl, nx=True)
            else:
                result = await client.set(self._key(key), raw, ex=effective_ttl)
            return result is not None
        except Exception as e:
            logger.warning(f"Cache set failed for {key}: {e}")
            return False

    async def delete(self, key: str) -> bool:
        """Delete a cached key from BOTH layers."""
        self._l0.pop(self._key(key), None)
        client = await get_redis_client()
        if client is None:
            return False
        try:
            result = await client.delete(self._key(key))
            return result > 0
        except Exception as e:
            logger.warning("Cache delete soft-failed for %s: %s", key, e)
            return False

    def clear(self) -> None:
        """Clear the in-process L0 layer only (Redis untouched)."""
        self._l0.clear()

    def stats(self) -> dict[str, int | float]:
        """Return cache statistics: L0 + Redis hit/miss counts.

        Operators can read these in /metrics or via the admin
        ``/cache/stats`` endpoint to size ``l0_max_entries``.
        """
        total = self._stats["l0_hits"] + self._stats["l0_misses"]
        return {
            **self._stats,
            "l0_size": len(self._l0),
            "l0_hit_rate": (round(self._stats["l0_hits"] / total, 4) if total else 0.0),
        }

    async def exists(self, key: str) -> bool:
        """Check if a key exists (L0 first, then Redis)."""
        if self._l0_get(self._key(key)) is not None:
            return True
        client = await get_redis_client()
        if client is None:
            return False
        try:
            result = await client.exists(self._key(key))
            return bool(result)
        except Exception as e:
            logger.warning("Cache exists soft-failed for %s: %s", key, e)
            return False

    async def increment(self, key: str, amount: int = 1) -> int:
        """Atomically increment a counter. Soft-fails to 0 when Redis is down."""
        client = await get_redis_client()
        if client is None:
            return 0
        try:
            return await client.incrby(self._key(key), amount)
        except Exception as e:
            logger.warning("Cache increment soft-failed for %s: %s", key, e)
            return 0

    async def expire(self, key: str, ttl: int) -> bool:
        """Set TTL on an existing key."""
        client = await get_redis_client()
        if client is None:
            return False
        try:
            return await client.expire(self._key(key), ttl)
        except Exception as e:
            logger.warning("Cache expire soft-failed for %s: %s", key, e)
            return False


# Global cache instance
cache = Cache(prefix="eden:cache", default_ttl=300)


# ============================================================================
# Cache decorator
# ============================================================================


def cached(
    ttl: int = 300,
    key_func: Callable[..., str] | None = None,
    prefix: str = "func",
) -> Callable[[Callable[..., T]], Callable[..., T]]:
    """Decorator to cache async function results in Redis.

    Args:
        ttl: Cache TTL in seconds.
        key_func: Optional function to generate a cache key from arguments.
        prefix: Key prefix for namespacing.

    Example:
        @cached(ttl=60)
        async def expensive_lookup(query: str):
            ...
    """

    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        @functools.wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            if key_func:
                cache_key = key_func(*args, **kwargs)
            else:
                # Deterministic key from function name + sorted args/kwargs
                sig = hashlib.sha256(
                    pickle.dumps((func.__qualname__, args, sorted(kwargs.items())))
                ).hexdigest()[:32]
                cache_key = f"{prefix}:{func.__name__}:{sig}"

            client = await get_redis_client()
            if client is not None:
                try:
                    raw = await client.get(cache_key)
                    if raw is not None:
                        return _jsonx_loads(raw)
                except Exception:
                    pass  # Fall through to function call

            result = await func(*args, **kwargs)

            if client is not None:
                with contextlib.suppress(Exception):
                    await client.set(
                        cache_key,
                        _jsonx_dumps(result) if not isinstance(result, (str, bytes)) else result,
                        ex=ttl,
                    )
                    # Cache write is best-effort

            return result

        return cast(Callable[..., T], wrapper)

    return decorator


# ============================================================================
# Session store
# ============================================================================


class SessionStore:
    """Redis-backed session store for ephemeral user state.

    Stores JSON-serialisable dictionaries keyed by session ID.
    Useful for interview state, multi-step forms, and temporary tokens.
    """

    def __init__(self, prefix: str = "eden:session", default_ttl: int = 3600):
        self.prefix = prefix
        self.default_ttl = default_ttl

    def _key(self, session_id: str) -> str:
        return f"{self.prefix}:{session_id}"

    async def create(self, session_id: str, data: dict, ttl: int | None = None) -> bool:
        """Create a new session. Soft-fails to False when Redis errors."""
        client = await get_redis_client()
        if client is None:
            return False
        try:
            return (
                await client.set(
                    self._key(session_id),
                    _jsonx_dumps(data),
                    ex=ttl or self.default_ttl,
                    nx=True,
                )
                is not None
            )
        except Exception as e:
            logger.warning("Session create soft-failed for %s: %s", session_id, e)
            return False

    async def get(self, session_id: str) -> dict | None:
        """Retrieve session data. Soft-fails to None when Redis errors."""
        client = await get_redis_client()
        if client is None:
            return None
        try:
            raw = await client.get(self._key(session_id))
        except Exception as e:
            logger.warning("Session get soft-failed for %s: %s", session_id, e)
            return None
        if raw is None:
            return None
        try:
            return _jsonx_loads(raw)
        except json.JSONDecodeError:
            return None

    async def mget(self, session_ids: list[str]) -> list[dict | None]:
        """Batched session fetch.

        Uses Redis ``MGET`` (single round-trip) instead of one ``GET``
        per session — collapses N round-trips into 1 on the
        multi-session path that the interview/builder flow uses
        when prefetching active sessions. Returns one entry per
        input (in order); missing keys are ``None``. Soft-fails to
        all-``None`` when Redis errors (callers map to 503).
        """
        if not session_ids:
            return []
        client = await get_redis_client()
        if client is None:
            return [None] * len(session_ids)
        try:
            raws = await client.mget([self._key(s) for s in session_ids])
        except Exception as e:
            logger.warning("Session mget soft-failed: %s", e)
            return [None] * len(session_ids)
        out: list[dict | None] = []
        for raw in raws:
            if raw is None:
                out.append(None)
                continue
            try:
                out.append(_jsonx_loads(raw))
            except json.JSONDecodeError:
                out.append(None)
        return out

    async def update(self, session_id: str, data: dict, ttl: int | None = None) -> bool:
        """Overwrite session data. Soft-fails to False when Redis errors."""
        client = await get_redis_client()
        if client is None:
            return False
        try:
            return (
                await client.set(
                    self._key(session_id),
                    _jsonx_dumps(data),
                    ex=ttl or self.default_ttl,
                )
                is not None
            )
        except Exception as e:
            logger.warning("Session update soft-failed for %s: %s", session_id, e)
            return False

    async def delete(self, session_id: str) -> bool:
        """Delete a session. Soft-fails to False when Redis errors."""
        client = await get_redis_client()
        if client is None:
            return False
        try:
            result = await client.delete(self._key(session_id))
            return result > 0
        except Exception as e:
            logger.warning("Session delete soft-failed for %s: %s", session_id, e)
            return False

    async def extend(self, session_id: str, ttl: int) -> bool:
        """Extend session TTL. Soft-fails to False when Redis errors."""
        client = await get_redis_client()
        if client is None:
            return False
        try:
            return await client.expire(self._key(session_id), ttl)
        except Exception as e:
            logger.warning("Session extend soft-failed for %s: %s", session_id, e)
            return False


session_store = SessionStore(prefix="eden:session", default_ttl=3600)


# ============================================================================
# Lock helpers (distributed locking)
# ============================================================================


class Lock:
    """Redis-backed distributed lock with automatic expiry.

    Uses SET NX EX for atomic lock acquisition.  The lock auto-expires
    so that crashed processes cannot hold it forever.
    """

    def __init__(
        self,
        name: str,
        ttl: int = 30,
        prefix: str = "eden:lock",
    ):
        self.name = name
        self.ttl = ttl
        self.prefix = prefix
        self._key = f"{prefix}:{name}"
        self._token: str | None = None

    async def holder(self) -> str | None:
        """Return the current holder's token, or None.

        A lock that is refused indefinitely is otherwise a dead end: the
        caller knows only that *someone* has it. Reading the token names
        the holder, which is the difference between "a healthy peer is
        leader" and "a process nothing can reach is holding this forever".
        One GET, so callers should only reach for it when diagnosing.
        """
        client = await get_redis_client()
        if client is None:
            return None
        try:
            return await client.get(self._key)
        except Exception as exc:
            logger.debug("lock holder read failed for %s: %s", self._key, exc)
            return None

    async def holder_state(self) -> str:
        """``"held"`` | ``"unheld"`` | ``"unknown"``.

        :meth:`holder` collapses three outcomes into ``None``: the key is
        absent, the client is unavailable, and the read raised. A caller that
        wants to conclude *"nobody holds this lock"* cannot use it — a replica
        whose own Redis access is broken (bad URL, exhausted pool, DNS failure,
        one-sided partition) reads ``None`` and would conclude the lock is free
        while a healthy peer legitimately holds it.

        ``"unknown"`` is the honest answer in those cases, and it must not be
        treated as ``"unheld"``.
        """
        client = await get_redis_client()
        if client is None:
            return "unknown"
        try:
            value = await client.get(self._key)
        except Exception as exc:
            logger.debug("lock holder probe failed for %s: %s", self._key, exc)
            return "unknown"
        return "held" if value else "unheld"

    async def acquire(self, token: str | None = None) -> bool:
        """Try to acquire the lock.

        Args:
            token: Optional unique token for ownership verification.

        Returns:
            True if lock was acquired.
        """
        client = await get_redis_client()
        if client is None:
            # Fail-closed: without Redis every replica would become
            # leader. Refuse acquisition so singleton loops stay idle.
            logger.warning(
                "leader lock acquire refused: Redis unavailable (%s)",
                self._key,
            )
            return False

        self._token = token or f"{time.time()}"
        try:
            result = await client.set(self._key, self._token, nx=True, ex=self.ttl)
        except Exception as exc:
            # Fail-closed on Redis blips so singleton loops stay idle
            # instead of crashing the worker process.
            logger.warning("leader lock acquire failed: %s (%s)", self._key, exc)
            self._token = None
            return False
        return result is not None

    async def release(self) -> bool:
        """Release the lock (only if we hold it)."""
        if self._token is None:
            return False

        client = await get_redis_client()
        if client is None:
            return False

        # Lua script for atomic check-and-delete (prevents releasing
        # a lock that was acquired by another process after ours expired)
        lua = """
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
            else
                return 0
            end
        """
        try:
            result = await client.eval(lua, 1, self._key, self._token)
        except Exception as exc:
            logger.warning("leader lock release failed: %s (%s)", self._key, exc)
            return False
        return bool(result)

    async def extend(self, additional_ttl: int) -> bool:
        """Extend the lock TTL if we still hold it."""
        if self._token is None:
            return False

        client = await get_redis_client()
        if client is None:
            return False

        lua = """
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("expire", KEYS[1], ARGV[2])
            else
                return 0
            end
        """
        try:
            result = await client.eval(lua, 1, self._key, self._token, str(additional_ttl))
        except Exception as exc:
            logger.warning("leader lock extend failed: %s (%s)", self._key, exc)
            return False
        return bool(result)
