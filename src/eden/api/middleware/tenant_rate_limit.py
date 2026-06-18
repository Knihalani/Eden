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
import hashlib
import logging
import time

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response

from eden.api.utils.auth import decode_access_token
from eden.config import get_settings
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)
settings = get_settings()


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


class TenantRateLimitMiddleware(BaseHTTPMiddleware):
    """Token-bucket rate limiter scoped per tenant (org).

    Independently resolves the org from the JWT cookie or API key header
    so that per-tenant limits work even though auth dependencies run after
    middleware. Falls back to per-IP limiting for unauthenticated requests.
    """

    def __init__(self, app, default_limit: int = 60, default_window: int = 60):
        super().__init__(app)
        self.default_limit = default_limit
        self.default_window = default_window
        self._buckets: dict[str, TokenBucket] = {}
        self._bucket_lock = asyncio.Lock()
        self._tier_cache: dict[str, tuple[int, int, str, float]] = {}  # org_id -> (limit, window, tier, expires_at)
        self._tier_cache_ttl = 5.0  # seconds
        self._redis = None  # Lazy-load Redis if available
        self._cleanup_task: asyncio.Task | None = None
        self._running = True
        # Start periodic bucket cleanup background task
        self._cleanup_task = asyncio.create_task(self._periodic_bucket_cleanup())

    async def _get_redis(self):
        """Lazy-load Redis client if REDIS_URL is configured."""
        if self._redis is not None:
            return self._redis
        redis_url = getattr(settings, "redis_url", "")
        if redis_url:
            try:
                import redis.asyncio as aioredis
                self._redis = await aioredis.from_url(redis_url, decode_responses=True)
                logger.info("TenantRateLimitMiddleware: Redis backend connected")
            except Exception as exc:
                logger.warning(f"TenantRateLimitMiddleware: Redis unavailable ({exc}), using in-memory fallback")
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
        async with self._bucket_lock:
            # Evict stale buckets (> 5 min idle) to prevent unbounded growth
            cutoff = time.monotonic() - 300
            stale = [k for k, b in self._buckets.items() if b.last_access < cutoff]
            for k in stale:
                del self._buckets[k]
            if key not in self._buckets:
                self._buckets[key] = TokenBucket(capacity, refill_rate)
            return self._buckets[key]

    async def _resolve_org_from_request(self, request: Request) -> str | None:
        """Parse JWT cookie or API key header to extract org_id.

        Mirrors the logic in eden.api.deps but without depending on
        route-level dependency injection.
        """
        # Try API key first (programmatic access)
        api_key = request.headers.get("x-org-api-key")
        org_id_header = request.headers.get("x-org-id")
        if api_key and org_id_header:
            try:
                key_hash = hashlib.sha256(api_key.encode()).hexdigest()
                client = await get_postgres_client()
                row = await client.fetchrow(
                    "SELECT org_id FROM org_api_keys WHERE key_hash = $1 AND org_id = $2",
                    key_hash,
                    org_id_header,
                )
                if row:
                    return str(row["org_id"])
            except Exception:
                pass

        # Try JWT cookie
        token = request.cookies.get("authorization")
        if token:
            payload = decode_access_token(token)
            if payload:
                return payload.get("current_org_id")

        return None

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
        """
        redis = await self._get_redis()
        if not redis:
            raise RuntimeError("Redis not configured")

        now = time.time()
        window_start = now - window
        redis_key = f"ratelimit:{key}"

        pipe = redis.pipeline()
        pipe.zremrangebyscore(redis_key, 0, window_start)
        pipe.zcard(redis_key)
        pipe.zadd(redis_key, {str(now): now})
        pipe.expire(redis_key, window + 1)
        results = await pipe.execute()

        current_count = results[1]  # zcard result before zadd
        allowed = current_count < limit
        remaining = max(0, limit - current_count - (0 if allowed else 1))
        reset_ts = int(now + window)
        retry_after = int(window) if not allowed else 0
        return allowed, remaining, reset_ts, retry_after

    async def shutdown(self) -> None:
        """Gracefully stop the background cleanup task."""
        self._running = False
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass

    async def _resolve_api_key_id(self, request: Request) -> str | None:
        """Resolve the API key id from the X-Org-Api-Key header.

        Returns the key's UUID (suitable for ``key:{id}`` rate limit
        bucketing) or ``None`` if the request isn't using API-key auth
        or the key is invalid. Never raises — the org-level limit
        applies as a fallback.
        """
        api_key = request.headers.get("x-org-api-key")
        org_id = request.headers.get("x-org-id")
        if not api_key or not org_id:
            return None
        try:
            import hashlib
            key_hash = hashlib.sha256(api_key.encode()).hexdigest()
            client = await get_postgres_client()
            row = await client.fetchrow(
                "SELECT id FROM org_api_keys WHERE key_hash = $1 AND org_id = $2",
                key_hash,
                org_id,
            )
            return str(row["id"]) if row else None
        except Exception as exc:
            logger.debug(f"Could not resolve API key id for rate limit: {exc}")
            return None

    async def dispatch(self, request: Request, call_next) -> Response:
        # ── Skip rate limiting for health checks and CORS preflight ──
        if request.url.path == "/health" or request.method == "OPTIONS":
            return await call_next(request)

        # ── Identify the limit key ──
        # Phase 5.1.4: per-API-key limits are tighter than per-org so a
        # single key can't burn the whole org budget. We look up the
        # key_id by hashing the X-Org-Api-Key header (the same hash
        # used at auth time). Falls back to per-org, then per-IP.
        org_id = await self._resolve_org_from_request(request)
        api_key_id: str | None = None
        if org_id:
            api_key_id = await self._resolve_api_key_id(request)
            if api_key_id:
                limit_key = f"key:{api_key_id}"
            else:
                limit_key = f"org:{org_id}"
        else:
            forwarded = request.headers.get("x-forwarded-for", "")
            client_ip = forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else "unknown")
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

        try:
            allowed, remaining, reset_ts, retry_after = await self._check_redis(limit_key, limit, window)
        except Exception:
            refill_rate = limit / window
            bucket = await self._get_bucket(limit_key, limit, refill_rate)
            allowed, remaining, retry_after = await bucket.consume(1.0)
            reset_ts = int(time.time() + window)

        # ── Build response ──
        if not allowed:
            return JSONResponse(
                status_code=429,
                content={
                    "detail": "Rate limit exceeded. Please slow down or upgrade your plan.",
                    "retry_after": int(retry_after),
                },
                headers={
                    "X-RateLimit-Limit": str(limit),
                    "X-RateLimit-Remaining": "0",
                    "X-RateLimit-Reset": str(reset_ts),
                    "X-RateLimit-Policy": tier,
                    "Retry-After": str(int(retry_after)),
                },
            )

        response = await call_next(request)

        # ── Attach rate limit headers ──
        response.headers["X-RateLimit-Limit"] = str(limit)
        response.headers["X-RateLimit-Remaining"] = str(int(remaining))
        response.headers["X-RateLimit-Reset"] = str(reset_ts)
        response.headers["X-RateLimit-Policy"] = tier
        return response
