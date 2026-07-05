"""Simple in-memory rate limiter for auth endpoints.

Provides token-bucket-style rate limiting per IP address.
In production, replace with Redis-backed rate limiting (e.g., slowapi).

Audit 2026-06-22 B1.28 — bounded OrderedDict with TTL eviction so
the bucket map cannot grow unbounded under attack.
"""

import asyncio
import logging
import time
from collections import OrderedDict

from eden.config import get_settings

settings = get_settings()
logger = logging.getLogger(__name__)

# ponytail: global cap on tracked keys; under attack, oldest unpoked
# keys get evicted. 50_000 entries × ~50 bytes each ≈ 2.5 MB cap.
_MAX_TRACKED_KEYS = 50_000


class RateLimitExceeded(Exception):
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
            RateLimitExceeded: If the rate limit has been exceeded.
        """
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
                raise RateLimitExceeded(retry_after=retry_after)

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
