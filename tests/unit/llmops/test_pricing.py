"""Tests for the live + cached pricing catalog.

Covers:
  * :class:`PricingCatalog` lookup + TTL behaviour
  * :func:`default_seed_rows` covers every model the existing
    ``MODEL_PERFORMANCE`` table had (no regressions on the public
    surface)
  * OpenRouter ``/models`` parsing — both the "merge into existing"
    path and the "add new row" path
  * Cost calculation uses the catalog when present and falls back
    to the legacy table when absent
  * Concurrent refresh calls share a single in-flight task
"""

from __future__ import annotations

import asyncio
import time
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from eden.llmops.ai_gateway import AIGateway, ModelRequest, Provider
from eden.llmops.pricing import (
    DEFAULT_TTL_SECONDS,
    PricingCatalog,
    PricingRow,
    default_seed_rows,
)

# ─────────────────────────────────────────────────────────────────────
# Seed
# ─────────────────────────────────────────────────────────────────────


def test_default_seed_covers_all_models_in_legacy_performance_table():
    """No silent regressions on the model list.

    The legacy :attr:`AIGateway.MODEL_PERFORMANCE` table is the
    contract callers have been relying on. The seed in
    :func:`default_seed_rows` should include every model id the
    legacy table listed, so legacy callers that look up a model by
    id still get a row.

    We deliberately don't compare costs row-for-row — the legacy
    table used a single **blended** rate while the seed uses
    **split** input/output rates, and the legacy numbers were
    training-data estimates flagged as approximate. Cost is checked
    explicitly against verified public pricing in the per-vendor
    tests below.
    """
    seed = default_seed_rows()
    legacy = AIGateway.MODEL_PERFORMANCE

    missing = [model_id for model_id in legacy if model_id not in seed]
    assert not missing, f"seed missing legacy models: {missing}"


def test_seed_has_verified_openai_pricing():
    """Spot-check a few well-known OpenAI list prices.

    Source of truth for these numbers is the OpenAI pricing page
    as of mid-2026. If a vendor page changes, update the seed AND
    bump ``_SEED_LAST_REFRESH``.
    """
    seed = default_seed_rows()
    # gpt-4o: $2.50 / $10.00 per 1M tokens → 0.0025 / 0.010 per 1K.
    gpt4o = seed["gpt-4o"]
    assert gpt4o.cost_per_1k_input == pytest.approx(0.0025)
    assert gpt4o.cost_per_1k_output == pytest.approx(0.010)
    # gpt-5: $1.25 / $10.00 per 1M.
    gpt5 = seed["gpt-5"]
    assert gpt5.cost_per_1k_input == pytest.approx(0.00125)
    assert gpt5.cost_per_1k_output == pytest.approx(0.010)
    # o1: $15 / $60 per 1M.
    o1 = seed["o1"]
    assert o1.cost_per_1k_input == pytest.approx(0.015)
    assert o1.cost_per_1k_output == pytest.approx(0.060)


def test_seed_has_verified_anthropic_pricing():
    seed = default_seed_rows()
    sonnet = seed["claude-sonnet-4-6"]
    assert sonnet.cost_per_1k_input == pytest.approx(0.003)
    assert sonnet.cost_per_1k_output == pytest.approx(0.015)
    opus = seed["claude-opus-4-5"]
    assert opus.cost_per_1k_input == pytest.approx(0.015)
    assert opus.cost_per_1k_output == pytest.approx(0.075)


def test_seed_self_hosted_has_zero_cost():
    """Local inference (Ollama / vLLM / LM Studio / llama.cpp) has
    no per-token cost — the user runs it on their own GPU.
    """
    seed = default_seed_rows()
    for model_id in [
        "llama3.1:8b",
        "qwen3:32b",
        "gemma3:27b",
        "meta-llama/Llama-3.1-8B-Instruct",
    ]:
        row = seed[model_id]
        assert row.cost_per_1k_input == 0.0, f"{model_id} input cost != 0"
        assert row.cost_per_1k_output == 0.0, f"{model_id} output cost != 0"


