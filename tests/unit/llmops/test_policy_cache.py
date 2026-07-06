"""Tests for the gateway-side per-tenant PII policy cache.

The cache is the gateway's hot path for resolving which PII policy
applies to a tenant's request. We don't hit Postgres on every call
(the DB resolver is async + adds latency), so this module wraps it
in an in-process LRU keyed by tenant_id.

These tests stub out the underlying ``resolve_policy`` so we can
exercise the cache mechanics without touching Postgres.
"""

from __future__ import annotations

import asyncio

import pytest


@pytest.fixture
def stub_resolver(monkeypatch):
    """Replace the DB resolver with an in-memory table. The tests
    set per-tenant policies and verify the cache returns them.
    """
    table: dict[str, dict] = {}
    load_counts: dict[str, int] = {}

    async def _fake_resolve(tenant_id):
        load_counts[tenant_id] = load_counts.get(tenant_id, 0) + 1
        return table.get(tenant_id, {"default": True})

    monkeypatch.setattr(
        "eden.observability.ingestion.pii_policy.resolve_policy",
        _fake_resolve,
    )

    def _set(tenant_id, policy):
        table[tenant_id] = policy

    return {"table": table, "set": _set, "loads": load_counts}


@pytest.fixture
def fresh_cache(monkeypatch):
    """Reset the policy_cache module-level cache between tests so
    cache state doesn't leak across tests."""
    from eden.llmops import policy_cache
    policy_cache._cache.clear()
    policy_cache._pending.clear()
    yield policy_cache


class TestCacheBasic:
    def test_first_call_loads_and_caches(
        self, fresh_cache, stub_resolver
    ):
        from eden.llmops.policy_cache import get_policy_for_tenant

        stub_resolver["set"]("org-A", {"enabled": ["email"]})

        async def _run():
            return await get_policy_for_tenant("org-A")

        policy = asyncio.run(_run())
        assert policy == {"enabled": ["email"]}
        # Exactly one DB load.
        assert stub_resolver["loads"]["org-A"] == 1

    def test_second_call_within_ttl_uses_cache(
        self, fresh_cache, stub_resolver
    ):
        from eden.llmops.policy_cache import get_policy_for_tenant

        stub_resolver["set"]("org-A", {"enabled": ["email"]})

        async def _run():
            await get_policy_for_tenant("org-A")
            await get_policy_for_tenant("org-A")
            return await get_policy_for_tenant("org-A")

        asyncio.run(_run())
        # All three calls hit the same cache entry — exactly one load.
        assert stub_resolver["loads"]["org-A"] == 1

    def test_invalidate_drops_cache_entry(
        self, fresh_cache, stub_resolver
    ):
        from eden.llmops.policy_cache import get_policy_for_tenant, invalidate

        async def _run():
            stub_resolver["set"]("org-A", {"v": 1})
            p1 = await get_policy_for_tenant("org-A")
            assert p1 == {"v": 1}
            # Policy changes in the DB after the first call.
            stub_resolver["set"]("org-A", {"v": 2})
            # Cache still serves the old value — invalidate first.
            p_cached = await get_policy_for_tenant("org-A")
            assert p_cached == {"v": 1}
            invalidate("org-A")
            return await get_policy_for_tenant("org-A")

        p2 = asyncio.run(_run())
        assert p2 == {"v": 2}
        # Two loads: first call, then again after invalidation.
        assert stub_resolver["loads"]["org-A"] == 2


class TestCacheFailOpen:
    def test_resolver_failure_returns_default(
        self, fresh_cache, monkeypatch
    ):
        """When the DB resolver raises, the cache returns a default
        policy rather than crashing the gateway."""
        from eden.llmops.policy_cache import get_policy_for_tenant
        from eden.data_platform.pii import PIIPolicy

        async def _boom(tenant_id):
            raise RuntimeError("DB unreachable")

        monkeypatch.setattr(
            "eden.observability.ingestion.pii_policy.resolve_policy",
            _boom,
        )

        async def _run():
            return await get_policy_for_tenant("org-X")

        policy = asyncio.run(_run())
        # Default policy: redact mode, full category set.
        assert policy.mode == "redact"
        assert "email" in policy.active_categories


class TestCacheNoTenant:
    def test_none_tenant_returns_default(self, fresh_cache):
        """``tenant_id=None`` short-circuits the DB and returns the
        default policy — used when the request has no org context
        (anonymous, pre-auth, etc.)."""
        from eden.llmops.policy_cache import get_policy_for_tenant

        async def _run():
            return await get_policy_for_tenant(None)

        policy = asyncio.run(_run())
        assert policy.mode == "redact"
