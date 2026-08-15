"""Tests for the v1.8 Redis Cache L0 layer.

Covers:
- L0 hits short-circuit Redis (no network round-trip)
- L0 expiry is lazy (read returns None on stale entry)
- L0 size bounded by l0_max_entries
- delete() purges both layers
- nx writes only update Redis (no L0 race)
- stats() returns per-layer counts
- Lua GET+PTTL single-command path (atomic, no GET+PTTL split)
- Graceful fallback to GET+PTTL when eval is unavailable
- @cached decorator routes through L0
"""
from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, patch

import pytest

from eden.storage.redis import Cache, cached


def _make_client() -> AsyncMock:
    """Build a mock Redis client that records calls.

    ``eval`` is wired with a side_effect that delegates to the same
    ``get`` / ``pttl`` mocks so existing tests that set
    ``client.get.return_value`` / ``client.pttl.return_value`` continue
    to exercise the Lua code-path without modification.  New tests that
    want to verify the single-round-trip property reset the side_effect
    and set ``eval.return_value`` directly.
    """
    client = AsyncMock()
    client.get = AsyncMock(return_value=None)
    client.set = AsyncMock(return_value=True)
    client.delete = AsyncMock(return_value=1)
    client.exists = AsyncMock(return_value=1)
    client.incrby = AsyncMock(return_value=1)
    client.expire = AsyncMock(return_value=True)
    # -1 == "no TTL set" (redis-py PTTL semantics). Individual tests
    # override this to simulate a key with a short remaining TTL.
    client.pttl = AsyncMock(return_value=-1)

    # Simulate the Lua GET+PTTL script using the existing get/pttl mocks
    # so that tests configuring those mocks work unchanged via the eval path.
    async def _lua_get_pttl(script: str, num_keys: int, redis_key: str) -> list:
        raw = await client.get(redis_key)
        if raw is None:
            return [0]
        pttl = await client.pttl(redis_key)
        return [1, raw, pttl]

    client.eval = AsyncMock(side_effect=_lua_get_pttl)
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


# ── L0 re-population honors the key's actual TTL (regression) ─────────
#
# Prior bug: Cache.get() always repopulated L0 using self.default_ttl
# (e.g. 300s) regardless of the key's real remaining TTL in Redis. A
# value set with a short custom TTL (ttl=5) that a different request's
# L0-miss re-read near its natural Redis expiry would then be served
# STALE from L0 for up to default_ttl afterwards — a staleness window
# effectively unbounded relative to the intended short TTL.


class TestL0TtlFidelity:
    @pytest.mark.asyncio
    async def test_l0_repopulate_uses_actual_redis_ttl_not_default(self, mock_redis):
        """A key close to its short custom TTL boundary must not be
        cached in L0 for anywhere near the (much larger) default_ttl.
        """
        c = Cache(prefix="t", default_ttl=300)
        # Simulate: value was `set(..., ttl=5)` and this GET lands
        # near the boundary — only 400ms actually remain in Redis.
        mock_redis.return_value.get.return_value = json_dumps({"k": "v"})
        mock_redis.return_value.pttl.return_value = 400  # ms remaining

        before = time.monotonic()
        v = await c.get("a")
        assert v == {"k": "v"}

        _, expiry = c._l0[c._key("a")]
        remaining = expiry - before

        # Must be bounded by the real remaining TTL (rounded up to 1s)
        # plus a small margin — NOT anywhere near default_ttl (300s).
        assert remaining <= 2.0
        assert remaining < c.default_ttl / 10

    @pytest.mark.asyncio
    async def test_l0_entry_does_not_outlive_original_ttl_after_expiry(self, mock_redis):
        """Simulate an L0 miss + Redis re-read right at the custom TTL
        boundary, then fast-forward past it: the L0 entry must have
        expired on its own instead of surviving on default_ttl.
        """
        c = Cache(prefix="t", default_ttl=300)
        mock_redis.return_value.get.return_value = json_dumps({"k": "v"})
        # Key set with ttl=5; re-read happens with ~1s left.
        mock_redis.return_value.pttl.return_value = 1_000  # 1s remaining

        await c.get("a")

        # Fast-forward 3s (past the original short TTL, nowhere near
        # default_ttl) by rewriting the monotonic expiry directly, then
        # confirm the entry is treated as expired.
        value, expiry = c._l0[c._key("a")]
        c._l0[c._key("a")] = (value, expiry - 3.0 - 1.0)
        assert c._l0_get(c._key("a")) is None

    @pytest.mark.asyncio
    async def test_l0_falls_back_to_default_ttl_for_persistent_key(self, mock_redis):
        """A key with no TTL (PTTL == -1) keeps the old default_ttl
        fallback behavior."""
        c = Cache(prefix="t", default_ttl=60)
        mock_redis.return_value.get.return_value = json_dumps({"k": "v"})
        mock_redis.return_value.pttl.return_value = -1

        before = time.monotonic()
        await c.get("a")
        _, expiry = c._l0[c._key("a")]
        assert abs((expiry - before) - 60) < 1.0

    @pytest.mark.asyncio
    async def test_l0_skips_repopulate_on_pttl_race_miss(self, mock_redis):
        """If PTTL reports -2 (key expired/deleted between GET and
        PTTL), the value is still returned to the caller but must NOT
        be repopulated into L0 as if it were still live."""
        c = Cache(prefix="t", default_ttl=60)
        mock_redis.return_value.get.return_value = json_dumps({"k": "v"})
        mock_redis.return_value.pttl.return_value = -2

        v = await c.get("a")
        assert v == {"k": "v"}
        assert c._l0_get(c._key("a")) is None


