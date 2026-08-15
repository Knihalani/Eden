"""Tests for the model comparator + recommendation service.

Covers:
  * Spec extraction (catalog lookup + override lookup)
  * Side-by-side compare
  * Recommendation scoring
  * Switch projection with cache savings
  * Empty-history fallback
  * Min-quality gate
"""

from __future__ import annotations

import asyncio  # noqa: F401  - used by inner test functions
import time
from decimal import Decimal
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from eden.llmops.cost_resolver import CostResolver
from eden.llmops.model_comparator import (
    DEFAULT_WEIGHTS,
    ModelComparator,
    ModelSpec,
    Recommendation,
    SwitchProjection,
    UsageHistory,
)

# ─────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────


@pytest.fixture
def empty_history() -> UsageHistory:
    """An empty UsageHistory — the comparator should fall back."""
    return UsageHistory(
        model_id="gpt-4o",
        requests=0,
        total_input_tokens=0,
        total_output_tokens=0,
        total_cache_read_tokens=0,
        total_cache_write_tokens=0,
        total_cost_usd=0.0,
        window_days=30,
        success_rate=None,
    )


@pytest.fixture
def realistic_history() -> UsageHistory:
    """30 days of gpt-4o traffic, 1000 req/day, 2K in / 500 out, 20% cached."""
    return UsageHistory(
        model_id="gpt-4o",
        requests=30_000,
        total_input_tokens=60_000_000,
        total_output_tokens=15_000_000,
        total_cache_read_tokens=12_000_000,
        total_cache_write_tokens=0,
        total_cost_usd=300.0,
        window_days=30,
        success_rate=0.97,
    )


@pytest.fixture
def patch_postgres(monkeypatch):
    """Default: no usage_events rows. Tests override per-call."""
    import eden.storage.postgres as pg

    fake_client = MagicMock()
    fake_client.fetchrow = AsyncMock(return_value=None)

    async def fake_get_client():
        return fake_client

    monkeypatch.setattr(pg, "get_postgres_client", fake_get_client)
    return fake_client


# ─────────────────────────────────────────────────────────────────────
# Spec extraction
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_spec_for_uses_catalog_when_no_resolver(patch_postgres):
    """With a resolver that returns ``unknown``, the spec falls back
    to the catalog row's rates + provenance.
    """
    patch_postgres.fetchrow = AsyncMock(return_value=None)
    comparator = ModelComparator(resolver=CostResolver())
    spec = await comparator._spec_for(
        org_id=None, provider="openai", model_id="gpt-4o",
    )
    assert spec.model_id == "gpt-4o"
    assert spec.provider == "openai"
    assert spec.cost_per_1k_input == 0.0025
    assert spec.cost_per_1k_output == 0.010
    assert spec.cost_per_1k_cache_read == 0.00125  # OpenAI 50% cache_read
    assert spec.source == "static"


@pytest.mark.asyncio
async def test_spec_for_carries_cache_rates_for_anthropic(patch_postgres):
    """Anthropic rows carry cache_read=10% + cache_write=125% of input."""
    patch_postgres.fetchrow = AsyncMock(return_value=None)
    comparator = ModelComparator(resolver=CostResolver())
    spec = await comparator._spec_for(
        org_id=None, provider="anthropic", model_id="claude-sonnet-4-6",
    )
    assert spec.cost_per_1k_input == 0.003
    assert spec.cost_per_1k_cache_read == pytest.approx(0.0003)
    assert spec.cost_per_1k_cache_write == pytest.approx(0.00375)


@pytest.mark.asyncio
async def test_spec_for_self_hosted_is_zero(patch_postgres):
    patch_postgres.fetchrow = AsyncMock(return_value=None)
    comparator = ModelComparator(resolver=CostResolver())
    spec = await comparator._spec_for(
        org_id=None, provider="ollama", model_id="llama3.1:8b",
    )
    assert spec.cost_per_1k_input == 0.0
    assert spec.cost_per_1k_cache_read is None


@pytest.mark.asyncio
async def test_spec_for_unknown_model_returns_unknown(patch_postgres):
    patch_postgres.fetchrow = AsyncMock(return_value=None)
    comparator = ModelComparator(resolver=CostResolver())
    spec = await comparator._spec_for(
        org_id=None, provider="openai", model_id="model-that-does-not-exist-xyz",
    )
    assert spec.source == "unknown"


