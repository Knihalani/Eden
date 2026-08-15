"""Wave 8.5 — Redis cache/session soft-degrade (align Wave 1.3).

Redis is a soft dep for Cache (feature reads → None) and SessionStore
(feature ops → None/False so routes can map to 503 without a bare 500).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.storage.redis import Cache, SessionStore


def _broken_client() -> AsyncMock:
    client = AsyncMock()
    client.get = AsyncMock(side_effect=ConnectionError("redis blip"))
    client.set = AsyncMock(side_effect=ConnectionError("redis blip"))
    client.delete = AsyncMock(side_effect=ConnectionError("redis blip"))
    client.exists = AsyncMock(side_effect=ConnectionError("redis blip"))
    client.incrby = AsyncMock(side_effect=ConnectionError("redis blip"))
    client.expire = AsyncMock(side_effect=ConnectionError("redis blip"))
    client.mget = AsyncMock(side_effect=ConnectionError("redis blip"))
    # eval must also raise so Cache.get() falls through to the GET fallback
    # (which raises too) and ultimately soft-fails to None.
    client.eval = AsyncMock(side_effect=ConnectionError("redis blip"))
    return client


@pytest.fixture
def broken_redis():
    with patch(
        "eden.storage.redis.get_redis_client",
        new=AsyncMock(return_value=_broken_client()),
    ) as m:
        yield m


class TestCacheSoftDegrade:
    @pytest.mark.asyncio
    async def test_get_returns_none_on_redis_error(self, broken_redis):
        c = Cache(prefix="t", default_ttl=60)
        assert await c.get("k") is None

    @pytest.mark.asyncio
    async def test_exists_returns_false_on_redis_error(self, broken_redis):
        c = Cache(prefix="t", default_ttl=60)
        assert await c.exists("k") is False

    @pytest.mark.asyncio
    async def test_increment_returns_zero_on_redis_error(self, broken_redis):
        c = Cache(prefix="t", default_ttl=60)
        assert await c.increment("k") == 0

    @pytest.mark.asyncio
    async def test_delete_returns_false_on_redis_error(self, broken_redis):
        c = Cache(prefix="t", default_ttl=60)
        assert await c.delete("k") is False

    @pytest.mark.asyncio
    async def test_expire_returns_false_on_redis_error(self, broken_redis):
        c = Cache(prefix="t", default_ttl=60)
        assert await c.expire("k", 10) is False


class TestSessionStoreSoftDegrade:
    @pytest.mark.asyncio
    async def test_get_returns_none_on_redis_error(self, broken_redis):
        s = SessionStore(prefix="t:sess", default_ttl=60)
        assert await s.get("sid") is None

    @pytest.mark.asyncio
    async def test_create_returns_false_on_redis_error(self, broken_redis):
        s = SessionStore(prefix="t:sess", default_ttl=60)
        assert await s.create("sid", {"a": 1}) is False

    @pytest.mark.asyncio
    async def test_mget_returns_nones_on_redis_error(self, broken_redis):
        s = SessionStore(prefix="t:sess", default_ttl=60)
        assert await s.mget(["a", "b"]) == [None, None]