def test_seed_has_provider_placeholder_for_openrouter_prefixed_models():
    """The seed includes OpenRouter-style prefixed ids so the
    pre-refresh routing decision doesn't fall back to the legacy
    blended estimate.
    """
    seed = default_seed_rows()
    assert "anthropic/claude-sonnet-4.6" in seed
    assert "openai/gpt-5" in seed
    assert "google/gemini-3-pro" in seed


# ─────────────────────────────────────────────────────────────────────
# Catalog lookups
# ─────────────────────────────────────────────────────────────────────


def test_default_catalog_returns_seed():
    catalog = PricingCatalog.default()
    assert len(catalog) == len(default_seed_rows())
    gpt4o = catalog.lookup("gpt-4o")
    assert gpt4o is not None
    assert gpt4o.source == "static"


def test_catalog_lookup_returns_none_for_unknown_model():
    catalog = PricingCatalog.default()
    assert catalog.lookup("nonexistent-model-xyz") is None


def test_catalog_contains_and_len():
    catalog = PricingCatalog.default()
    assert "gpt-4o" in catalog
    assert "nonexistent" not in catalog
    assert len(catalog) >= 30  # at least the seed rows


def test_pricing_row_blended_rate():
    """``cost_per_1k_blended`` is the average of input + output,
    used by routing decisions (which don't track input/output mix).
    """
    row = PricingRow(
        model_id="test",
        quality=0.9,
        latency_p95_ms=500,
        cost_per_1k_input=0.001,
        cost_per_1k_output=0.003,
        reliability=0.99,
    )
    assert row.cost_per_1k_blended == pytest.approx(0.002)


# ─────────────────────────────────────────────────────────────────────
# Freshness + TTL
# ─────────────────────────────────────────────────────────────────────


def test_catalog_starts_not_fresh():
    """A never-refreshed catalog is not fresh — the first lookup
    should trigger a refresh.
    """
    catalog = PricingCatalog.default()
    assert catalog.last_refresh == 0.0
    assert not catalog.is_fresh()


def test_catalog_is_fresh_after_manual_refresh():
    catalog = PricingCatalog.default()
    catalog.last_refresh = time.time()
    assert catalog.is_fresh()


def test_catalog_is_stale_after_ttl():
    catalog = PricingCatalog.default(ttl_seconds=0.1)
    catalog.last_refresh = time.time() - 1.0
    assert not catalog.is_fresh()


# ─────────────────────────────────────────────────────────────────────
# OpenRouter refresh — synchronous merger
# ─────────────────────────────────────────────────────────────────────


def _openrouter_row(model_id: str, prompt: str, completion: str, ctx: int = 0) -> dict[str, Any]:
    """Helper that produces one entry in OpenRouter's /models response."""
    return {
        "id": model_id,
        "name": model_id,
        "context_length": ctx,
        "pricing": {"prompt": prompt, "completion": completion, "request": "0", "image": "0"},
    }


def test_merge_openrouter_updates_existing_static_row():
    """When OpenRouter reports a model we already seed, the cost
    columns get overwritten with the live rates; quality/latency
    estimates from the seed are preserved.
    """
    catalog = PricingCatalog.default()
    assert catalog.lookup("openai/gpt-5") is not None
    pre = catalog.lookup("openai/gpt-5")
    # OpenRouter advertises GPT-5 at a slightly different rate
    # ($1.30 / $10.50 per 1M, i.e. 0.0000013 / 0.0000105 per token).
    n = catalog._merge_openrouter_rows([
        _openrouter_row("openai/gpt-5", "0.0000013", "0.0000105", ctx=128000),
    ])
    assert n == 1
    row = catalog.lookup("openai/gpt-5")
    assert row is not None
    assert row.cost_per_1k_input == pytest.approx(0.0013)
    assert row.cost_per_1k_output == pytest.approx(0.0105)
    assert row.context_window == 128000
    assert row.source == "merged"
    # Quality/latency preserved from the seed.
    assert row.quality == pre.quality
    assert row.latency_p95_ms == pre.latency_p95_ms


