"""Every model the router can call must have a price.

`PricingCatalog.lookup` is an exact-match dict get with no
normalisation. A model absent from the seed falls through to
``cost_resolver``'s ``Decimal("0")`` / ``source="unknown"`` branch —
silently, with no warning and no raise.

On 2026-07-29 that branch was catching **all six** entries of
``TIER_MODELS``, i.e. 100% of internal LLM traffic. Every call booked
$0, so the spend dashboards, the per-org budgets and the evolution
cap all read zero regardless of actual spend. The fallback itself is
deliberate (a brand-new model should not crash the router); it
catching every production call was not.

This test is the tripwire: add a model to a tier without pricing it
and CI fails here rather than in a billing reconciliation months later.
"""

from __future__ import annotations

import pytest

from eden.llmops.pricing import lookup_seed_row
from eden.optimization.model_router import TIER_MODELS

# T4's placeholder is not a real hosted model — a fine-tuned deployment
# is billed per tenant, so it is seeded at 0.0 as an explicit decision
# and tenants set a per-tenant override. Listed here so the exemption is
# visible rather than implied by a passing test.
_INTENTIONALLY_ZERO = {"custom/fine-tuned"}


def _all_routed_models() -> list[str]:
    return sorted({m for models in TIER_MODELS.values() for m in models})


def test_tier_models_is_not_empty():
    """Guard the guard — an empty table would make everything below vacuous."""
    assert _all_routed_models(), "TIER_MODELS resolved to no models"


@pytest.mark.parametrize("model_id", _all_routed_models())
def test_routed_model_has_a_pricing_row(model_id: str):
    row = lookup_seed_row(model_id)
    assert row is not None, (
        f"{model_id} is routable via TIER_MODELS but has no pricing row, so "
        f"every call to it books $0 and no budget can ever trip. Add it to "
        f"default_seed_rows() in eden/llmops/pricing.py."
    )


@pytest.mark.parametrize("model_id", _all_routed_models())
def test_routed_model_costs_something(model_id: str):
    if model_id in _INTENTIONALLY_ZERO:
        pytest.skip(f"{model_id} is billed per tenant, seeded 0.0 by decision")
    row = lookup_seed_row(model_id)
    assert row is not None
    assert row.cost_per_1k_input > 0, f"{model_id} has zero input cost"
    assert row.cost_per_1k_output > 0, f"{model_id} has zero output cost"


def test_output_is_not_cheaper_than_input():
    """Sanity check on the seeded numbers. Every commercial provider
    charges at least as much for output as for input; an inverted pair
    is the signature of a units mistake (per-token vs per-1k)."""
    for model_id in _all_routed_models():
        if model_id in _INTENTIONALLY_ZERO:
            continue
        row = lookup_seed_row(model_id)
        assert row.cost_per_1k_output >= row.cost_per_1k_input, (
            f"{model_id}: output {row.cost_per_1k_output} < input "
            f"{row.cost_per_1k_input} — likely a unit conversion error"
        )


def test_seeded_rates_are_in_per_1k_units():
    """Catch the x1000 slip directly.

    OpenRouter publishes per-TOKEN prices; this table is per-1K. Pasting
    the raw value gives a cost 1000x too low, which reads as 'nearly
    free' rather than as an error. No current routed model is under
    $0.00001/1k input, and none is over $1/1k.
    """
    for model_id in _all_routed_models():
        if model_id in _INTENTIONALLY_ZERO:
            continue
        row = lookup_seed_row(model_id)
        assert 1e-5 < row.cost_per_1k_input < 1.0, (
            f"{model_id} input {row.cost_per_1k_input}/1k is outside the "
            f"plausible band — check per-token vs per-1k units"
        )
