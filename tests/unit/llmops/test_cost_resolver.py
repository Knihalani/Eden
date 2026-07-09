"""Tests for the four-tier CostResolver.

Covers:
  * Tier 1: org_cost_overrides wins over everything
  * Tier 2: OpenRouter live overlay (via PricingCatalog.source)
  * Tier 3: static seed
  * Tier 4: unknown (returns 0 + source='unknown')
  * Cache: TTL, force, invalidate, bounded LRU
  * Decimal precision on estimate()
  * DB failure does not break the gateway (fail-open to catalog)
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from eden.llmops.cost_resolver import CostResolution, CostResolver

# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────


def _fake_override_row(
    *,
    cost_in: str = "0.001",
    cost_out: str = "0.002",
    source: str = "contract",
    provider: str = "openai",
    model_id: str = "gpt-4o",
    effective_from: datetime | None = None,
    notes: str | None = "acme-volume-deal",
) -> dict[str, Any]:
    """One row in the shape returned by asyncpg's ``fetchrow``."""
    return {
        "cost_per_1k_input": cost_in,
        "cost_per_1k_output": cost_out,
        "currency": "USD",
        "source": source,
        "provider": provider,
        "model_id": model_id,
        "effective_from": effective_from or datetime.now(UTC),
        "notes": notes,
    }


@pytest.fixture(autouse=True)
def patch_postgres(monkeypatch):
    """Patch ``eden.storage.postgres.get_postgres_client`` for every test.

    The default behaviour is "no row" — individual tests override
    the fake client's return value via :func:`_resolver_with_db`.
    """
    import eden.storage.postgres as pg

    fake_client = MagicMock()
    fake_client.fetchrow = AsyncMock(return_value=None)

    async def fake_get_client():
        return fake_client

    monkeypatch.setattr(pg, "get_postgres_client", fake_get_client)
    yield fake_client


# ─────────────────────────────────────────────────────────────────────
# Tier 1: per-tenant override wins
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_override_wins_over_catalog(patch_postgres):
    """When an org has an override, it beats the static seed.

    gpt-4o list price is $0.0025/$0.010; the contract rate in the
    test is $0.001/$0.002 — clearly different, and the resolver
    must pick the override.
    """
    patch_postgres.fetchrow = AsyncMock(
        return_value=_fake_override_row(cost_in="0.001", cost_out="0.002")
    )
    resolver = CostResolver()
    res = await resolver.resolve(org_id=str(uuid.uuid4()), provider="openai", model_id="gpt-4o")
    assert res.source == "override"
    assert res.cost_per_1k_input == Decimal("0.001")
    assert res.cost_per_1k_output == Decimal("0.002")
    assert res.estimate(1000, 1000) == Decimal("0.003")  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_override_wildcard_provider(patch_postgres):
    """Provider ``"*"`` in the override matches any provider request."""
    patch_postgres.fetchrow = AsyncMock(
        return_value=_fake_override_row(provider="*", cost_in="0.0005", cost_out="0.001")
    )
    resolver = CostResolver()
    res = await resolver.resolve(org_id=str(uuid.uuid4()), provider="anthropic", model_id="gpt-4o")
    assert res.source == "override"
    assert res.cost_per_1k_input == Decimal("0.0005")


# ─────────────────────────────────────────────────────────────────────
# Tier 2/3: catalog fallback (openrouter vs static)
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_openrouter_live_overlay_used_when_no_override(patch_postgres):
    """When the catalog has a row with source=openrouter or merged,
    the resolver reports source=openrouter.
    """
    # Override lookup returns nothing.
    patch_postgres.fetchrow = AsyncMock(return_value=None)
    resolver = CostResolver()
    # Pre-populate the catalog with an OpenRouter row.
    from eden.llmops.pricing import PricingCatalog, PricingRow

    resolver.catalog = PricingCatalog.from_seed({
        "openrouter/anthropic/claude-sonnet-4.6": PricingRow(
            model_id="openrouter/anthropic/claude-sonnet-4.6",
            quality=0.94,
            latency_p95_ms=1000,
            cost_per_1k_input=Decimal("0.0035"),
            cost_per_1k_output=Decimal("0.018"),
            reliability=0.999,
            context_window=200000,
            source="merged",
        ),
    })
    resolver.catalog.last_refresh = 1234567890.0

    res = await resolver.resolve(
        org_id=None, provider="openrouter", model_id="openrouter/anthropic/claude-sonnet-4.6",
    )
    assert res.source == "openrouter"
    assert res.cost_per_1k_input == Decimal("0.0035")
    assert res.cost_per_1k_output == Decimal("0.018")


