"""Simple in-memory rate limiter for auth endpoints.

Provides token-bucket-style rate limiting per IP address.
In production, replace with Redis-backed rate limiting (e.g., slowapi).
"""

import asyncio
import logging
import time
from collections import defaultdict
from typing import Optional

from eden.config import get_settings

settings = get_settings()
logger = logging.getLogger(__name__)


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
        self._buckets: dict[str, list[float]] = defaultdict(list)
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
            # Prune expired entries
            bucket = self._buckets[key]
            self._buckets[key] = [t for t in bucket if t > cutoff]

            if len(self._buckets[key]) >= self.max_requests:
                # Calculate retry-after based on the oldest request in the window
                oldest = min(self._buckets[key])
                retry_after = max(1.0, cutoff + self.window_seconds - oldest)
                raise RateLimitExceeded(retry_after=retry_after)

            self._buckets[key].append(now)

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
