"""Tests for the v1.8 Redis Cache L0 layer.

Covers:
- L0 hits short-circuit Redis (no network round-trip)
- L0 expiry is lazy (read returns None on stale entry)
- L0 size bounded by l0_max_entries
- delete() purges both layers
- nx writes only update Redis (no L0 race)
- stats() returns per-layer counts
"""
from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, patch

import pytest

from eden.storage.redis import Cache


def _make_client() -> AsyncMock:
    """Build a mock Redis client that records calls."""
    client = AsyncMock()
    client.get = AsyncMock(return_value=None)
    client.set = AsyncMock(return_value=True)
    client.delete = AsyncMock(return_value=1)
    client.exists = AsyncMock(return_value=1)
    client.incrby = AsyncMock(return_value=1)
    client.expire = AsyncMock(return_value=True)
    return client


@pytest.fixture
def mock_redis():
    with patch("eden.storage.redis.get_redis_client", new=AsyncMock(return_value=_make_client())) as m:
        yield m


# ── L0 hits short-circuit Redis ────────────────────────────────────────


class TestL0Hits:
    @pytest.mark.asyncio
    async def test_first_get_falls_through_to_redis(self, mock_redis):
        c = Cache(prefix="t", default_ttl=60)
        # First call: Redis returns JSON; we cache it.
        mock_redis.return_value.get.return_value = json_dumps({"k": "v"})
        v = await c.get("a")
        assert v == {"k": "v"}
        assert mock_redis.return_value.get.call_count == 1

    @pytest.mark.asyncio
    async def test_second_get_hits_l0(self, mock_redis):
        c = Cache(prefix="t", default_ttl=60)
        mock_redis.return_value.get.return_value = json_dumps({"k": "v"})
        await c.get("a")
        # Second call: L0 hits, Redis is NOT called.
        mock_redis.return_value.get.reset_mock()
        v = await c.get("a")
        assert v == {"k": "v"}
        assert mock_redis.return_value.get.call_count == 0

    @pytest.mark.asyncio
    async def test_lru_bumps_on_access(self, mock_redis):
        c = Cache(prefix="t", default_ttl=60, l0_max_entries=2)
        await c.set("a", 1)
        await c.set("b", 2)
        await c.get("a")  # bump a to MRU
        await c.set("c", 3)  # evicts b (LRU)
        assert c.stats()["l0_size"] == 2
        assert c._l0_get(c._key("a")) == 1
        assert c._l0_get(c._key("b")) is None  # evicted
        assert c._l0_get(c._key("c")) == 3


# ── L0 expiry ──────────────────────────────────────────────────────────


class TestL0Expiry:
    @pytest.mark.asyncio
    async def test_lru_expired_entry_misses(self, mock_redis):
        c = Cache(prefix="t", default_ttl=1)
        await c.set("a", 1)
        # Advance past expiry.
        c._l0[c._key("a")] = (1, time.monotonic() - 1)
        # The mock Redis returns None — the L0 expiry path falls
        # through to Redis which reports a miss.
        v = await c.get("a")
        assert v is None


# ── delete() purges both ──────────────────────────────────────────────


class TestDeletePurge:
    @pytest.mark.asyncio
    async def test_delete_purges_l0(self, mock_redis):
        c = Cache(prefix="t", default_ttl=60)
        await c.set("a", 1)
        assert c._l0_get(c._key("a")) == 1
        await c.delete("a")
        assert c._l0_get(c._key("a")) is None
        assert mock_redis.return_value.delete.call_count == 1

    @pytest.mark.asyncio
    async def test_clear_purges_l0_only(self, mock_redis):
        c = Cache(prefix="t", default_ttl=60)
        await c.set("a", 1)
        c.clear()
        assert c._l0 == {}
        # Redis was NOT touched.
        mock_redis.return_value.delete.assert_not_called()


# ── nx writes ────────────────────────────────────────────────────────


class TestNxWrites:
    @pytest.mark.asyncio
    async def test_nx_does_not_update_l0(self, mock_redis):
        c = Cache(prefix="t", default_ttl=60)
        await c.set("a", 1, nx=True)
        # L0 was NOT updated because nx is a "set only if absent"
        # path that's raced across processes — populating L0 here
        # could desync from Redis on concurrent nx writes.
        assert c._l0_get(c._key("a")) is None
        assert mock_redis.return_value.set.call_count == 1


# ── Stats ─────────────────────────────────────────────────────────────


class TestStats:
    @pytest.mark.asyncio
    async def test_stats_track_layered_hits(self, mock_redis):
        c = Cache(prefix="t", default_ttl=60)
        # side_effect keyed on the input so "missing" returns None.
        def fake_get(key):
            full_key = c._key(key)
            return None if "missing" in full_key else json_dumps({"k": "v"})
        mock_redis.return_value.get.side_effect = fake_get

        await c.get("a")  # miss -> redis hit
        await c.get("a")  # L0 hit
        await c.get("a")  # L0 hit
        await c.get("missing")  # miss -> redis miss

        s = c.stats()
        assert s["l0_hits"] == 2
        assert s["l0_misses"] == 2
        assert s["redis_hits"] == 1
        assert s["redis_misses"] == 1
        assert s["l0_hit_rate"] == 0.5


def json_dumps(obj):
    import json
    return json.dumps(obj)