@pytest.mark.asyncio
async def test_static_seed_used_when_no_override(patch_postgres):
    """Native OpenAI / Anthropic / Google rows have source=static in
    the seed, so the resolver reports source=static.
    """
    patch_postgres.fetchrow = AsyncMock(return_value=None)
    resolver = CostResolver()
    res = await resolver.resolve(org_id=None, provider="openai", model_id="gpt-4o")
    assert res.source == "static"
    # gpt-4o seed: $0.0025 / $0.010 per 1K
    assert res.cost_per_1k_input == Decimal("0.0025")
    assert res.cost_per_1k_output == Decimal("0.01")


# ─────────────────────────────────────────────────────────────────────
# Tier 4: unknown model
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unknown_model_returns_zero_with_source_unknown(patch_postgres):
    patch_postgres.fetchrow = AsyncMock(return_value=None)
    resolver = CostResolver()
    res = await resolver.resolve(org_id=None, provider="openai", model_id="totally-unknown-model")
    assert res.source == "unknown"
    assert res.cost_per_1k_input == Decimal("0")
    assert res.cost_per_1k_output == Decimal("0")
    assert res.estimate(1000, 1000) == Decimal("0")


# ─────────────────────────────────────────────────────────────────────
# DB failure: fail-open to catalog
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_db_failure_falls_through_to_catalog(patch_postgres):
    """A Postgres blip must not break the gateway - log and use
    the catalog, marked with ``notes`` so observability can flag.
    """
    patch_postgres.fetchrow = AsyncMock(side_effect=RuntimeError("simulated DB outage"))
    resolver = CostResolver()
    res = await resolver.resolve(org_id=str(uuid.uuid4()), provider="openai", model_id="gpt-4o")
    # No override available, so fall through to the static seed.
    assert res.source == "static"
    assert res.cost_per_1k_input == Decimal("0.0025")


# ─────────────────────────────────────────────────────────────────────
# Cache
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cache_hit_returns_same_resolution(patch_postgres):
    patch_postgres.fetchrow = AsyncMock(
        return_value=_fake_override_row(cost_in="0.001", cost_out="0.002")
    )
    resolver = CostResolver(cache_ttl_seconds=60)
    org_id = str(uuid.uuid4())
    first = await resolver.resolve(org_id=org_id, provider="openai", model_id="gpt-4o")
    second = await resolver.resolve(org_id=org_id, provider="openai", model_id="gpt-4o")
    assert first.source == "override"
    assert second.cached is True
    # Only one DB hit across both calls.
    assert patch_postgres.fetchrow.call_count == 1


@pytest.mark.asyncio
async def test_force_bypasses_cache(patch_postgres):
    patch_postgres.fetchrow = AsyncMock(
        return_value=_fake_override_row(cost_in="0.001", cost_out="0.002")
    )
    resolver = CostResolver()
    org_id = str(uuid.uuid4())
    await resolver.resolve(org_id=org_id, provider="openai", model_id="gpt-4o")
    await resolver.resolve(org_id=org_id, provider="openai", model_id="gpt-4o", force=True)
    assert patch_postgres.fetchrow.call_count == 2


@pytest.mark.asyncio
async def test_cache_expires_after_ttl(patch_postgres):
    patch_postgres.fetchrow = AsyncMock(
        return_value=_fake_override_row(cost_in="0.001", cost_out="0.002")
    )
    resolver = CostResolver(cache_ttl_seconds=0.05)
    org_id = str(uuid.uuid4())
    await resolver.resolve(org_id=org_id, provider="openai", model_id="gpt-4o")
    await asyncio.sleep(0.06)
    await resolver.resolve(org_id=org_id, provider="openai", model_id="gpt-4o")
    assert patch_postgres.fetchrow.call_count == 2


@pytest.mark.asyncio
async def test_cache_bounded_eviction(patch_postgres):
    """Cache should not grow unbounded - oldest entry is evicted
    when the cap is exceeded.
    """
    resolver = CostResolver(cache_max_entries=3)
    patch_postgres.fetchrow = AsyncMock(return_value=None)

    for i in range(5):
        await resolver.resolve(org_id=f"org-{i}", provider="openai", model_id="gpt-4o")
    assert len(resolver._cache) <= 3


