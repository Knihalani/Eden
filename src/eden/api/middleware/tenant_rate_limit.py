"""Per-tenant token-bucket rate limiting middleware.

Enforces tiered rate limits based on org_resource_limits. Uses Redis as the
backing store for distributed rate limiting; falls back to an in-memory
token bucket when Redis is unavailable (suitable for single-node dev).

Sets standard X-RateLimit-* headers on every response:
  X-RateLimit-Limit     : requests allowed per window
  X-RateLimit-Remaining : remaining requests in current window
  X-RateLimit-Reset     : Unix timestamp when the window resets
  X-RateLimit-Policy    : tier name (e.g., free, pro, enterprise)

Rejects with HTTP 429 when the limit is exceeded.
"""

import asyncio
import contextlib
import hashlib
import logging
import time
from typing import Any

from fastapi import Request
from starlette.types import ASGIApp, Receive, Scope, Send

from eden.api.utils.auth import decode_access_token
from eden.api.utils.client_ip import get_client_ip
from eden.config import get_settings
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)
settings = None

# Process-local API-key auth cache — middleware + deps both look up
# the same key_hash; 60s TTL cuts a PG round-trip on hot ingest.
_API_KEY_CACHE_TTL_S = 60.0
_api_key_resolve_cache: dict[str, tuple[str, str, float]] = {}


def _get_settings():
    global settings
    if settings is None:
        from eden.config import get_settings as _gs
        settings = _gs()
    return settings
# Audit 2026-07-06 v1.9 — pre-compute the response header names
# as lowercase bytes so the ASGI ``send`` wrapper doesn't encode
# per request. The send-wrapper path is the only place we add
# these (the 429 response uses ``JSONResponse`` directly via its
# own ASGI send; see dispatch below).
_HDR_LIMIT = b"x-ratelimit-limit"
_HDR_REMAINING = b"x-ratelimit-remaining"
_HDR_RESET = b"x-ratelimit-reset"
_HDR_POLICY = b"x-ratelimit-policy"



class TokenBucket:
    """In-memory token bucket for a single key with TTL-based eviction.

    Not distributed — use Redis in production for multi-node deployments.
    """

    def __init__(self, capacity: int, refill_rate: float):
        self.capacity = capacity
        self.refill_rate = refill_rate
        self.tokens = float(capacity)
        self.last_refill = time.monotonic()
        self.last_access = time.monotonic()
        self._lock = asyncio.Lock()

    async def consume(self, tokens: float = 1.0) -> tuple[bool, float, float]:
        """Try to consume tokens from the bucket.

        Returns:
            (allowed, remaining_tokens, retry_after_seconds)
        """
        now = time.monotonic()
        async with self._lock:
            self.last_access = now
            elapsed = now - self.last_refill
            self.tokens = min(self.capacity, self.tokens + elapsed * self.refill_rate)
            self.last_refill = now

            if self.tokens >= tokens:
                self.tokens -= tokens
                return True, self.tokens, 0.0

            deficit = tokens - self.tokens
            retry_after = deficit / self.refill_rate if self.refill_rate > 0 else 60.0
            return False, self.tokens, retry_after


