"""F64 — Cap the per-tenant PII policy cache in ``policy_cache.py``.

Pre-F64 the module-level ``_cache`` in
``eden.llmops.policy_cache`` was a plain ``dict`` keyed by
``tenant_id`` with a 60s TTL. The TTL was only checked on
the *next* call; the dict entry lived for the lifetime of
the pod. A long-running gateway pod would accumulate one
stale entry per tenant who ever sent a single LLM call.

F64 keeps the cache as an ``OrderedDict`` with:

* ``_POLICY_CACHE_MAX_ENTRIES`` — hard cap on the number of
  tenant entries.
* ``_evict_expired_policies`` — sweep helper that drops
  entries past their TTL.
* ``_touch_policy`` — LRU bump on every cache hit so
  active tenants survive eviction.

Same pattern as ``pii_policy._cache`` (F64 first site). See
``tests/unit/observability/test_pii_policy_cache_cap_f64.py``.

We test the helpers in isolation by reloading the module
and poking ``_cache`` / ``_POLICY_CACHE_MAX_ENTRIES`` directly.
"""

from __future__ import annotations

from collections import OrderedDict
from unittest.mock import MagicMock

import pytest

from eden.data_platform.pii import PIIPolicy


def _snapshot_helpers():
    """Return the module and clear the cache + pending dict.

    We don't use ``importlib.reload`` (which would clobber
    monkeypatched dependencies from sibling test files).
    Instead we just clear the mutable state before each
    test — that's the correct baseline because the cache
    is an in-process LRU that fills on demand.
    """
    import eden.llmops.policy_cache as mod
    mod._cache.clear()
    mod._pending.clear()
    return mod


class TestF64PolicyCacheIsOrderedDict:
    """``_cache`` is an ``OrderedDict`` (not a plain ``dict``)."""

    def test_cache_is_ordered_dict(self) -> None:
        mod = _snapshot_helpers()
        assert isinstance(mod._cache, OrderedDict), (
            "F64 regression: policy_cache._cache is no longer "
            "an OrderedDict — FIFO eviction cannot work."
        )


class TestF64PolicyCacheCapAndTtlConstants:
    """Pin the production constants."""

    def test_cap_is_non_trivial(self) -> None:
        mod = _snapshot_helpers()
        assert mod._POLICY_CACHE_MAX_ENTRIES >= 256, (
            "F64 cap shrunk too small — at least 256 is "
            "needed for realistic concurrent multi-tenant use"
        )

    def test_ttl_is_60_seconds(self) -> None:
        mod = _snapshot_helpers()
        assert mod._TTL_SECONDS == 60.0, (
            "F64 regression: gateway-side PII policy TTL "
            "drifted away from 60s"
        )


class TestF64TouchPolicyBumpsLru:
    """``_touch_policy`` moves the active tenant to the end
    of the OrderedDict."""

    def test_touch_moves_existing_key_to_end(self) -> None:
        mod = _snapshot_helpers()
        policy = PIIPolicy()
        mod._cache["env_a"] = (mod._now() + 60.0, policy)
        mod._cache["env_b"] = (mod._now() + 60.0, policy)
        mod._touch_policy("env_a")
        keys = list(mod._cache.keys())
        assert keys[-1] == "env_a"
        assert keys[0] == "env_b"

    def test_touch_missing_key_is_noop(self) -> None:
        mod = _snapshot_helpers()
        mod._touch_policy("env_brand_new")
        assert "env_brand_new" not in mod._cache, (
            "F64 regression: _touch_policy inserted a "
            "missing key — the cap is bypassable"
        )

    def test_touch_is_silent_on_exception(self) -> None:
        mod = _snapshot_helpers()
        orig = mod._cache.move_to_end

        def boom(*a, **k):
            raise RuntimeError("simulated OrderedDict failure")

        mod._cache.move_to_end = boom
        try:
            mod._cache["env_x"] = (mod._now() + 60.0, PIIPolicy())
            mod._touch_policy("env_x")  # must not raise
        finally:
            mod._cache.move_to_end = orig