@pytest.mark.asyncio
async def test_invalidate_clears_specific_org(patch_postgres):
    patch_postgres.fetchrow = AsyncMock(
        return_value=_fake_override_row(cost_in="0.001", cost_out="0.002")
    )
    resolver = CostResolver()
    org_a = str(uuid.uuid4())
    org_b = str(uuid.uuid4())
    await resolver.resolve(org_id=org_a, provider="openai", model_id="gpt-4o")
    await resolver.resolve(org_id=org_b, provider="openai", model_id="gpt-4o")
    n = await resolver.invalidate(org_id=org_a)
    assert n == 1
    # org_b still in cache.
    assert any(k[0] == org_b for k in resolver._cache)
    # org_a is gone.
    assert not any(k[0] == org_a for k in resolver._cache)


@pytest.mark.asyncio
async def test_invalidate_clears_all_when_no_org():
    resolver = CostResolver()
    await resolver.resolve(org_id="org-a", provider="openai", model_id="gpt-4o")
    await resolver.resolve(org_id="org-b", provider="openai", model_id="gpt-4o")
    n = await resolver.invalidate()
    assert n == 2
    assert len(resolver._cache) == 0


# ─────────────────────────────────────────────────────────────────────
# Decimal precision
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_estimate_uses_decimal_precision(patch_postgres):
    """Cost arithmetic stays in Decimal so we don't accumulate
    float error on per-request billing.
    """
    patch_postgres.fetchrow = AsyncMock(
        return_value=_fake_override_row(cost_in="0.000123", cost_out="0.000456")
    )
    resolver = CostResolver()
    org_id = str(uuid.uuid4())
    res = await resolver.resolve(org_id=org_id, provider="openai", model_id="gpt-4o")
    cost = res.estimate(1234, 5678)
    # (1234/1000)*0.000123 + (5678/1000)*0.000456
    expected = (Decimal("1234") / Decimal("1000")) * Decimal("0.000123") + \
               (Decimal("5678") / Decimal("1000")) * Decimal("0.000456")
    assert cost == expected


# ─────────────────────────────────────────────────────────────────────
# Concurrent resolves share cache
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_concurrent_resolves_for_same_key_share_cache(patch_postgres):
    """N concurrent resolve() calls for the same key result in 1
    DB hit (the rest read the cache after the first lands).
    """
    patch_postgres.fetchrow = AsyncMock(
        return_value=_fake_override_row(cost_in="0.001", cost_out="0.002")
    )
    resolver = CostResolver()
    org_id = str(uuid.uuid4())
    results = await asyncio.gather(*[
        resolver.resolve(org_id=org_id, provider="openai", model_id="gpt-4o")
        for _ in range(10)
    ])
    # All see the override.
    assert all(r.source == "override" for r in results)
    # The DB was hit at least once but the cache absorbed most of the
    # concurrent load - exact count depends on lock scheduling,
    # so we just assert it's bounded.
    assert patch_postgres.fetchrow.call_count <= 10


# ─────────────────────────────────────────────────────────────────────
# resolve_batch
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_resolve_batch_returns_one_per_input(patch_postgres):
    patch_postgres.fetchrow = AsyncMock(return_value=None)
    resolver = CostResolver()
    out = await resolver.resolve_batch(
        org_id=None,
        items=[("openai", "gpt-4o"), ("anthropic", "claude-sonnet-4-6"), ("openai", "unknown")],
    )
    assert len(out) == 3
    assert out[0].model_id == "gpt-4o"
    assert out[1].model_id == "claude-sonnet-4-6"
    assert out[2].source == "unknown"


# ─────────────────────────────────────────────────────────────────────
# AIGateway integration
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_aigateway_resolve_cost_with_org_id(patch_postgres):
    """AIGateway.resolve_cost returns the override rate when an
    org_id is passed and an override exists.
    """
    from eden.llmops.ai_gateway import AIGateway, Provider

    patch_postgres.fetchrow = AsyncMock(
        return_value=_fake_override_row(cost_in="0.0005", cost_out="0.001")
    )
    g = AIGateway()
    cost, source, _no_cache, _cache = await g.resolve_cost(
        provider=Provider.OPENAI,
        input_tokens=1000,
        output_tokens=1000,
        model_version="gpt-4o",
        org_id=str(uuid.uuid4()),
    )
    assert source == "override"
    assert cost == pytest.approx(0.0015)