class TenantRateLimitMiddleware:
    """Token-bucket rate limiter scoped per tenant (org).

    Independently resolves the org from the JWT cookie or API key header
    so that per-tenant limits work even though auth dependencies run after
    middleware. Falls back to per-IP limiting for unauthenticated requests.

    Audit 2026-07-06 v1.9 — converted from
    :class:`starlette.middleware.base.BaseHTTPMiddleware` to pure ASGI.
    The ``__call__`` form avoids the per-request ``BaseHTTPMiddleware``
    overhead (re-constructing a ``Request`` + thread-pool bridge, ~150µs).
    Behaviour preserved:
      * Same short-circuit on ``/health`` and ``OPTIONS``.
      * Same test-bypass (``settings.rate_limit_enabled=False``).
      * Same Redis-or-bucket fallback chain.
      * Same ``X-RateLimit-*`` response headers (now injected via
        send-wrapper rather than on a Starlette ``Response`` object).
      * Same 429 JSON envelope on rejection (built inline in ASGI form
        rather than via ``JSONResponse.__call__``).
      * Same per-request ``request.state`` access path (we still
        stash org / limit context for the helper methods that get
        called from inside dispatch).
    """

    def __init__(self, app: ASGIApp, default_limit: int = 60, default_window: int = 60):
        self.app = app
        self.default_limit = default_limit
        self.default_window = default_window
        self._buckets: dict[str, TokenBucket] = {}
        self._bucket_lock = asyncio.Lock()
        self._tier_cache: dict[str, tuple[int, int, str, float]] = {}  # org_id -> (limit, window, tier, expires_at)
        self._tier_cache_ttl = 60.0  # seconds — avoid per-request DB tier lookups
        self._region_cache: dict[str, str | None] = {}  # org_id -> region
        self._redis = None  # Lazy-load Redis if available
        self._cleanup_task: asyncio.Task | None = None
        self._running = True
        # Cached Redis Lua script handle. ``register_script`` returns a
        # Script object whose __call__ uses EVALSHA so we don't ship
        # the full source on every invocation. Filled lazily on first
        # use (needs a live Redis connection).
        self._sliding_window_script: Any | None = None
        # Audit 2026-07-06 v1.9 — defer the periodic bucket cleanup
        # task to the first ``__call__``. Eager ``asyncio.create_task``
        # in ``__init__`` raised ``RuntimeError: no running event
        # loop`` whenever the middleware was constructed outside a
        # running loop (unit tests, bench harness, anything that did
        # ``mw = TenantRateLimitMiddleware(MagicMock())`` to inspect
        # the contract). Lazy creation preserves the cleanup cadence
        # without the startup contract.

    async def _get_redis(self):
        """Lazy-load Redis client when distributed rate limiting is on.

        Shares the process singleton from ``eden.storage.redis`` — a
        second ``from_url`` connection previously doubled health-check
        PINGs and burned Upstash Free quota.
        """
        if self._redis is not None:
            return self._redis
        settings = _get_settings()
        if not getattr(settings, "rate_limit_distributed", False):
            self._redis = False  # sentinel: memory-only mode
            return None
        redis_url = getattr(settings, "redis_url", "")
        if redis_url:
            try:
                from eden.storage.redis import get_redis_client

                client = await get_redis_client()
                if client is None:
                    self._redis = False
                    return None
                self._redis = client
                logger.info("TenantRateLimitMiddleware: Redis backend connected (shared)")
            except Exception as exc:
                logger.warning(
                    "TenantRateLimitMiddleware: Redis unavailable (%s), using in-memory fallback",
                    exc,
                )
                self._redis = False  # sentinel: don't retry
        else:
            self._redis = False
        return self._redis if self._redis else None

    async def _periodic_bucket_cleanup(self) -> None:
        """Evict stale buckets every 60s to prevent unbounded memory growth."""
        while self._running:
            try:
                await asyncio.sleep(60)
                cutoff = time.monotonic() - 300
                async with self._bucket_lock:
                    stale = [k for k, b in self._buckets.items() if b.last_access < cutoff]
                    for k in stale:
                        del self._buckets[k]
                    if stale:
                        logger.debug(f"Evicted {len(stale)} stale rate-limit buckets")
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.warning(f"Rate-limit bucket cleanup error: {exc}")

    async def _get_bucket(self, key: str, capacity: int, refill_rate: float) -> TokenBucket:
        """Return (or create) the in-memory bucket for ``key``.

        Stale eviction is handled by ``_periodic_bucket_cleanup`` —
        scanning every bucket under the global lock on each request
        was O(n) per admission and contended with every other
        concurrent request. Hot path is now O(1) dict get/set.
        """
        async with self._bucket_lock:
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = TokenBucket(capacity, refill_rate)
                self._buckets[key] = bucket
            return bucket

    def reset_buckets(self) -> None:
        """Clear ALL per-tenant rate-limit buckets.

        Called from the test conftest's ``reset_rate_limit`` autouse
        fixture so each integration test starts with a fresh bucket.
        Without this, tests share the process-global bucket and the
        Nth test in a session gets 429'd even though its own request
        count is well below the limit.

        Not for production use — there's no auth or rate limit on
        this method.
        """
        self._buckets.clear()

    async def _resolve_org_and_api_key(
        self, request: Request
    ) -> tuple[str | None, str | None]:
        """Resolve ``(org_id, api_key_id)`` with at most one DB round-trip.

        API-key auth previously hit Postgres twice per request
        (``_resolve_org_from_request`` then ``_resolve_api_key_id``)
        for the same ``key_hash``. A single ``SELECT id, org_id``
        preserves the same admission rules while cutting the
        middleware's DB cost in half on the API-key hot path.
        """
        api_key = request.headers.get("x-org-api-key")
        org_id_header = request.headers.get("x-org-id")
        if api_key and org_id_header:
            try:
                key_hash = hashlib.sha256(api_key.encode()).hexdigest()
                cache_key = f"{key_hash}:{org_id_header}"
                now = time.monotonic()
                cached = _api_key_resolve_cache.get(cache_key)
                if cached is not None and cached[2] > now:
                    return cached[0], cached[1]
                client = await get_postgres_client()
                row = await client.fetchrow(
                    "SELECT id, org_id FROM org_api_keys "
                    "WHERE key_hash = $1 AND org_id::text = $2",
                    key_hash,
                    org_id_header,
                )
                if row:
                    org_id = str(row["org_id"])
                    key_id = str(row["id"])
                    _api_key_resolve_cache[cache_key] = (
                        org_id,
                        key_id,
                        now + _API_KEY_CACHE_TTL_S,
                    )
                    if len(_api_key_resolve_cache) > 8192:
                        stale = [
                            k for k, (_, _, exp) in _api_key_resolve_cache.items()
                            if exp <= now
                        ]
                        for k in stale:
                            _api_key_resolve_cache.pop(k, None)
                    return org_id, key_id
            except Exception:
                logger.warning(
                    "tenant_rate_limit: API-key lookup failed; falling back",
                    exc_info=True,
                )

        token = request.cookies.get("authorization")
        if token:
            payload = decode_access_token(token)
            if payload:
                return payload.get("current_org_id"), None

        # Clerk Bearer (portal) — session JWT carries ``o.id``.
        # Only trust ``X-Org-Id`` after the Bearer verifies, so an
        # unauthenticated client cannot burn another org's rate budget.
        auth_header = request.headers.get("authorization")
        if auth_header and auth_header.lower().startswith("bearer "):
            try:
                from eden.api.utils.clerk_auth import (
                    extract_org_id,
                    verify_clerk_token_for_request,
                )

                clerk_payload = await verify_clerk_token_for_request(
                    request, auth_header[7:].strip()
                )
                if clerk_payload:
                    clerk_org = extract_org_id(clerk_payload)
                    if clerk_org:
                        return clerk_org, None
                    if org_id_header:
                        return org_id_header, None
            except Exception:
                logger.debug(
                    "tenant_rate_limit: Clerk Bearer resolve failed; falling back",
                    exc_info=True,
                )

        return None, None

    async def _resolve_org_from_request(self, request: Request) -> str | None:
        """Parse JWT cookie or API key header to extract org_id.

        Mirrors the logic in eden.api.deps but without depending on
        route-level dependency injection.
        """
        org_id, _key_id = await self._resolve_org_and_api_key(request)
        return org_id

    async def _get_tier_limits(self, org_id: str) -> tuple[int, int, str]:
        """Fetch rate limits for an org. Cached for a few seconds."""
        now = time.monotonic()
        cached = self._tier_cache.get(org_id)
        if cached and cached[3] > now:
            return cached[0], cached[1], cached[2]

        try:
            client = await get_postgres_client()
            row = await client.get_org_resource_limits(org_id)
            if row:
                rpm = row.get("requests_per_minute") or self.default_limit
                tier = row.get("plan_name", "free")
                self._tier_cache[org_id] = (rpm, 60, tier, now + self._tier_cache_ttl)
                return rpm, 60, tier
        except Exception as exc:
            logger.warning(f"Failed to fetch tier limits for org {org_id}: {exc}")

        self._tier_cache[org_id] = (self.default_limit, self.default_window, "default", now + self._tier_cache_ttl)
        return self.default_limit, self.default_window, "default"

    async def _check_redis(self, key: str, limit: int, window: int) -> tuple[bool, int, int, int]:
        """Check rate limit via Redis (sliding window using sorted sets).

        Returns (allowed, remaining, reset_ts, retry_after).

        Audit 2026-07-02 S-14 — ZADD runs ONLY when the request is
        allowed. Pre-fix, ZADD was unconditional; a denied request
        still bumped the counter, so a sustained flood of denied
        requests would self-DoS by extending the sliding window
        and never let a real call through.
        """
        redis = await self._get_redis()
        if not redis:
            raise RuntimeError("Redis not configured")

        now = time.time()
        window_start = now - window
        redis_key = f"ratelimit:{key}"

        # Atomic sliding-window admission via a Lua script.
        # Pre-fix we ran Phase 1 (count) + Phase 2 (zadd) as two
        # pipelines, leaving a TOCTOU window: two concurrent
        # requests at count=limit-1 could both observe "allowed"
        # and both ZADD, over-admitting by 1 per race. The Lua
        # script runs prune + count + conditional-zadd in one
        # round-trip so the limit is enforced atomically.
        # Script returns: {allowed_int, current_count_after}
        sliding_window_script = """
        redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1])
        local n = redis.call('ZCARD', KEYS[1])
        local allowed = 0
        if n < tonumber(ARGV[2]) then
          redis.call('ZADD', KEYS[1], ARGV[3], ARGV[3])
          redis.call('EXPIRE', KEYS[1], ARGV[4])
          n = n + 1
          allowed = 1
        end
        return {allowed, n}
        """
        script = self._sliding_window_script
        if script is None:
            script = redis.register_script(sliding_window_script)
            self._sliding_window_script = script
        # Bound the Redis RTT so a hung Upstash socket cannot stall
        # every request behind this middleware.
        results = await asyncio.wait_for(
            script(
                keys=[redis_key],
                args=[window_start, limit, now, int(window) + 1],
            ),
            timeout=2.0,
        )
        allowed_int, current_count = results[0], results[1]
        allowed = bool(int(allowed_int))

        if not allowed:
            remaining = 0
            reset_ts = int(now + window)
            retry_after = int(window)
            return allowed, remaining, reset_ts, retry_after

        # The Lua script has already ZADDed this request and updated
        # the count; ``current_count`` is post-add.
        remaining = max(0, limit - current_count)
        reset_ts = int(now + window)
        retry_after = 0
        return allowed, remaining, reset_ts, retry_after

    async def shutdown(self) -> None:
        """Gracefully stop the background cleanup task."""
        self._running = False
        if self._cleanup_task:
            self._cleanup_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._cleanup_task

    async def _resolve_region(self, org_id: str | None) -> str | None:
        """Resolve the org's region for the ``X-Region-Hint`` header.

        Best-effort: returns ``None`` for any of:
          - no org_id (unauthenticated request)
          - DB lookup error (we'd rather drop the header than fail
            the request)
          - the org exists but has no region set
          - the org doesn't exist

        Results are cached in-process so the lookup is amortised
        across requests for the same org.
        """
        if not org_id:
            return None
        if org_id in self._region_cache:
            return self._region_cache[org_id]
        try:
            from eden.storage.postgres import get_postgres_client
            client = await get_postgres_client()
            row = await client.fetchrow(
                "SELECT region FROM organizations WHERE id = $1",
                org_id,
            )
        except Exception:
            # Best-effort: a DB blip must not break the request.
            logger.warning(
                "tenant_rate_limit: region lookup failed for org %s",
                org_id,
                exc_info=True,
            )
            self._region_cache[org_id] = None
            return None
        region = row.get("region") if row else None
        self._region_cache[org_id] = region
        return region

    async def _resolve_api_key_id(self, request: Request) -> str | None:
        """Resolve the API key id from the X-Org-Api-Key header.

        Prefer :meth:`_resolve_org_and_api_key` on the hot path so
        org + key id share one query. This helper remains for callers
        that only need the key id.
        """
        _org_id, api_key_id = await self._resolve_org_and_api_key(request)
        return api_key_id

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        # Lazy-create the periodic cleanup task on first request. We
        # do this in dispatch (rather than ``__init__``) so a
        # middleware constructed outside a running event loop — a
        # unit test, a bench harness, anything that just wants to
        # inspect the contract — doesn't blow up. Pre-fix this was
        # ``asyncio.create_task(self._periodic_bucket_cleanup())``
        # inside ``__init__``.
        if self._cleanup_task is None:
            try:
                self._cleanup_task = asyncio.create_task(
                    self._periodic_bucket_cleanup()
                )
            except RuntimeError:
                # ``get_event_loop`` raised — no running loop (e.g. the
                # middleware is being constructed or called from a
                # sync context). Skip cleanup; the next request will
                # retry. Better than crashing the request.
                self._cleanup_task = False  # sentinel: don't retry

        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        method = scope.get("method", "GET")

        # ── Skip rate limiting for health checks and CORS preflight ──
        if path == "/health" or method == "OPTIONS":
            await self.app(scope, receive, send)
            return

        # ── Test bypass ──
        # The local-bucket fallback is fine for production (single
        # pod, distributed-rate-limit-capable via Redis) but in
        # tests a TestClient makes many back-to-back requests with
        # the same client IP — the per-IP bucket fills within
        # milliseconds and the suite starts returning 429. Match
        # the quota middleware's ``quota_enabled`` escape hatch
        # so the rate limiter is short-circuited when the test
        # Settings fixture disables it.
        # Pre-fix the import was inside dispatch — module-level
        # caching makes the second-and-later calls free, but the
        # very first call paid the import cost on a hot path.
        if not get_settings().rate_limit_enabled:
            await self.app(scope, receive, send)
            return

        # Build a starlette ``Request`` shim around the scope so the
        # helper methods (``_resolve_org_from_request``,
        # ``_resolve_api_key_id``) still see ``request.headers``,
        # ``request.cookies``, ``request.client`` the same way they
        # always have. This is the standard pure-ASGI pattern for
        # incrementally rewriting a BaseHTTPMiddleware without
        # forking the helper API. The ``Request`` constructor is
        # cheap; the per-request cost is the dict lookups + the
        # ``receive`` awaitable, both negligible vs what we save.
        request = Request(scope, receive)

        # ── Identify the limit key ──
        # Phase 5.1.4: per-API-key limits are tighter than per-org so a
        # single key can't burn the whole org budget. One Postgres
        # round-trip resolves both org_id and api_key_id (same hash
        # used at auth time). Falls back to per-org, then per-IP.
        org_id, api_key_id = await self._resolve_org_and_api_key(request)
        if org_id:
            limit_key = f"key:{api_key_id}" if api_key_id else f"org:{org_id}"
        else:
            # Phase X: delegate to the trusted-proxy-aware client-IP
            # resolver instead of trusting the leftmost XFF hop
            # unconditionally. Pre-fix the leftmost XFF was used as
            # the rate-limit key with no proxy validation, so an
            # attacker could bypass the per-IP limit by sending a
            # different ``X-Forwarded-For`` value on each request
            # (each fresh value gets its own bucket) or focus the
            # rate-limit budget on a victim by spoofing their IP.
            client_ip = get_client_ip(request) or "unknown"
            limit_key = f"ip:{client_ip}"

        # ── Resolve limits ──
        if org_id:
            limit, window, tier = await self._get_tier_limits(org_id)
        else:
            limit, window, tier = self.default_limit, self.default_window, "anonymous"

        # ── Rate-limit check ──
        allowed = True
        remaining = limit
        reset_ts = int(time.time() + window)
        retry_after = 0

        # Prefer in-memory buckets unless RATE_LIMIT_DISTRIBUTED=true.
        # Per-request Redis Lua was the dominant Upstash Free burn.
        # Single get_settings() hop (same source as rate_limit_enabled).
        use_redis = bool(getattr(get_settings(), "rate_limit_distributed", False))
        if use_redis:
            try:
                allowed, remaining, reset_ts, retry_after = await self._check_redis(
                    limit_key, limit, window
                )
            except Exception:
                logger.warning(
                    "tenant_rate_limit: Redis check failed for %s; falling back to local bucket",
                    limit_key,
                    exc_info=True,
                )
                use_redis = False

        if not use_redis:
            refill_rate = limit / window
            bucket = await self._get_bucket(limit_key, limit, refill_rate)
            allowed, remaining, retry_after = await bucket.consume(1.0)
            reset_ts = int(time.time() + window)

        # ── Pre-encode the X-RateLimit-* header values ──
        # The hot path previously did ``response.headers["X-RateLimit-Limit"] = str(limit)``
        # which allocated a new str + did a case-insensitive dict lookup
        # + made a second str allocation for the underlying bytes. We
        # build the bytes once here, outside the inner-app send path.
        bytes_limit = str(limit).encode("latin1")
        bytes_remaining = str(int(remaining)).encode("latin1")
        bytes_reset = str(reset_ts).encode("latin1")
        bytes_policy = tier.encode("latin1")

        # ── 429 reject — inline ASGI form (no JSONResponse round-trip) ──
        if not allowed:
            body = (
                b'{"detail":"Rate limit exceeded. Please slow down or upgrade your plan.","retry_after":'
                + str(int(retry_after)).encode("latin1") + b'}'
            )
            retry_after_bytes = str(int(retry_after)).encode("latin1")
            await send({
                "type": "http.response.start",
                "status": 429,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("latin1")),
                    (_HDR_LIMIT, bytes_limit),
                    (_HDR_REMAINING, b"0"),
                    (_HDR_RESET, bytes_reset),
                    (_HDR_POLICY, bytes_policy),
                    (b"retry-after", retry_after_bytes),
                ],
            })
            await send({"type": "http.response.body", "body": body, "more_body": False})
            return

        # ── Allowed — run inner app with a header-injecting send wrapper ──
        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = message.get("headers") or []
                headers.append((_HDR_LIMIT, bytes_limit))
                headers.append((_HDR_REMAINING, bytes_remaining))
                headers.append((_HDR_RESET, bytes_reset))
                headers.append((_HDR_POLICY, bytes_policy))
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_wrapper)
