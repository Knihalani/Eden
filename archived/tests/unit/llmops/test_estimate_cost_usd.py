"""Seed-catalog cost estimates for ingest + portal read backfill."""

from __future__ import annotations

from eden.llmops.pricing import estimate_cost_usd, resolve_seed_row


def test_estimate_prefers_existing_positive_cost() -> None:
    assert (
        estimate_cost_usd(
            model="gpt-4o",
            input_tokens=1000,
            output_tokens=500,
            existing=1.23,
        )
        == 1.23
    )


def test_estimate_returns_zero_without_tokens() -> None:
    assert estimate_cost_usd(model="gpt-4o", input_tokens=0, output_tokens=0) == 0.0


def test_estimate_fuzzy_matches_model_id() -> None:
    row = resolve_seed_row("openrouter/minimax/minimax-m3")
    assert row is not None
    cost = estimate_cost_usd(
        model="openrouter/minimax/minimax-m3",
        input_tokens=1000,
        output_tokens=1000,
    )
    assert cost > 0


def test_estimate_unknown_model_is_zero() -> None:
    assert (
        estimate_cost_usd(
            model="totally-unknown-model-xyz",
            input_tokens=1000,
            output_tokens=1000,
        )
        == 0.0
    )