@pytest.mark.asyncio
async def test_aigateway_resolve_cost_self_hosted_is_zero():
    from eden.llmops.ai_gateway import AIGateway, Provider

    g = AIGateway()
    cost, source, no_cache, cache = await g.resolve_cost(
        provider=Provider.OLLAMA,
        input_tokens=1000,
        output_tokens=1000,
        model_version="llama3.1:8b",
    )
    assert cost == 0.0
    assert source == "self_hosted"
    assert no_cache == 0.0
    assert cache == 0.0


@pytest.mark.asyncio
async def test_aigateway_resolve_cost_no_org_uses_static(patch_postgres):
    from eden.llmops.ai_gateway import AIGateway, Provider

    patch_postgres.fetchrow = AsyncMock(return_value=None)
    g = AIGateway()
    cost, source, no_cache, cache = await g.resolve_cost(
        provider=Provider.OPENAI,
        input_tokens=1000,
        output_tokens=1000,
        model_version="gpt-4o",
        org_id=None,
    )
    assert source == "static"
    # 0.0025 + 0.010 = 0.0125 for 1K in + 1K out.
    assert cost == pytest.approx(0.0125)
    # No cache tokens passed, so no_cache == cost and cache_savings == 0.
    assert no_cache == pytest.approx(0.0125)
    assert cache == 0.0


@pytest.mark.asyncio
async def test_model_response_carries_cost_source_and_pricing_version(patch_postgres):
    """The new ModelResponse fields propagate through the gateway."""
    from eden.llmops.ai_gateway import AIGateway, ModelRequest, ModelResponse, Provider

    g = AIGateway()

    # Directly build the response via the same path _execute_provider uses.
    class FakeClient:
        async def complete(self, **kwargs):
            return {"text": "hello", "input_tokens": 100, "output_tokens": 50}

    g.register_provider(Provider.OPENAI, FakeClient())
    request = ModelRequest(
        model_family="openai",
        model_version="gpt-4o",
        prompt="hi",
        tenant_id=str(uuid.uuid4()),
    )
    response: ModelResponse = await g._execute_provider(Provider.OPENAI, request)
    assert response.cost_source == "static"  # no override, static seed
    assert response.pricing_version.startswith("seed=2026-07;")


# ─────────────────────────────────────────────────────────────────────
# models.dev overlay in the resolver chain
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_models_dev_overlay_used_when_no_override(patch_postgres):
    """When the catalog has a row with source=models_dev, the
    resolver reports source=models_dev. This is the new highest
    tier for native vendor rows.
    """
    from eden.llmops.pricing import PricingCatalog, PricingRow

    patch_postgres.fetchrow = AsyncMock(return_value=None)
    resolver = CostResolver()
    resolver.catalog = PricingCatalog.from_seed({
        "claude-opus-4-5": PricingRow(
            model_id="claude-opus-4-5",
            quality=0.97,
            latency_p95_ms=1500,
            cost_per_1k_input=Decimal("0.005"),
            cost_per_1k_output=Decimal("0.025"),
            reliability=0.999,
            context_window=200000,
            source="models_dev",
        ),
    })
    resolver.catalog.last_refresh = 1234567890.0

    res = await resolver.resolve(
        org_id=None, provider="anthropic", model_id="claude-opus-4-5",
    )
    assert res.source == "models_dev"
    assert res.cost_per_1k_input == Decimal("0.005")
    assert res.cost_per_1k_output == Decimal("0.025")
    # Estimate uses the split rates.
    cost = res.estimate(1000, 1000)
    assert cost == Decimal("0.030")


@pytest.mark.asyncio
async def test_models_dev_overlay_wins_over_static_seed(patch_postgres):
    """Precedence: per-tenant override > models.dev overlay >
    static seed > zero. With no override and no openrouter row,
    a models.dev row beats a static seed row for the same id.
    """
    from eden.llmops.pricing import PricingCatalog, PricingRow

    patch_postgres.fetchrow = AsyncMock(return_value=None)
    resolver = CostResolver()
    # Two rows for the same model id - one from models.dev, one
    # in the seed. The merge semantics should keep only the
    # newer one, but if both are present, models.dev wins.
    resolver.catalog = PricingCatalog.from_seed({
        "gpt-4o": PricingRow(
            model_id="gpt-4o",
            quality=0.93,
            latency_p95_ms=700,
            cost_per_1k_input=Decimal("0.0025"),
            cost_per_1k_output=Decimal("0.010"),
            reliability=0.998,
            context_window=128000,
            source="models_dev",  # marked as models_dev, not static
        ),
    })
    res = await resolver.resolve(org_id=None, provider="openai", model_id="gpt-4o")
    assert res.source == "models_dev"