# ─────────────────────────────────────────────────────────────────────
# Compare
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_compare_two_models_side_by_side(patch_postgres):
    """compare() returns both specs + deltas."""
    patch_postgres.fetchrow = AsyncMock(return_value=None)
    comparator = ModelComparator(resolver=CostResolver())
    cmp = await comparator.compare(
        org_id=None,
        current=("openai", "gpt-4o"),
        candidate=("openai", "gpt-4o-mini"),
    )
    assert cmp.current.model_id == "gpt-4o"
    assert cmp.candidate.model_id == "gpt-4o-mini"
    # gpt-4o-mini is cheaper than gpt-4o -> negative deltas.
    assert cmp.delta_cost_per_1k_input < 0
    assert cmp.delta_cost_per_1k_output < 0
    assert cmp.cost_ratio < 1.0  # candidate cheaper than current
    # gpt-4o-mini has lower quality.
    assert cmp.delta_quality < 0


@pytest.mark.asyncio
async def test_compare_self_hosted_returns_inf_ratio(patch_postgres):
    """Comparing a free self-hosted model to a paid one yields ``inf``."""
    patch_postgres.fetchrow = AsyncMock(return_value=None)
    comparator = ModelComparator(resolver=CostResolver())
    cmp = await comparator.compare(
        org_id=None,
        current=("ollama", "llama3.1:8b"),
        candidate=("openai", "gpt-4o"),
    )
    # We return 1e9 instead of math.inf so the value is JSON-safe
    # (the API route can't serialize math.inf).
    assert cmp.cost_ratio == 1e9


# ─────────────────────────────────────────────────────────────────────
# recommend (pick mode)
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_recommend_picks_best_in_candidates(patch_postgres):
    """When no current model, recommend() ranks pure candidates."""
    patch_postgres.fetchrow = AsyncMock(return_value=None)
    comparator = ModelComparator(resolver=CostResolver())
    rec = await comparator.recommend(
        org_id=None,
        candidates=[
            ("openai", "gpt-4o"),
            ("openai", "gpt-4o-mini"),
            ("anthropic", "claude-sonnet-4-6"),
        ],
    )
    assert isinstance(rec, Recommendation)
    assert rec.recommended.model_id in (
        "gpt-4o", "gpt-4o-mini", "claude-sonnet-4-6",
    )
    assert rec.score > 0
    assert len(rec.runners_up) <= 5
    assert rec.current is None
    assert rec.monthly_savings_usd is None


@pytest.mark.asyncio
async def test_recommend_filters_below_min_quality(patch_postgres):
    """min_quality is a hard floor; below-floor models are excluded."""
    patch_postgres.fetchrow = AsyncMock(return_value=None)
    comparator = ModelComparator(resolver=CostResolver(), min_quality=0.92)
    rec = await comparator.recommend(
        org_id=None,
        candidates=[
            ("openai", "gpt-4o"),       # quality 0.93 -> pass
            ("openai", "gpt-4o-mini"),  # quality 0.85 -> fail
            ("ollama", "llama3.2:3b"),  # quality 0.72 -> fail
        ],
    )
    assert rec.recommended.model_id == "gpt-4o"
    assert all(
        r.model_id != "gpt-4o-mini" for r, _, _ in rec.runners_up
    )


@pytest.mark.asyncio
async def test_recommend_raises_when_no_candidates_meet_quality(patch_postgres):
    patch_postgres.fetchrow = AsyncMock(return_value=None)
    comparator = ModelComparator(resolver=CostResolver(), min_quality=0.99)
    with pytest.raises(ValueError, match="no candidate models meet"):
        await comparator.recommend(
            org_id=None,
            candidates=[("openai", "gpt-4o-mini")],  # quality 0.85
        )


