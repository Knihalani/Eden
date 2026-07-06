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


# ─────────────────────────────────────────────────────────────────────
# models.dev overlay
# ─────────────────────────────────────────────────────────────────────


def _models_dev_provider(provider_key: str, *models: dict[str, Any]) -> dict[str, Any]:
    """Helper that produces one provider block in models.dev's
    ``/api.json`` shape.
    """
    return {
        provider_key: {
            "name": provider_key.title(),
            "models": {m["id"]: m for m in models},
        },
    }


def _models_dev_model(
    model_id: str,
    cost_in: float | None,
    cost_out: float | None,
    *,
    context: int | None = None,
    last_updated: str = "2026-04-15",
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": model_id,
        "last_updated": last_updated,
    }
    if cost_in is None and cost_out is None:
        # No cost field -> not priced.
        return entry
    entry["cost"] = {"input": cost_in, "output": cost_out}
    if context is not None:
        entry["limit"] = {"context": context}
    return entry


def test_models_dev_refresh_overwrites_static_seed_with_live_data():
    """When models.dev reports a model already in the seed, the
    cost columns get the live data; quality/latency/reliability
    estimates from the seed are preserved. The Anthropic Opus 4.5
    case is the canonical example: my seed had $15/$75 (wrong,
    pre-mid-2026 number); models.dev correctly has $5/$25.
    """
    catalog = PricingCatalog.default()
    seed_opus = catalog.lookup("claude-opus-4-5")
    assert seed_opus is not None
    assert seed_opus.source == "static"

    payload = _models_dev_provider(
        "anthropic",
        _models_dev_model("claude-opus-4-5", cost_in=5.0, cost_out=25.0, context=200000),
    )
    n = catalog._merge_models_dev_rows(payload)
    assert n == 1
    row = catalog.lookup("claude-opus-4-5")
    assert row is not None
    # $5 / 1M tokens = $0.005 per 1K.
    assert row.cost_per_1k_input == pytest.approx(0.005)
    assert row.cost_per_1k_output == pytest.approx(0.025)
    # Source becomes "merged" since this row was already in the seed.
    assert row.source == "merged"
    # Quality/latency preserved from the seed.
    assert row.quality == seed_opus.quality
    assert row.latency_p95_ms == seed_opus.latency_p95_ms


def test_models_dev_refresh_adds_new_rows_with_conservative_defaults():
    catalog = PricingCatalog.default()
    payload = _models_dev_provider(
        "openai",
        _models_dev_model("gpt-7-future", cost_in=3.0, cost_out=12.0, context=400000),
    )
    n = catalog._merge_models_dev_rows(payload)
    assert n == 1
    row = catalog.lookup("gpt-7-future")
    assert row is not None
    assert row.source == "models_dev"
    assert row.cost_per_1k_input == pytest.approx(0.003)
    assert row.cost_per_1k_output == pytest.approx(0.012)
    assert row.context_window == 400000
    # Conservative defaults for new rows.
    assert row.quality == 0.85
    assert row.latency_p95_ms == 1000


def test_models_dev_refresh_handles_free_models():
    """Free models carry 0 for both rates - keep them, don't skip."""
    catalog = PricingCatalog.default()
    payload = _models_dev_provider(
        "meta",
        _models_dev_model("llama-5-ultra-free", cost_in=0, cost_out=0),
    )
    n = catalog._merge_models_dev_rows(payload)
    assert n == 1
    row = catalog.lookup("llama-5-ultra-free")
    assert row is not None
    assert row.cost_per_1k_input == 0.0
    assert row.cost_per_1k_output == 0.0


def test_models_dev_refresh_skips_unpriced_models():
    """Models without a cost block (input and output both missing)
    are silently skipped.
    """
    catalog = PricingCatalog.default()
    payload = {
        "openai": {
            "name": "OpenAI",
            "models": {
                "mystery-model": {"id": "mystery-model"},  # no cost field
                "priced-model": {"id": "priced-model", "cost": {"input": 1.0, "output": 2.0}},
            },
        },
    }
    n = catalog._merge_models_dev_rows(payload)
    assert n == 1
    assert catalog.lookup("mystery-model") is None
    assert catalog.lookup("priced-model") is not None


def test_models_dev_refresh_skips_malformed_cost_values():
    """Non-numeric cost values are skipped without crashing the
    whole refresh.
    """
    catalog = PricingCatalog.default()
    payload = {
        "openai": {
            "models": {
                "bad-model": {"id": "bad-model", "cost": {"input": "not-a-number", "output": 1.0}},
                "good-model": {"id": "good-model", "cost": {"input": 1.0, "output": 2.0}},
            },
        },
    }
    n = catalog._merge_models_dev_rows(payload)
    assert n == 1
    assert catalog.lookup("bad-model") is None
    assert catalog.lookup("good-model") is not None