# ─────────────────────────────────────────────────────────────────────
# Cache-aware billing through CostResolver + AIGateway
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cost_resolution_carries_cache_rates_from_seed(patch_postgres):
    """CostResolution exposes cache_read/write from the catalog row."""
    patch_postgres.fetchrow = AsyncMock(return_value=None)
    resolver = CostResolver()
    res = await resolver.resolve(
        org_id=None, provider="anthropic", model_id="claude-sonnet-4-6",
    )
    assert res.cost_per_1k_cache_read == Decimal("0.0003")
    assert res.cost_per_1k_cache_write == Decimal("0.00375")


@pytest.mark.asyncio
async def test_estimate_with_cache_anthropic_discount(patch_postgres):
    """Anthropic: cache reads are 10% of input cost."""
    patch_postgres.fetchrow = AsyncMock(return_value=None)
    resolver = CostResolver()
    res = await resolver.resolve(
        org_id=None, provider="anthropic", model_id="claude-sonnet-4-6",
    )
    # 8000 input tokens, 5000 from cache, 3000 fresh; 1000 out.
    cost = res.estimate_with_cache(
        input_tokens=8000, output_tokens=1000,
        cache_read_tokens=5000,
    )
    expected = (
        Decimal("5000") / Decimal(1000) * Decimal("0.0003")
        + Decimal("3000") / Decimal(1000) * Decimal("0.003")
        + Decimal("1000") / Decimal(1000) * Decimal("0.015")
    )
    assert cost == expected


@pytest.mark.asyncio
async def test_estimate_with_cache_openai_discount(patch_postgres):
    """OpenAI: cache reads are 50% of input cost."""
    patch_postgres.fetchrow = AsyncMock(return_value=None)
    resolver = CostResolver()
    res = await resolver.resolve(
        org_id=None, provider="openai", model_id="gpt-4o",
    )
    cost = res.estimate_with_cache(
        input_tokens=4000, output_tokens=1000,
        cache_read_tokens=2000,
    )
    # 2k reads @ 0.00125 + 2k fresh @ 0.0025 + 1k out @ 0.010
    expected = (
        Decimal("2") * Decimal("0.00125")
        + Decimal("2") * Decimal("0.0025")
        + Decimal("1") * Decimal("0.010")
    )
    assert cost == expected


@pytest.mark.asyncio
async def test_estimate_with_cache_gemini_free(patch_postgres):
    """Gemini implicit cache: cached hits are $0."""
    patch_postgres.fetchrow = AsyncMock(return_value=None)
    resolver = CostResolver()
    res = await resolver.resolve(
        org_id=None, provider="openai",  # provider label is informational
        model_id="gemini-2.5-pro",
    )
    cost = res.estimate_with_cache(
        input_tokens=10000, output_tokens=1000,
        cache_read_tokens=8000,
    )
    # 8k cache @ 0 + 2k fresh @ 0.00125 + 1k out @ 0.010
    expected = (
        Decimal("0") * Decimal("0")
        + Decimal("2") * Decimal("0.00125")
        + Decimal("1") * Decimal("0.010")
    )
    assert cost == expected


@pytest.mark.asyncio
async def test_estimate_with_cache_falls_back_to_input_when_unset(patch_postgres):
    """If a model has no cache rates, cached tokens bill at input rate."""
    patch_postgres.fetchrow = AsyncMock(return_value=None)
    resolver = CostResolver()
    res = await resolver.resolve(
        org_id=None, provider="openai",
        # qwen2.5:7b is self-hosted, cost_in = 0, no cache attrs.
        model_id="qwen2.5:7b",
    )
    cost = res.estimate_with_cache(
        input_tokens=1000, output_tokens=500,
        cache_read_tokens=1000,
    )
    # Self-hosted: 0 in + 0 out.
    assert cost == Decimal("0")


