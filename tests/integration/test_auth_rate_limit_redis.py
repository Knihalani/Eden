"""Auth endpoint Redis rate-limit integration tests.

Verifies that :func:`eden.api.utils.rate_limit._redis_sliding_window_check`
enforces a shared sliding window across callers when Redis is available,
and that :class:`SlidingWindowRateLimiter` surfaces ``RateLimitExceeded``
through the Redis path.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.api.utils.rate_limit import (
    RateLimitExceeded,
    SlidingWindowRateLimiter,
    _redis_sliding_window_check,
)


class _FakeRedisSliding:
    """In-memory ZSET + eval for the auth sliding-window Lua script."""

    def __init__(self) -> None:
        self.zsets: dict[str, dict[str, float]] = {}

    async def eval(self, script, numkeys, key, now, window_start, max_requests, window_ttl):  # noqa: ANN001, ARG002
        zset = self.zsets.setdefault(key, {})
        # Prune expired scores.
        for member, score in list(zset.items()):
            if score <= window_start:
                del zset[member]
        count = len(zset)
        if count >= max_requests:
            oldest_score = min(zset.values()) if zset else now
            retry_after = max(1.0, (oldest_score + (now - window_start)) - now + 1)
            return [-1, retry_after]
        zset[str(now)] = float(now)
        return [count + 1, 0]


@pytest.mark.asyncio
async def test_redis_sliding_window_allows_under_cap() -> None:
    fake = _FakeRedisSliding()
    with patch(
        "eden.storage.redis.get_redis_client",
        AsyncMock(return_value=fake),
    ):
        for _ in range(3):
            assert await _redis_sliding_window_check("ip-1", 5, 60.0) is None


@pytest.mark.asyncio
async def test_redis_sliding_window_denies_over_cap() -> None:
    fake = _FakeRedisSliding()
    with patch(
        "eden.storage.redis.get_redis_client",
        AsyncMock(return_value=fake),
    ):
        for _ in range(5):
            assert await _redis_sliding_window_check("ip-block", 5, 60.0) is None
        retry = await _redis_sliding_window_check("ip-block", 5, 60.0)
    assert retry is not None
    assert retry >= 1.0


@pytest.mark.asyncio
async def test_limiter_raises_via_redis_path() -> None:
    """SlidingWindowRateLimiter.check uses Redis when distributed mode is on."""
    fake = _FakeRedisSliding()
    limiter = SlidingWindowRateLimiter(max_requests=3, window_seconds=60.0)

    with (
        patch(
            "eden.storage.redis.get_redis_client",
            AsyncMock(return_value=fake),
        ),
        patch(
            "eden.config.get_settings",
            return_value=type(
                "S",
                (),
                {"rate_limit_distributed": True},
            )(),
        ),
    ):
        for _ in range(3):
            await limiter.check("redis-login-ip")
        with pytest.raises(RateLimitExceeded) as excinfo:
            await limiter.check("redis-login-ip")
        assert excinfo.value.retry_after >= 1.0


@pytest.mark.asyncio
async def test_redis_unavailable_falls_back_to_in_memory() -> None:
    limiter = SlidingWindowRateLimiter(max_requests=2, window_seconds=60.0)
    with patch(
        "eden.storage.redis.get_redis_client",
        AsyncMock(return_value=None),
    ):
        await limiter.check("fallback-ip")
        await limiter.check("fallback-ip")
        with pytest.raises(RateLimitExceeded):
            await limiter.check("fallback-ip")