def test_models_dev_refresh_handles_multi_provider_payload():
    """The real /api.json has 100+ providers - exercise the
    outer loop walking every top-level entry.
    """
    catalog = PricingCatalog.default()
    payload = {
        "openai": {"models": {"x-model": {"id": "x-model", "cost": {"input": 1.0, "output": 2.0}}}},
        "anthropic": {"models": {"y-model": {"id": "y-model", "cost": {"input": 3.0, "output": 15.0}}}},
        "google": {"models": {"z-model": {"id": "z-model", "cost": {"input": 1.25, "output": 10.0}}}},
        # Non-provider entries (like the routing aggregators) should be skipped.
        "requesty": {"name": "Requesty", "models": {}},
    }
    n = catalog._merge_models_dev_rows(payload)
    assert n == 3
    assert catalog.lookup("x-model") is not None
    assert catalog.lookup("y-model") is not None
    assert catalog.lookup("z-model") is not None


def test_models_dev_refresh_skips_non_dict_entries():
    """Top-level entries that aren't dicts (the real payload has
    a few) are silently skipped.
    """
    catalog = PricingCatalog.default()
    payload = {
        "openai": "this should be a dict not a string",
        "anthropic": {"models": {"ok-model": {"id": "ok-model", "cost": {"input": 1.0, "output": 2.0}}}},
    }
    n = catalog._merge_models_dev_rows(payload)
    assert n == 1


def test_models_dev_refresh_updates_last_refresh_timestamp():
    catalog = PricingCatalog.default()
    assert catalog.last_refresh == 0.0
    payload = _models_dev_provider(
        "openai",
        _models_dev_model("any-model", cost_in=1.0, cost_out=2.0),
    )
    catalog._merge_models_dev_rows(payload)
    assert catalog.last_refresh > 0.0


def test_models_dev_refresh_no_updates_doesnt_refresh_timestamp():
    catalog = PricingCatalog.default()
    catalog.last_refresh = 12345.0
    catalog._merge_models_dev_rows({})
    assert catalog.last_refresh == 12345.0


@pytest.mark.asyncio
async def test_models_dev_refresh_with_mock_client():
    """End-to-end refresh with a fake httpx client - verifies
    the URL parsing, header setup, and JSON extraction without
    hitting the network.
    """
    catalog = PricingCatalog.default()

    payload = _models_dev_provider(
        "anthropic",
        _models_dev_model("claude-opus-4-5", cost_in=5.0, cost_out=25.0, context=200000),
    )
    fake_response = MagicMock()
    fake_response.json = MagicMock(return_value=payload)
    fake_response.raise_for_status = MagicMock()
    fake_response.aclose = AsyncMock()

    fake_client = MagicMock()
    fake_client.get = AsyncMock(return_value=fake_response)

    n = await catalog.refresh_from_models_dev(client=fake_client)
    assert n == 1
    assert catalog.last_refresh > 0
    opus = catalog.lookup("claude-opus-4-5")
    assert opus is not None
    assert opus.cost_per_1k_input == pytest.approx(0.005)


@pytest.mark.asyncio
async def test_models_dev_refresh_bad_payload_raises():
    """A non-dict payload should raise ValueError, not silently
    succeed.
    """
    catalog = PricingCatalog.default()

    fake_response = MagicMock()
    fake_response.json = MagicMock(return_value=["not", "a", "dict"])
    fake_response.raise_for_status = MagicMock()
    fake_response.aclose = AsyncMock()

    fake_client = MagicMock()
    fake_client.get = AsyncMock(return_value=fake_response)

    with pytest.raises(ValueError, match="unexpected models.dev"):
        await catalog.refresh_from_models_dev(client=fake_client)


def test_models_dev_overlay_coverage_exceeds_static_seed():
    """models.dev publishes ~5000 priced models; the static seed
    only covers ~40. After a refresh, the catalog should grow
    by orders of magnitude.
    """
    catalog = PricingCatalog.default()
    pre_count = len(catalog)
    payload = _models_dev_provider(
        "openai",
        _models_dev_model("m1", cost_in=1.0, cost_out=2.0),
        _models_dev_model("m2", cost_in=1.0, cost_out=2.0),
        _models_dev_model("m3", cost_in=1.0, cost_out=2.0),
    )
    catalog._merge_models_dev_rows(payload)
    assert len(catalog) == pre_count + 3