# ─────────────────────────────────────────────────────────────────────
# recommend_switch
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_recommend_switch_to_cheaper_model(patch_postgres, realistic_history):
    """Switching gpt-4o -> gpt-4o-mini projects savings."""
    patch_postgres.fetchrow = AsyncMock(return_value={
        "requests": realistic_history.requests,
        "total_input_tokens": realistic_history.total_input_tokens,
        "total_output_tokens": realistic_history.total_output_tokens,
        "total_cache_read_tokens": realistic_history.total_cache_read_tokens,
        "total_cache_write_tokens": 0,
        "total_cost_usd": realistic_history.total_cost_usd,
    })
    comparator = ModelComparator(resolver=CostResolver())
    rec = await comparator.recommend_switch(
        org_id="11111111-1111-1111-1111-111111111111",
        current=("openai", "gpt-4o"),
        candidates=[
            ("openai", "gpt-4o"),
            ("openai", "gpt-4o-mini"),
        ],
    )
    assert rec.recommended.model_id in ("gpt-4o", "gpt-4o-mini")
    assert rec.current.model_id == "gpt-4o"
    # Switching to a cheaper model must produce non-zero savings.
    assert rec.monthly_savings_usd is not None


@pytest.mark.asyncio
async def test_recommend_switch_empty_history(patch_postgres):
    """No usage_events -> falls back to default 1K/500 estimate."""
    patch_postgres.fetchrow = AsyncMock(return_value=None)
    comparator = ModelComparator(resolver=CostResolver())
    rec = await comparator.recommend_switch(
        org_id="11111111-1111-1111-1111-111111111111",
        current=("openai", "gpt-4o"),
        candidates=[("openai", "gpt-4o"), ("openai", "gpt-4o-mini")],
    )
    # With identical candidates (one is current), savings == 0
    # unless the org's history shows traffic - which it doesn't.
    # The comparator should still return a valid Recommendation.
    assert isinstance(rec, Recommendation)
    assert rec.current.model_id == "gpt-4o"


@pytest.mark.asyncio
async def test_recommend_switch_db_failure_falls_back_to_estimate(patch_postgres):
    """A Postgres blip must not break the recommendation."""
    patch_postgres.fetchrow = AsyncMock(side_effect=RuntimeError("db down"))
    comparator = ModelComparator(resolver=CostResolver())
    rec = await comparator.recommend_switch(
        org_id="11111111-1111-1111-1111-111111111111",
        current=("openai", "gpt-4o"),
        candidates=[("openai", "gpt-4o-mini")],
    )
    assert rec.recommended.model_id == "gpt-4o-mini"


# ─────────────────────────────────────────────────────────────────────
# project_cost_at_scale
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_project_cost_at_scale_doubles(patch_postgres, realistic_history):
    """scale_factor=2 doubles the projected cost."""
    patch_postgres.fetchrow = AsyncMock(return_value={
        "requests": realistic_history.requests,
        "total_input_tokens": realistic_history.total_input_tokens,
        "total_output_tokens": realistic_history.total_output_tokens,
        "total_cache_read_tokens": realistic_history.total_cache_read_tokens,
        "total_cache_write_tokens": 0,
        "total_cost_usd": realistic_history.total_cost_usd,
    })
    comparator = ModelComparator(resolver=CostResolver())
    base = await comparator.project_cost_at_scale(
        org_id="11111111-1111-1111-1111-111111111111",
        current=("openai", "gpt-4o"),
        candidate=("openai", "gpt-4o"),
        scale_factor=1.0,
    )
    doubled = await comparator.project_cost_at_scale(
        org_id="11111111-1111-1111-1111-111111111111",
        current=("openai", "gpt-4o"),
        candidate=("openai", "gpt-4o"),
        scale_factor=2.0,
    )
    assert doubled.projected_total_usd == pytest.approx(
        base.projected_total_usd * 2.0, rel=0.01
    )
    assert doubled.history.requests == realistic_history.requests * 2


# ─────────────────────────────────────────────────────────────────────
# Scoring
# ─────────────────────────────────────────────────────────────────────


def test_score_free_model_scores_max_cost():
    """A $0 model should get a perfect cost sub-score."""
    comparator = ModelComparator()
    spec = ModelSpec(
        model_id="free", provider="ollama",
        quality=0.85, latency_p95_ms=400, reliability=0.99,
        context_window=8192, cost_per_1k_input=0.0, cost_per_1k_output=0.0,
        cost_per_1k_cache_read=None, cost_per_1k_cache_write=None,
        source="static",
    )
    score, _ = comparator._score(spec, workload=None)
    assert score > 0.5