# ── Lua atomic GET+PTTL path ──────────────────────────────────────────


class TestLuaGetPttl:
    """Verify the single-round-trip Lua path and L0 TTL inheritance."""

    @pytest.mark.asyncio
    async def test_single_eval_call_no_separate_get_pttl(self, mock_redis):
        """On a Redis hit, exactly ONE eval call is issued — no separate
        GET or PTTL commands (production single-round-trip guarantee)."""
        c = Cache(prefix="t", default_ttl=60)

        # Override side_effect so eval doesn't internally call get/pttl.
        mock_redis.return_value.eval.side_effect = None
        mock_redis.return_value.eval.return_value = [1, json_dumps({"k": "v"}), 5_000]

        v = await c.get("a")
        assert v == {"k": "v"}

        # Exactly one Redis command issued.
        assert mock_redis.return_value.eval.call_count == 1
        assert mock_redis.return_value.get.call_count == 0
        assert mock_redis.return_value.pttl.call_count == 0

    @pytest.mark.asyncio
    async def test_lua_miss_no_l0_population(self, mock_redis):
        """A miss ({0} from Lua) must not populate L0."""
        c = Cache(prefix="t", default_ttl=60)

        mock_redis.return_value.eval.side_effect = None
        mock_redis.return_value.eval.return_value = [0]  # miss

        v = await c.get("a")
        assert v is None
        assert c._l0_get(c._key("a")) is None
        assert c.stats()["redis_misses"] == 1

    @pytest.mark.asyncio
    async def test_lua_l0_ttl_inherited_from_pttl(self, mock_redis):
        """The L0 entry expiry must reflect the pttl returned by Lua,
        not the Cache.default_ttl, so that short-TTL keys don't linger
        in L0 past their intended lifetime."""
        c = Cache(prefix="t", default_ttl=300)

        mock_redis.return_value.eval.side_effect = None
        # 400 ms remaining — ceil to 1 s for L0
        mock_redis.return_value.eval.return_value = [1, json_dumps({"x": 1}), 400]

        before = time.monotonic()
        v = await c.get("a")
        assert v == {"x": 1}

        _, expiry = c._l0[c._key("a")]
        remaining = expiry - before
        # Must be ~1 s (ceil of 400 ms), nowhere near default_ttl (300 s).
        assert remaining <= 2.0
        assert remaining < c.default_ttl / 10

    @pytest.mark.asyncio
    async def test_lua_persistent_key_falls_back_to_default_ttl(self, mock_redis):
        """PTTL == -1 (no expiry set) must use default_ttl for L0."""
        c = Cache(prefix="t", default_ttl=60)

        mock_redis.return_value.eval.side_effect = None
        mock_redis.return_value.eval.return_value = [1, json_dumps("val"), -1]

        before = time.monotonic()
        await c.get("a")
        _, expiry = c._l0[c._key("a")]
        assert abs((expiry - before) - 60) < 1.0

    @pytest.mark.asyncio
    async def test_lua_pttl_minus2_skips_l0(self, mock_redis):
        """PTTL == -2 (key vanished race) returns value but skips L0."""
        c = Cache(prefix="t", default_ttl=60)

        mock_redis.return_value.eval.side_effect = None
        mock_redis.return_value.eval.return_value = [1, json_dumps("val"), -2]

        v = await c.get("a")
        assert v == "val"
        assert c._l0_get(c._key("a")) is None


