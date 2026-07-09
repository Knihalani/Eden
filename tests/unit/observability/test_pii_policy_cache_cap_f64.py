"""F64 — Cap the per-tenant PII policy cache in ``pii_policy.py``.

Pre-F64 the module-level ``_cache: dict[str, tuple[float, PIIPolicy]]``
in ``eden.observability.ingestion.pii_policy`` was a plain ``dict``
keyed by ``tenant_id`` with a 60s TTL. The TTL was only checked on
the *next* call for that tenant; the dict entry lived for the
lifetime of the pod. A long-running pod would accumulate one
stale entry per tenant who ever sent a single event.

F64 keeps the cache as an ``OrderedDict`` with:

* ``_POLICY_CACHE_MAX_ENTRIES`` — hard cap on the number of
  tenant entries. Once exceeded, the least-recently-touched
  tenant is dropped.
* ``_evict_expired_pii_policies`` — sweep helper that drops
  entries past their TTL.
* ``_touch_pii_policy`` — LRU bump on every cache hit so
  active tenants survive eviction.

The same fix is applied symmetrically to
``llmops.policy_cache._cache`` (F64 second site). See
``tests/unit/llmops/test_policy_cache_cap_f64.py``.

We test the helpers in isolation by reloading the module
and poking ``_cache`` / ``_POLICY_CACHE_MAX_ENTRIES`` directly.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from unittest.mock import MagicMock

import pytest

from eden.data_platform.pii import PIIPolicy


def _snapshot_helpers():
    """Return the module and a callable that clears the
    state without ``importlib.reload`` (which would clobber
    monkeypatched dependencies from sibling test files).

    Unlike F61's _reload_helpers, we DON'T snapshot the
    pre-test cache — we just provide a ``_clear`` callable
    that empties the cache before each test. The cache
    starts empty by design (it's an in-process LRU that
    fills on demand), so a fresh-empty state is the
    correct baseline for every test.
    """
    import eden.observability.ingestion.pii_policy as mod
    mod._cache.clear()
    return mod


class TestF64PiiPolicyCacheIsOrderedDict:
    """``_cache`` is an ``OrderedDict`` (not a plain ``dict``) so
    the F64 FIFO cap and LRU bump can work."""

    def test_cache_is_ordered_dict(self) -> None:
        mod = _snapshot_helpers()
        assert isinstance(mod._cache, OrderedDict), (
            "F64 regression: pii_policy._cache is no longer "
            "an OrderedDict — FIFO eviction cannot work."
        )


class TestF64PiiPolicyCapAndTtlConstants:
    """Pin the production constants so a future refactor
    doesn't accidentally shrink the cap or extend the TTL."""

    def test_cap_is_non_trivial(self) -> None:
        mod = _snapshot_helpers()
        assert mod._POLICY_CACHE_MAX_ENTRIES >= 256, (
            "F64 cap shrunk too small — at least 256 is "
            "needed for realistic concurrent multi-tenant use"
        )

    def test_ttl_is_60_seconds(self) -> None:
        mod = _snapshot_helpers()
        assert mod._POLICY_CACHE_TTL_SECONDS == 60.0, (
            "F64 regression: PII policy TTL drifted away "
            "from 60s — would break the documented "
            "policy-propagation contract"
        )

    def test_cap_matches_policy_cache(self) -> None:
        """Both PII policy caches share the cap. If a future
        PR tunes one, it should tune both."""
        from eden.llmops import policy_cache

        mod = _snapshot_helpers()
        assert mod._POLICY_CACHE_MAX_ENTRIES == policy_cache._POLICY_CACHE_MAX_ENTRIES, (
            "F64 cap diverged between pii_policy and "
            "policy_cache — operators tune via one constant "
            "but expect both paths to share the cap."
        )


class TestF64TouchPiiPolicyBumpsLru:
    """``_touch_pii_policy`` moves the active tenant to the end
    of the OrderedDict so a subsequent eviction pass doesn't
    drop an active tenant."""

    def test_touch_moves_existing_key_to_end(self) -> None:
        mod = _snapshot_helpers()
        policy = PIIPolicy()
        mod._cache["env_a"] = (mod.time.monotonic() + 60.0, policy)
        mod._cache["env_b"] = (mod.time.monotonic() + 60.0, policy)
        mod._touch_pii_policy("env_a")
        keys = list(mod._cache.keys())
        assert keys[-1] == "env_a"
        assert keys[0] == "env_b"

    def test_touch_missing_key_is_noop(self) -> None:
        """Touching a brand-new tenant must NOT create an
        entry. The OrderedDict should only grow via the
        resolve_policy path, not via the touch helper."""
        mod = _snapshot_helpers()
        mod._touch_pii_policy("env_brand_new")
        assert "env_brand_new" not in mod._cache, (
            "F64 regression: _touch_pii_policy inserted a "
            "missing key — the cap is bypassable"
        )

    def test_touch_is_silent_on_exception(self) -> None:
        """Best-effort housekeeping: a transient bookkeeping
        error must NOT propagate out of ``_touch_pii_policy``."""
        mod = _snapshot_helpers()
        orig = mod._cache.move_to_end

        def boom(*a, **k):
            raise RuntimeError("simulated OrderedDict failure")

        mod._cache.move_to_end = boom
        try:
            mod._cache["env_x"] = (mod.time.monotonic() + 60.0, PIIPolicy())
            mod._touch_pii_policy("env_x")  # must not raise
        finally:
            mod._cache.move_to_end = orig