class TestF64EvictExpiredPoliciesDropsStale:
    """``_evict_expired_policies`` drops tenants past their TTL."""

    def test_drops_expired_entries(self) -> None:
        mod = _snapshot_helpers()
        now = mod._now()
        policy = PIIPolicy()
        mod._cache["env_expired"] = (now - 1.0, policy)
        mod._cache["env_fresh"] = (now + 60.0, policy)
        mod._evict_expired_policies(now)
        assert "env_expired" not in mod._cache
        assert "env_fresh" in mod._cache


class TestF64EnforcePolicyCapDropsLru:
    """``_enforce_policy_cap`` keeps
    ``len(_cache) < _POLICY_CACHE_MAX_ENTRIES``."""

    def test_drops_oldest_when_cap_exceeded(self) -> None:
        mod = _snapshot_helpers()
        original = mod._POLICY_CACHE_MAX_ENTRIES
        mod._POLICY_CACHE_MAX_ENTRIES = 3
        now = mod._now()
        policy = PIIPolicy()
        mod._cache["env_a"] = (now + 60.0, policy)
        mod._cache["env_b"] = (now + 60.0, policy)
        mod._cache["env_d"] = (now + 60.0, policy)
        mod._enforce_policy_cap()
        mod._cache["env_e"] = (now + 60.0, policy)
        assert "env_a" not in mod._cache
        assert "env_b" in mod._cache
        assert "env_d" in mod._cache
        assert "env_e" in mod._cache
        assert len(mod._cache) == 3
        mod._POLICY_CACHE_MAX_ENTRIES = original

    def test_cap_loop_terminates_when_empty(self) -> None:
        mod = _snapshot_helpers()
        original = mod._POLICY_CACHE_MAX_ENTRIES
        mod._POLICY_CACHE_MAX_ENTRIES = 0
        mod._cache["env_x"] = (mod._now() + 60.0, PIIPolicy())
        mod._enforce_policy_cap()
        assert len(mod._cache) == 0
        mod._POLICY_CACHE_MAX_ENTRIES = original


class TestF64GetPolicyForTenantTouchesLru:
    """The hot path (``get_policy_for_tenant``) must bump the
    LRU position of the active tenant."""

    def test_get_policy_bumps_lru(self, monkeypatch) -> None:
        mod = _snapshot_helpers()
        now = mod._now()
        policy = PIIPolicy()
        mod._cache["env_first"] = (now + 60.0, policy)
        mod._cache["env_second"] = (now + 60.0, policy)

        # Stub the DB loader to return immediately. Use
        # monkeypatch so the original ``_load_policy`` is
        # restored after this test — without that, subsequent
        # tests in sibling files (which call
        # ``get_policy_for_tenant`` and rely on the
        # stubbed resolver from their own ``monkeypatch``)
        # would see the leftover fake.
        import asyncio

        async def _fake_load(tenant_id):
            return policy
        monkeypatch.setattr(mod, "_load_policy", _fake_load)

        async def _run():
            return await mod.get_policy_for_tenant("env_first")

        asyncio.run(_run())
        keys = list(mod._cache.keys())
        assert keys[-1] == "env_first"


class TestF64SourceLevel:
    """Source-level pin: the F64 helpers / constants /
    patterns appear in the policy_cache module."""

    def test_helpers_defined(self) -> None:
        import inspect

        from eden.llmops import policy_cache

        src = inspect.getsource(policy_cache)
        for name in (
            "_touch_policy",
            "_evict_expired_policies",
            "_enforce_policy_cap",
            "_POLICY_CACHE_MAX_ENTRIES",
        ):
            assert name in src, (
                f"F64 regression: {name} is missing from "
                "policy_cache.py"
            )

    def test_ordereddict_used_in_cache_type(self) -> None:
        import inspect

        from eden.llmops import policy_cache

        src = inspect.getsource(policy_cache)
        assert "OrderedDict" in src, (
            "F64 regression: OrderedDict is missing "
            "from policy_cache.py"
        )