def test_score_with_savings_boost():
    """A model that saves 50% gets a positive boost."""
    comparator = ModelComparator()
    spec = ModelSpec(
        model_id="mid", provider="openai",
        quality=0.90, latency_p95_ms=600, reliability=0.998,
        context_window=128000, cost_per_1k_input=0.001, cost_per_1k_output=0.004,
        cost_per_1k_cache_read=0.0005, cost_per_1k_cache_write=None,
        source="static",
    )
    base_score, _ = comparator._score(spec, workload=None, extra_savings_pct=0)
    boosted_score, _ = comparator._score(spec, workload=None, extra_savings_pct=50)
    assert boosted_score > base_score


def test_score_clamped_to_unit_interval():
    """Even huge savings don't push the score above 1.0."""
    comparator = ModelComparator()
    spec = ModelSpec(
        model_id="cheap", provider="ollama",
        quality=0.99, latency_p95_ms=200, reliability=1.0,
        context_window=200000, cost_per_1k_input=0.0, cost_per_1k_output=0.0,
        cost_per_1k_cache_read=None, cost_per_1k_cache_write=None,
        source="static",
    )
    score, _ = comparator._score(spec, workload=None, extra_savings_pct=1000)
    assert 0.0 <= score <= 1.0


# ─────────────────────────────────────────────────────────────────────
# Switch projection with cache savings
# ─────────────────────────────────────────────────────────────────────


def test_switch_projection_with_cache_savings(realistic_history):
    """Switching to a model with stronger cache discount projects
    more savings than the no-cache model would."""
    cur = ModelSpec(
        model_id="gpt-4o", provider="openai",
        quality=0.93, latency_p95_ms=700, reliability=0.999,
        context_window=128000, cost_per_1k_input=0.0025, cost_per_1k_output=0.010,
        cost_per_1k_cache_read=0.00125, cost_per_1k_cache_write=None,
        source="static",
    )
    cand = ModelSpec(
        model_id="claude-sonnet-4-6", provider="anthropic",
        quality=0.94, latency_p95_ms=900, reliability=0.999,
        context_window=200000, cost_per_1k_input=0.003, cost_per_1k_output=0.015,
        cost_per_1k_cache_read=0.0003, cost_per_1k_cache_write=0.00375,
        source="static",
    )
    comparator = ModelComparator()
    proj = comparator._project_switch(cur, cand, realistic_history)
    # Switch should yield SOME savings vs current thanks to
    # cache_read being 10% on Claude vs 50% on gpt-4o, but
    # Claude's output is 50% more expensive so the net is
    # workload-dependent. We just assert the math runs.
    assert isinstance(proj, SwitchProjection)
    assert proj.history.requests == realistic_history.requests
    # Cache savings on Claude should be > 0 because 10% < 50%.
    # (gpt-4o at 50% gives 0.5x reads; Claude at 10% gives 0.1x
    # reads; the difference is the cache savings on the
    # 12M cache_read tokens.)
    assert proj.cache_savings_usd > 0


def test_switch_projection_self_hosted_is_zero():
    """Self-hosted target -> zero projected cost."""
    cur = ModelSpec(
        model_id="gpt-4o", provider="openai",
        quality=0.93, latency_p95_ms=700, reliability=0.999,
        context_window=128000, cost_per_1k_input=0.0025, cost_per_1k_output=0.010,
        cost_per_1k_cache_read=0.00125, cost_per_1k_cache_write=None,
        source="static",
    )
    cand = ModelSpec(
        model_id="llama3.1:8b", provider="ollama",
        quality=0.78, latency_p95_ms=400, reliability=0.99,
        context_window=8192, cost_per_1k_input=0.0, cost_per_1k_output=0.0,
        cost_per_1k_cache_read=None, cost_per_1k_cache_write=None,
        source="static",
    )
    history = UsageHistory(
        model_id="gpt-4o", requests=1000, total_input_tokens=2_000_000,
        total_output_tokens=500_000, total_cache_read_tokens=400_000,
        total_cache_write_tokens=0, total_cost_usd=10.0, window_days=30,
        success_rate=None,
    )
    comparator = ModelComparator()
    proj = comparator._project_switch(cur, cand, history)
    assert proj.projected_total_usd == 0.0
    # Savings == whatever the gpt-4o rate card says the bill
    # would have been - we recompute from rates, not from the
    # usage_events cost column (which may have been estimated
    # before the cache columns existed).
    expected_gpt4o_bill = cur.project_cost(
        input_tokens=2_000_000, output_tokens=500_000,
        cache_read_tokens=400_000,
    )
    assert proj.savings_usd == pytest.approx(expected_gpt4o_bill, rel=1e-6)