def test_merge_openrouter_adds_new_row():
    catalog = PricingCatalog.default()
    # Brand-new model OpenRouter just listed.
    n = catalog._merge_openrouter_rows([
        _openrouter_row("acme/newest-model", "0.000002", "0.000006", ctx=32000),
    ])
    assert n == 1
    row = catalog.lookup("acme/newest-model")
    assert row is not None
    assert row.source == "openrouter"
    assert row.cost_per_1k_input == pytest.approx(0.002)
    assert row.cost_per_1k_output == pytest.approx(0.006)
    assert row.context_window == 32000
    # New rows get conservative defaults.
    assert row.quality == 0.85
    assert row.latency_p95_ms == 1000


def test_merge_openrouter_handles_free_model():
    """OpenRouter marks free models with prompt=completion="0"."""
    catalog = PricingCatalog.default()
    n = catalog._merge_openrouter_rows([
        _openrouter_row("some/free-model", "0", "0"),
    ])
    assert n == 1
    row = catalog.lookup("some/free-model")
    assert row is not None
    assert row.cost_per_1k_input == 0.0
    assert row.cost_per_1k_output == 0.0


def test_merge_openrouter_skips_malformed_entries():
    """Rows missing id or pricing are silently skipped — the
    merger should never crash on a partial payload.
    """
    catalog = PricingCatalog.default()
    n = catalog._merge_openrouter_rows([
        {},  # no id
        {"id": "x"},  # no pricing
        {"id": "y", "pricing": {"prompt": "not-a-number", "completion": "0.00001"}},
        {"id": "good", "pricing": {"prompt": "0.000001", "completion": "0.000002"}},
    ])
    assert n == 1
    assert catalog.lookup("good") is not None


def test_merge_openrouter_updates_last_refresh():
    catalog = PricingCatalog.default()
    assert catalog.last_refresh == 0.0
    catalog._merge_openrouter_rows([_openrouter_row("foo/bar", "0.000001", "0.000002")])
    assert catalog.last_refresh > 0.0


def test_merge_openrouter_no_updates_doesnt_refresh_timestamp():
    """An empty/garbage payload shouldn't reset the freshness clock."""
    catalog = PricingCatalog.default()
    catalog.last_refresh = 12345.0
    catalog._merge_openrouter_rows([])
    assert catalog.last_refresh == 12345.0


# ─────────────────────────────────────────────────────────────────────
# AIGateway integration
# ─────────────────────────────────────────────────────────────────────


def test_aigateway_uses_pricing_catalog_for_performance():
    """Catalog rows beat legacy MODEL_PERFORMANCE for routing."""
    g = AIGateway()
    # Direct catalog hit.
    perf = g._estimate_provider_performance(Provider.OPENAI, "gpt-4o")
    row = g.pricing.lookup("gpt-4o")
    assert row is not None
    assert perf[0] == row.quality
    assert perf[1] == row.latency_p95_ms
    # Blended cost should match.
    assert perf[2] == pytest.approx(row.cost_per_1k_blended)
    assert perf[3] == row.reliability


def test_aigateway_falls_back_to_legacy_performance_for_unknown_model():
    """Models not in the catalog still fall through to the legacy
    ``MODEL_PERFORMANCE`` table for back-compat with any direct
    callers that mutate it.
    """
    g = AIGateway()
    # Inject a row only into the legacy table.
    g.MODEL_PERFORMANCE["custom-model-xyz"] = (0.92, 500, 0.004, 0.999)
    perf = g._estimate_provider_performance(Provider.OPENAI, "custom-model-xyz")
    assert perf == (0.92, 500, 0.004, 0.999)


def test_aigateway_uses_catalog_for_cost_with_split_rates():
    """``_estimate_cost`` uses the catalog's input/output split
    rather than the legacy blended rate.
    """
    g = AIGateway()
    # gpt-4o: $2.50/$10.00 per 1M → 1K tokens input = $0.0025,
    # 1K tokens output = $0.010.
    cost = g._estimate_cost(Provider.OPENAI, input_tokens=1000, output_tokens=1000, model_version="gpt-4o")
    expected = 0.0025 + 0.010  # $0.0125 for 1K in + 1K out
    assert cost == pytest.approx(expected)


def test_aigateway_self_hosted_still_zero_cost():
    g = AIGateway()
    cost = g._estimate_cost(Provider.OLLAMA, input_tokens=1000, output_tokens=1000, model_version="llama3.1:8b")
    assert cost == 0.0


