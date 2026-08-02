"""Simple in-memory rate limiter for auth endpoints.

Provides token-bucket-style rate limiting per IP address.
When ``REDIS_URL`` is configured, auth buckets are backed by a
distributed sliding window (sorted-set + Lua) so multi-worker deploys
share counters. Falls back to the in-process deque when Redis is
down or unset.
"""

import asyncio
import logging
import time
from collections import OrderedDict
from typing import Any

from eden.api.utils.redact import redact_all

logger = logging.getLogger(__name__)

# ponytail: global cap on tracked keys; under attack, oldest unpoked
# keys get evicted. 50_000 entries × ~50 bytes each ≈ 2.5 MB cap.
_MAX_TRACKED_KEYS = 50_000

_AUTH_REDIS_PREFIX = "eden:auth-ratelimit"
# Cached Script handle (EVALSHA). Avoids shipping the full Lua source
# on every auth rate-limit check once Redis has the SHA.
_auth_sliding_window_script: Any | None = None
_AUTH_REDIS_TIMEOUT_S = 2.0

_SLIDING_WINDOW_LUA = """
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_start = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local window_seconds = tonumber(ARGV[4])

redis.call("zremrangebyscore", key, 0, window_start)
local count = redis.call("zcard", key)

if count >= max_requests then
    local oldest = redis.call("zrange", key, 0, 0, "withscores")
    local retry_after = window_seconds
    if #oldest > 0 then
        retry_after = math.max(1, (tonumber(oldest[2]) + window_seconds) - now)
    end
    return {-1, retry_after}
end

redis.call("zadd", key, now, now)
redis.call("expire", key, window_seconds + 1)
return {count + 1, 0}
"""


async def _redis_sliding_window_check(
    key: str,
    max_requests: int,
    window_seconds: float,
) -> tuple[bool, float | None]:
    """Distributed auth rate-limit check.

    Returns ``(handled, retry_after)``:
      * ``(True, None)`` — Redis allowed the request (already counted)
      * ``(True, float)`` — Redis denied; ``retry_after`` seconds
      * ``(False, None)`` — Redis unavailable; caller must use in-memory
    """
    global _auth_sliding_window_script

    try:
        from eden.storage.redis import get_redis_client
    except Exception:
        return False, None

    try:
        client = await get_redis_client()
    except Exception:
        return False, None

    if client is None:
        return False, None

    now = time.time()
    window_start = now - window_seconds
    redis_key = f"{_AUTH_REDIS_PREFIX}:{key}"

    try:
        script = _auth_sliding_window_script
        if script is None:
            # Prefer register_script (EVALSHA) when available; fall
            # back to eval for fakes / older clients.
            register = getattr(client, "register_script", None)
            if callable(register):
                script = register(_SLIDING_WINDOW_LUA)
                _auth_sliding_window_script = script
            else:
                script = None

        if script is not None:
            result = await asyncio.wait_for(
                script(
                    keys=[redis_key],
                    args=[
                        now,
                        window_start,
                        max_requests,
                        int(window_seconds) + 1,
                    ],
                ),
                timeout=_AUTH_REDIS_TIMEOUT_S,
            )
        else:
            result = await asyncio.wait_for(
                client.eval(
                    _SLIDING_WINDOW_LUA,
                    1,
                    redis_key,
                    now,
                    window_start,
                    max_requests,
                    int(window_seconds) + 1,
                ),
                timeout=_AUTH_REDIS_TIMEOUT_S,
            )
        if isinstance(result, list) and len(result) == 2 and result[0] == -1:
            return True, float(result[1])
        return True, None
    except Exception as exc:
        logger.debug(
            "auth rate limit Redis path failed: %s",
            redact_all(str(exc)),
        )
        return False, None


class RateLimitExceededError(Exception):
    """Raised when a rate limit is exceeded."""
    def __init__(self, retry_after: float = 60.0):
        self.retry_after = retry_after
        super().__init__(f"Rate limit exceeded. Retry after {retry_after}s.")