class TestF64EvictExpiredPiiPoliciesDropsStale:
    """``_evict_expired_pii_policies`` drops tenants whose
    cached entry's TTL has elapsed. Without it, idle
    tenants pinned keys in the dict for the pod lifetime."""

    def test_drops_expired_entries(self) -> None:
        mod = _snapshot_helpers()
        now = mod.time.monotonic()
        policy = PIIPolicy()
        mod._cache["env_expired"] = (now - 1.0, policy)
        mod._cache["env_fresh"] = (now + 60.0, policy)
        mod._evict_expired_pii_policies(now)
        assert "env_expired" not in mod._cache
        assert "env_fresh" in mod._cache

    def test_keeps_fresh_entries(self) -> None:
        mod = _snapshot_helpers()
        now = mod.time.monotonic()
        policy = PIIPolicy()
        mod._cache["env_a"] = (now + 30.0, policy)
        mod._cache["env_b"] = (now + 60.0, policy)
        mod._evict_expired_pii_policies(now)
        assert "env_a" in mod._cache
        assert "env_b" in mod._cache


class TestF64EnforcePiiPolicyCapDropsLru:
    """``_enforce_pii_policy_cap`` keeps
    ``len(_cache) < _POLICY_CACHE_MAX_ENTRIES`` by evicting
    the least-recently-touched entry (the head of the
    OrderedDict)."""

    def test_drops_oldest_when_cap_exceeded(self) -> None:
        mod = _snapshot_helpers()
        original = mod._POLICY_CACHE_MAX_ENTRIES
        mod._POLICY_CACHE_MAX_ENTRIES = 3
        now = mod.time.monotonic()
        policy = PIIPolicy()
        mod._cache["env_a"] = (now + 60.0, policy)
        mod._cache["env_b"] = (now + 60.0, policy)
        mod._cache["env_d"] = (now + 60.0, policy)
        mod._enforce_pii_policy_cap()
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
        mod._cache["env_x"] = (mod.time.monotonic() + 60.0, PIIPolicy())
        mod._enforce_pii_policy_cap()
        assert len(mod._cache) == 0
        mod._POLICY_CACHE_MAX_ENTRIES = original


class TestF64ResolvePolicyTouchesLru:
    """The hot path (``resolve_policy``) must bump the LRU
    position of the active tenant so it survives a
    subsequent cap-eviction triggered by a churning
    one-shot tenant."""

    def test_resolve_policy_bumps_lru(self, monkeypatch) -> None:
        mod = _snapshot_helpers()
        now = mod.time.monotonic()
        policy = PIIPolicy()
        mod._cache["env_first"] = (now + 60.0, policy)
        mod._cache["env_second"] = (now + 60.0, policy)
        # resolve_policy touches the active tenant. We don't
        # care about the returned policy here — just the
        # LRU position.
        asyncio_run = __import__("asyncio").run

        async def _fake_load(tenant_id):
            return policy
        # Use monkeypatch so the original ``_load_policy_from_db``
        # is restored after this test — without that,
        # subsequent tests in sibling files (which monkey-patch
        # ``resolve_policy``) would see the leftover fake.
        monkeypatch.setattr(mod, "_load_policy_from_db", _fake_load)

        async def _run():
            return await mod.resolve_policy("env_first")

        asyncio_run(_run())
        keys = list(mod._cache.keys())
        assert keys[-1] == "env_first"


class TestF64SourceLevel:
    """Source-level pin: the F64 helpers / constants /
    patterns appear in the pii_policy module so a future
    refactor doesn't quietly delete the cap."""

    def test_helpers_defined(self) -> None:
        import inspect

        from eden.observability.ingestion import pii_policy

        src = inspect.getsource(pii_policy)
        for name in (
            "_touch_pii_policy",
            "_evict_expired_pii_policies",
            "_enforce_pii_policy_cap",
            "_POLICY_CACHE_MAX_ENTRIES",
        ):
            assert name in src, (
                f"F64 regression: {name} is missing from "
                "pii_policy.py"
            )

    def test_ordereddict_used_in_cache_type(self) -> None:
        import inspect

        from eden.observability.ingestion import pii_policy

        src = inspect.getsource(pii_policy)
        assert "OrderedDict" in src, (
            "F64 regression: OrderedDict is missing "
            "from pii_policy.py"
        )