# ── Fallback to GET+PTTL when eval is unavailable ────────────────────────


class TestLuaFallback:
    """Ensure graceful degradation when eval raises any exception."""

    @pytest.mark.asyncio
    async def test_fallback_on_eval_exception(self, mock_redis):
        """When eval raises, Cache.get must fall back to GET+PTTL and
        return the correct value with proper L0 population."""
        c = Cache(prefix="t", default_ttl=300)

        # Simulate eval being unavailable (e.g. test double without Lua)
        mock_redis.return_value.eval.side_effect = Exception("eval unavailable")
        mock_redis.return_value.get.return_value = json_dumps({"k": "v"})
        mock_redis.return_value.pttl.return_value = 2_000  # 2 s remaining

        v = await c.get("a")
        assert v == {"k": "v"}

        # Fallback commands were issued.
        assert mock_redis.return_value.get.call_count == 1
        assert mock_redis.return_value.pttl.call_count == 1

        # L0 was populated with the actual pttl (ceil 2000 ms → 2 s).
        _, expiry = c._l0[c._key("a")]
        remaining = expiry - time.monotonic()
        assert 1.0 <= remaining <= 3.0

    @pytest.mark.asyncio
    async def test_fallback_miss_returns_none(self, mock_redis):
        """Fallback with get() → None must return None (no L0 pollution)."""
        c = Cache(prefix="t", default_ttl=60)

        mock_redis.return_value.eval.side_effect = Exception("no eval")
        # get returns None → cache miss
        mock_redis.return_value.get.return_value = None

        v = await c.get("missing")
        assert v is None
        assert c._l0_get(c._key("missing")) is None
        assert c.stats()["redis_misses"] == 1

    @pytest.mark.asyncio
    async def test_fallback_get_exception_returns_none(self, mock_redis):
        """If both eval AND get raise, Cache.get must soft-fail to None."""
        c = Cache(prefix="t", default_ttl=60)

        mock_redis.return_value.eval.side_effect = Exception("no eval")
        mock_redis.return_value.get.side_effect = Exception("connection lost")

        v = await c.get("boom")
        assert v is None


# ── @cached decorator routes through L0 ──────────────────────────────────


class TestCachedDecorator:
    """Verify that the @cached decorator uses the L0 layer."""

    @pytest.mark.asyncio
    async def test_cached_populates_l0_on_first_call(self, mock_redis):
        """First call should hit Redis; subsequent calls must hit L0."""
        call_count = 0

        @cached(ttl=60, prefix="t")
        async def expensive(x: int) -> dict:
            nonlocal call_count
            call_count += 1
            return {"value": x * 2}

        # Wire eval so it returns a miss on first call (nothing cached yet)
        mock_redis.return_value.eval.side_effect = None
        mock_redis.return_value.eval.return_value = [0]  # Redis miss initially

        result1 = await expensive(5)
        assert result1 == {"value": 10}
        assert call_count == 1

        # Now the result should be in L0; route eval to return a hit too
        # but the L0 layer must intercept before reaching Redis.
        mock_redis.return_value.eval.side_effect = None
        mock_redis.return_value.eval.return_value = [1, json_dumps({"value": 10}), 60_000]
        mock_redis.return_value.eval.reset_mock()

        result2 = await expensive(5)
        assert result2 == {"value": 10}
        # L0 hit — Redis (eval) must NOT have been called.
        assert mock_redis.return_value.eval.call_count == 0
        assert call_count == 1  # underlying function not called again

    @pytest.mark.asyncio
    async def test_cached_preserves_redis_key_namespace(self, mock_redis):
        """The key passed to the underlying Cache must match the original
        decorator's key format ``{prefix}:{func_name}:{hash}``."""
        observed_keys: list[str] = []

        async def _capturing_eval(script, num_keys, redis_key):
            observed_keys.append(redis_key)
            return [0]  # miss — always recompute

        mock_redis.return_value.eval.side_effect = _capturing_eval

        @cached(ttl=30, prefix="myns")
        async def lookup(q: str) -> str:
            return q.upper()

        await lookup("hello")

        assert len(observed_keys) == 1
        key = observed_keys[0]
        # Must start with "myns:lookup:" (no extra prefix from Cache)
        assert key.startswith("myns:lookup:"), key


def json_dumps(obj):
    import json
    return json.dumps(obj)