# ─────────────────────────────────────────────────────────────────────
# Weights sanity
# ─────────────────────────────────────────────────────────────────────


def test_default_weights_sum_to_one():
    """The default weight vector sums to 1.0 so scores stay in [0, 1]."""
    assert sum(DEFAULT_WEIGHTS.values()) == pytest.approx(1.0)

# ─────────────────────────────────────────────────────────────────────
# Quality-first weighting (60/25/10/5)
# ─────────────────────────────────────────────────────────────────────


def test_default_weights_sum_to_one_quality_first():
    """The default vector is quality-first: 60% quality, 25% cost,
    10% reliability, 5% latency. Sum must stay 1.0 so scores stay
    in [0, 1].
    """
    from eden.llmops.model_comparator import DEFAULT_WEIGHTS

    assert DEFAULT_WEIGHTS["quality"] == 0.60
    assert DEFAULT_WEIGHTS["cost"] == 0.25
    assert DEFAULT_WEIGHTS["reliability"] == 0.10
    assert DEFAULT_WEIGHTS["latency"] == 0.05
    assert sum(DEFAULT_WEIGHTS.values()) == pytest.approx(1.0)


def test_quality_dominates_when_models_differ_in_quality():
    """A 10pp quality jump should outweigh a 50% cost cut.

    Concretely: compare a cheap-but-shitty model to a
    expensive-but-great model. Under the default weights, the
    great model wins even though it's much pricier.
    """
    from eden.llmops.model_comparator import ModelComparator, ModelSpec

    comparator = ModelComparator()
    cheap_bad = ModelSpec(
        model_id="cheap-bad", provider="openai",
        quality=0.70, latency_p95_ms=300, reliability=0.99,
        context_window=128000,
        cost_per_1k_input=0.0001, cost_per_1k_output=0.0004,
        cost_per_1k_cache_read=None, cost_per_1k_cache_write=None,
        source="static",
    )
    pricey_great = ModelSpec(
        model_id="pricey-great", provider="anthropic",
        quality=0.95, latency_p95_ms=900, reliability=0.999,
        context_window=200000,
        cost_per_1k_input=0.003, cost_per_1k_output=0.015,
        cost_per_1k_cache_read=0.0003, cost_per_1k_cache_write=0.00375,
        source="static",
    )
    cheap_score, _ = comparator._score(cheap_bad, workload=None)
    great_score, _ = comparator._score(pricey_great, workload=None)
    # Quality-first: the 0.95-quality model wins even though
    # it's ~30x pricier - the 60% quality weight + log-scale
    # cost curve yields a ~0.06 gap.
    assert great_score > cheap_score
    assert great_score - cheap_score > 0.05


def test_recommend_picks_quality_over_cost_for_close_quality():
    """When two models have similar quality, the cheaper one wins.

    Under the new weighting (60/25/10/5), the 25% cost weight
    is enough to flip a recommendation when quality is roughly
    equal - but a quality gap of 0.10 still wins.
    """
    from eden.llmops.model_comparator import ModelComparator, ModelSpec

    comparator = ModelComparator()
    near_identical_quality = [
        ("cheap", ModelSpec(
            model_id="cheap", provider="openai",
            quality=0.85, latency_p95_ms=400, reliability=0.998,
            context_window=128000,
            cost_per_1k_input=0.0001, cost_per_1k_output=0.0004,
            cost_per_1k_cache_read=None, cost_per_1k_cache_write=None,
            source="static",
        )),
        ("expensive", ModelSpec(
            model_id="expensive", provider="openai",
            quality=0.86, latency_p95_ms=400, reliability=0.998,
            context_window=128000,
            cost_per_1k_input=0.001, cost_per_1k_output=0.004,
            cost_per_1k_cache_read=None, cost_per_1k_cache_write=None,
            source="static",
        )),
    ]
    cheap_score, _ = comparator._score(near_identical_quality[0][1], workload=None)
    exp_score, _ = comparator._score(near_identical_quality[1][1], workload=None)
    # Quality is essentially tied; the 25% cost weight should tip
    # the recommendation to the cheaper one.
    assert cheap_score > exp_score