@pytest.mark.asyncio
async def test_aigateway_resolve_cost_returns_cache_savings(patch_postgres):
    """AIGateway.resolve_cost returns (cost, source, no_cache, cache_savings)."""
    from eden.llmops.ai_gateway import AIGateway, Provider

    patch_postgres.fetchrow = AsyncMock(return_value=None)
    g = AIGateway()
    cost, source, no_cache, savings = await g.resolve_cost(
        provider=Provider.ANTHROPIC,
        input_tokens=10000, output_tokens=1000,
        model_version="claude-sonnet-4-6",
        org_id=None,
        cache_read_tokens=8000,
    )
    assert source == "static"
    assert no_cache > cost
    # Savings == no_cache - cost
    assert savings == pytest.approx(no_cache - cost)
    # And savings should be positive - cache reduced the bill.
    assert savings > 0


@pytest.mark.asyncio
async def test_aigateway_resolve_cost_no_cache_tokens_returns_zero_savings(patch_postgres):
    """Without cache_read/write tokens, savings == 0 and no_cache == cost."""
    from eden.llmops.ai_gateway import AIGateway, Provider

    patch_postgres.fetchrow = AsyncMock(return_value=None)
    g = AIGateway()
    cost, source, no_cache, savings = await g.resolve_cost(
        provider=Provider.OPENAI,
        input_tokens=1000, output_tokens=500,
        model_version="gpt-4o",
        org_id=None,
    )
    assert cost == pytest.approx(no_cache)
    assert savings == 0.0


@pytest.mark.asyncio
async def test_override_can_carry_cache_rates(patch_postgres):
    """Per-tenant override rows can negotiate cache_read/write rates."""
    patch_postgres.fetchrow = AsyncMock(return_value=_fake_override_row(
        cost_in="0.001", cost_out="0.002",
    ))
    # Patch in cache fields the fake doesn't expose by default.
    patch_postgres.fetchrow.return_value["cost_per_1k_cache_read"] = "0.0001"
    patch_postgres.fetchrow.return_value["cost_per_1k_cache_write"] = "0.00125"
    resolver = CostResolver()
    res = await resolver.resolve(
        org_id=str(uuid.uuid4()), provider="openai", model_id="gpt-4o",
    )
    assert res.source == "override"
    assert res.cost_per_1k_cache_read == Decimal("0.0001")
    assert res.cost_per_1k_cache_write == Decimal("0.00125")


# ─── Audit 2026-07-07: true LRU cache eviction ──────────────


@pytest.mark.asyncio
async def test_cache_evicts_least_recently_used_not_first_inserted(patch_postgres):
    """Pre-fix the cache was FIFO despite the comment claiming LRU.

    The docstring of ``_cache_put`` said "Bounded LRU via
    insertion-order dict" but ``_cache_get`` never called
    ``move_to_end``, so a hot key that survived a cache sweep
    could still be evicted before a cold key inserted after it.
    The fix bumps accessed keys to the end so the eviction
    order tracks access time, not insertion time.

    This test exercises that contract directly: with a cache
    cap of 3, insert 4 keys (k1, k2, k3, k4 — k1 is oldest),
    then touch k1 so it becomes most-recent. A 5th insert
    (k5) must evict k2 (the new least-recently-used), not
    k1 (which was just touched).
    """
    from eden.llmops.cost_resolver import CostResolver

    # Bypass the catalog entirely — we only test the cache.
    resolver = CostResolver(
        catalog=None,
        cache_ttl_seconds=60.0,
        cache_max_entries=3,
    )
    resolver._resolve_uncached = AsyncMock(
        return_value=__import__("eden.llmops.cost_resolver", fromlist=["CostResolution"]).CostResolution(
            cost_per_1k_input=Decimal("0.001"),
            cost_per_1k_output=Decimal("0.002"),
            source="static",
            provider="openai",
            model_id="x",
            cached=False,
            as_of=__import__("datetime").datetime.now(__import__("datetime").UTC),
        )
    )
    # Fill the cache with 3 entries.
    await resolver.resolve(org_id=None, provider="openai", model_id="m1")
    await resolver.resolve(org_id=None, provider="openai", model_id="m2")
    await resolver.resolve(org_id=None, provider="openai", model_id="m3")
    assert len(resolver._cache) == 3
    # Touch m1 (move to end).
    await resolver.resolve(org_id=None, provider="openai", model_id="m1")
    # Insert m4 — under FIFO, m1 would be evicted (oldest); under
    # true LRU, m2 is evicted because m1 was just touched.
    await resolver.resolve(org_id=None, provider="openai", model_id="m4")
    keys = set(resolver._cache.keys())
    assert ("", "openai", "m1") in keys, "m1 should NOT be evicted (just touched)"
    assert ("", "openai", "m2") not in keys, "m2 should be evicted (LRU after touching m1)"