class SlidingWindowRateLimiter:
    """Sliding window rate limiter using in-memory storage.

    Tracks request timestamps per key (e.g., IP address) and enforces
    a maximum number of requests within a window.
    """

    def __init__(self, max_requests: int = 10, window_seconds: float = 60.0):
        """
        Args:
            max_requests: Maximum number of requests allowed in the window.
            window_seconds: Size of the sliding window in seconds.
        """
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        # B1.28 — bounded OrderedDict; oldest unpoked keys evicted on overflow.
        self._buckets: OrderedDict[str, list[float]] = OrderedDict()
        self._lock = asyncio.Lock()

    async def check(self, key: str) -> None:
        """Check if the key has exceeded the rate limit.

        Args:
            key: Identifier to rate limit (e.g., IP address, user ID).

        Raises:
            RateLimitExceededError: If the rate limit has been exceeded.
        """
        # Redis path is opt-in (RATE_LIMIT_DISTRIBUTED=true). Default
        # in-memory keeps Upstash Free under the monthly command quota.
        use_redis = False
        try:
            from eden.config import get_settings

            use_redis = bool(get_settings().rate_limit_distributed)
        except Exception:
            use_redis = False

        if use_redis:
            handled, retry_after = await _redis_sliding_window_check(
                key, self.max_requests, self.window_seconds,
            )
            if handled:
                # Redis owned the decision — do not also bump the
                # in-memory window (that previously doubled work and
                # desynced multi-worker counters when distributed).
                if retry_after is not None:
                    raise RateLimitExceededError(retry_after=retry_after)
                return

        now = time.monotonic()
        cutoff = now - self.window_seconds

        async with self._lock:
            # B1.28 — OrderedDict: touch key to mark it recent.
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = []
                self._buckets[key] = bucket
            else:
                self._buckets.move_to_end(key)

            # Prune expired entries for this key.
            bucket[:] = [t for t in bucket if t > cutoff]

            if len(bucket) >= self.max_requests:
                oldest = min(bucket)
                retry_after = max(1.0, cutoff + self.window_seconds - oldest)
                raise RateLimitExceededError(retry_after=retry_after)

            bucket.append(now)

            # B1.28 — evict oldest keys when capacity exceeded.
            while len(self._buckets) > _MAX_TRACKED_KEYS:
                self._buckets.popitem(last=False)

    async def reset(self, key: str) -> None:
        """Reset the rate limit counter for a key."""
        async with self._lock:
            self._buckets[key] = []

    def get_remaining(self, key: str) -> int:
        """Get the number of remaining requests for a key."""
        now = time.monotonic()
        cutoff = now - self.window_seconds
        bucket = [t for t in self._buckets.get(key, []) if t > cutoff]
        return max(0, self.max_requests - len(bucket))


# Global rate limiter instances
# Auth endpoints: stricter limits to prevent brute force
login_limiter = SlidingWindowRateLimiter(max_requests=10, window_seconds=60.0)  # 10 attempts/min
signup_limiter = SlidingWindowRateLimiter(max_requests=5, window_seconds=60.0)   # 5 signups/min from same IP
password_reset_limiter = SlidingWindowRateLimiter(max_requests=3, window_seconds=300.0)  # 3 attempts/5min

# Per-email rate limiter for login (account lockout protection)
login_email_limiter = SlidingWindowRateLimiter(max_requests=5, window_seconds=300.0)  # 5 attempts/5min per email

# 2FA endpoints: strict limits to prevent TOTP brute-force
# 5 verify attempts per 5 minutes per user (based on IP + user_id path)
totp_verify_limiter = SlidingWindowRateLimiter(max_requests=5, window_seconds=300.0)
# 3 setup attempts per 15 minutes per IP
totp_setup_limiter = SlidingWindowRateLimiter(max_requests=3, window_seconds=900.0)
# 3 disable attempts per 15 minutes per IP
totp_disable_limiter = SlidingWindowRateLimiter(max_requests=3, window_seconds=900.0)