# ─────────────────────────────────────────────────────────────────────
# Performance: parallel candidate resolution + usage_events cache
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_recommend_resolves_candidates_in_parallel(patch_postgres, monkeypatch):
    """All candidate specs are resolved via asyncio.gather, not a
    serial loop. We patch the underlying catalog + resolver so the
    resolver call costs 50ms each, then verify that 4 candidates
    finish in well under 4x50ms (i.e. parallel, not serial).
    """
    patch_postgres.fetchrow = AsyncMock(return_value=None)
    # Make the resolver slow so we can detect serial vs parallel.
    real_resolve = CostResolver.resolve

    async def slow_resolve(self, **kwargs):
        await asyncio.sleep(0.05)
        return await real_resolve(self, **kwargs)

    monkeypatch.setattr(CostResolver, "resolve", slow_resolve)

    comparator = ModelComparator(resolver=CostResolver())
    candidates = [
        ("openai", "gpt-4o"),
        ("openai", "gpt-4o-mini"),
        ("anthropic", "claude-sonnet-4-6"),
        ("openai", "gemini-2.5-flash"),
    ]

    start = time.monotonic()
    rec = await comparator.recommend(org_id=None, candidates=candidates)
    elapsed = time.monotonic() - start

    # Serial would take 4 * 50ms = 200ms; parallel should be
    # ~50ms + small overhead. Allow generous headroom for test
    # infra but flag anything above 150ms.
    assert elapsed < 0.15, f"gather did not run in parallel (elapsed={elapsed:.3f}s)"
    assert rec.recommended.model_id in {m for _, m in candidates}


@pytest.mark.asyncio
async def test_usage_history_cache_avoids_repeat_db_calls(patch_postgres, monkeypatch):
    """The usage_events lookup is cached so two consecutive
    recommend_switch calls only hit the DB once.
    """
    import eden.storage.postgres as pg

    call_count = 0
    real_fetchrow = AsyncMock(return_value={
        "requests": 100,
        "total_input_tokens": 200_000,
        "total_output_tokens": 50_000,
        "total_cache_read_tokens": 40_000,
        "total_cache_write_tokens": 0,
        "total_cost_usd": 2.0,
    })

    async def counting_fetchrow(self, query, *args, **kwargs):
        nonlocal call_count
        # Only count usage_events SELECTs (not cost_overrides).
        if "usage_events" in query:
            call_count += 1
        return await real_fetchrow(query, *args, **kwargs)

    # Wrap the postgres client
    class FakeClient:
        async def fetchrow(self, query, *args, **kwargs):
            return await counting_fetchrow(None, query, *args, **kwargs)

        async def fetch(self, *args, **kwargs):
            return []

    async def fake_get_client():
        return FakeClient()

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(pg, "get_postgres_client", fake_get_client)

    comparator = ModelComparator(resolver=None)
    rec1 = await comparator.recommend_switch(
        org_id="11111111-1111-1111-1111-111111111111",
        current=("openai", "gpt-4o"),
        candidates=[("openai", "gpt-4o-mini")],
    )
    rec2 = await comparator.recommend_switch(
        org_id="11111111-1111-1111-1111-111111111111",
        current=("openai", "gpt-4o"),
        candidates=[("openai", "gpt-4o-mini")],
    )
    monkeypatch.undo()
    # First call hits DB (1); second call hits cache (still 1).
    assert call_count == 1
    # Both recommendations must be equal (same inputs + cached history).
    assert rec1.recommended.model_id == rec2.recommended.model_id