def test_pricing_summary_includes_sources_breakdown():
    g = AIGateway()
    summary = g.pricing_summary()
    assert summary["total_rows"] >= 30
    assert summary["sources"]["static"] >= 30
    assert summary["fresh"] is False  # never refreshed
    assert isinstance(summary["model_ids"], list)
    assert "gpt-4o" in summary["model_ids"]


@pytest.mark.asyncio
async def test_refresh_pricing_with_mock_client_merges_live_rows():
    """End-to-end refresh using a fake httpx client. Tests the
    real network-shape parsing without actually hitting OpenRouter.
    """
    catalog = PricingCatalog.default()

    fake_response = MagicMock()
    fake_response.json = MagicMock(return_value={
        "data": [
            _openrouter_row("anthropic/claude-sonnet-4.6", "0.0000035", "0.000018", ctx=200000),
            _openrouter_row("openai/gpt-5", "0.0000011", "0.0000095", ctx=128000),
        ],
    })
    fake_response.raise_for_status = MagicMock()
    fake_response.aclose = AsyncMock()

    fake_client = MagicMock()
    fake_client.get = AsyncMock(return_value=fake_response)

    n = await catalog.refresh_from_openrouter(client=fake_client)
    assert n == 2
    assert catalog.last_refresh > 0

    sonnet = catalog.lookup("anthropic/claude-sonnet-4.6")
    assert sonnet is not None
    assert sonnet.cost_per_1k_input == pytest.approx(0.0035)
    assert sonnet.cost_per_1k_output == pytest.approx(0.018)
    assert sonnet.context_window == 200000
    assert sonnet.source == "merged"


@pytest.mark.asyncio
async def test_refresh_failure_doesnt_poison_catalog():
    """A bad response should raise (not silently zero out rows)."""
    catalog = PricingCatalog.default()
    gpt4o_before = catalog.lookup("gpt-4o")

    bad_response = MagicMock()
    bad_response.json = MagicMock(return_value={"unexpected": "shape"})
    bad_response.raise_for_status = MagicMock()
    bad_response.aclose = AsyncMock()

    bad_client = MagicMock()
    bad_client.get = AsyncMock(return_value=bad_response)

    with pytest.raises(ValueError, match="unexpected OpenRouter"):
        await catalog.refresh_from_openrouter(client=bad_client)

    # Catalog unchanged.
    assert catalog.lookup("gpt-4o") == gpt4o_before
    assert catalog.last_refresh == 0.0  # no successful refresh


@pytest.mark.asyncio
async def test_concurrent_refresh_calls_share_inflight_task():
    """Two concurrent ensure_fresh calls share a single fetch."""
    catalog = PricingCatalog.default(ttl_seconds=0)

    fetch_count = 0

    async def fake_fetch(**kwargs):
        nonlocal fetch_count
        fetch_count += 1
        await asyncio.sleep(0.01)
        return 1

    catalog.refresh_from_openrouter = fake_fetch

    a = await catalog.ensure_fresh()
    b = await catalog.ensure_fresh()
    assert a is True
    assert b is True  # piggybacked on the same inflight task

    # Let the in-flight task run to completion before asserting.
    assert catalog._inflight is not None
    await catalog._inflight
    assert catalog._inflight is None  # cleaned up after completion

    # Both calls joined the same task → only one fetch ran.
    assert fetch_count == 1


@pytest.mark.asyncio
async def test_refresh_task_swallows_exceptions():
    """The background ``_refresh_task`` never propagates errors —
    a network blip must not crash the gateway.
    """
    catalog = PricingCatalog.default(ttl_seconds=0)

    async def boom(**kwargs):
        raise RuntimeError("simulated network failure")

    catalog.refresh_from_openrouter = boom
    await catalog._refresh_task(api_key=None, base_url=None)
    # No exception, inflight cleaned up.
    assert catalog._inflight is None
    assert catalog.last_refresh == 0.0


def test_seed_self_hosted_reliability_lower_than_cloud():
    """Local servers can be down — the seed reflects this with
    0.99 vs the cloud default of 0.998.
    """
    seed = default_seed_rows()
    assert seed["llama3.1:8b"].reliability < seed["gpt-4o"].reliability
