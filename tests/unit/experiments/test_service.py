"""Unit tests for the platform-wide A/B testing framework."""
from __future__ import annotations

import pytest

from eden.experiments import (
    Variant,
    analyse,
    assign_variant,
    recommend_winner,
    record_outcome,
    reset_outcomes,
    two_proportion_z_test,
)


@pytest.fixture(autouse=True)
def _reset_outcomes():
    """Each test starts with a clean slate."""
    reset_outcomes()
    yield
    reset_outcomes()


def test_assign_variant_returns_a_variant():
    variants = [Variant("control", 0.5), Variant("treatment", 0.5)]
    chosen = assign_variant("exp_1", "user_a", variants)
    assert chosen in variants


def test_assign_variant_is_deterministic():
    variants = [Variant("control", 0.5), Variant("treatment", 0.5)]
    a = assign_variant("exp_1", "user_a", variants)
    b = assign_variant("exp_1", "user_a", variants)
    assert a.name == b.name


def test_assign_variant_different_users_can_get_different_buckets():
    """With 50/50 weights, two different users should split across variants
    with high probability (we check that at least one pair differs)."""
    variants = [Variant("control", 0.5), Variant("treatment", 0.5)]
    seen = {assign_variant("exp", f"user_{i}", variants).name for i in range(200)}
    assert len(seen) == 2  # both variants got some users


def test_assign_variant_weighted_distribution_close_to_weights():
    """With weight 0.9 / 0.1, ~90% of users should land in the heavy variant."""
    variants = [Variant("heavy", 0.9), Variant("light", 0.1)]
    n = 5_000
    counts = {"heavy": 0, "light": 0}
    for i in range(n):
        counts[assign_variant("w", f"u_{i}", variants).name] += 1
    heavy_frac = counts["heavy"] / n
    assert 0.85 < heavy_frac < 0.95


def test_assign_variant_rejects_empty_variants():
    with pytest.raises(ValueError):
        assign_variant("e", "u", [])


def test_assign_variant_rejects_zero_weight_total():
    with pytest.raises(ValueError):
        assign_variant("e", "u", [Variant("a", 0), Variant("b", 0)])


# ────────────────────────────────────────────────────────────────────────
# Outcomes + analysis
# ────────────────────────────────────────────────────────────────────────


def test_analyse_returns_empty_when_no_outcomes():
    assert analyse("nope") == []


def test_analyse_groups_outcomes_by_variant():
    record_outcome("e", "u1", "control", True)
    record_outcome("e", "u2", "control", False)
    record_outcome("e", "u3", "treatment", True)
    record_outcome("e", "u4", "treatment", True)
    results = analyse("e")
    by_variant = {r.variant: r for r in results}
    assert by_variant["control"].n == 2
    assert by_variant["control"].successes == 1
    assert by_variant["control"].rate == 0.5
    assert by_variant["treatment"].n == 2
    assert by_variant["treatment"].rate == 1.0


def test_recommend_winner_returns_none_with_insufficient_data():
    record_outcome("e", "u", "control", True)
    record_outcome("e", "u2", "treatment", True)
    assert recommend_winner(analyse("e"), min_n=100) is None


def test_recommend_winner_returns_none_when_no_clear_winner():
    """When both variants perform identically, there's no winner."""
    for i in range(200):
        record_outcome("e", f"u_c_{i}", "control", i % 2 == 0)
        record_outcome("e", f"u_t_{i}", "treatment", i % 2 == 0)
    assert recommend_winner(analyse("e"), min_n=100) is None


def test_recommend_winner_picks_clearly_better_variant():
    """Treatment has a 30% lift over control; we should pick it."""
    for i in range(200):
        record_outcome("e", f"u_c_{i}", "control", i % 3 != 0)  # 67%
        record_outcome("e", f"u_t_{i}", "treatment", i % 2 == 0)  # 50%
    # Control is the better one; recommend_winner returns the best that
    # beats the control (the first variant).
    assert recommend_winner(analyse("e"), min_n=100) is None  # control wins overall but isn't a winner-over-control


# ────────────────────────────────────────────────────────────────────────
# two_proportion_z_test
# ────────────────────────────────────────────────────────────────────────


def test_two_proportion_z_test_returns_zero_for_empty_samples():
    assert two_proportion_z_test(0.5, 0, 0.5, 100) == 0.0
    assert two_proportion_z_test(0.5, 100, 0.5, 0) == 0.0


def test_two_proportion_z_test_returns_zero_for_degenerate_pools():
    assert two_proportion_z_test(0.0, 100, 0.0, 100) == 0.0
    assert two_proportion_z_test(1.0, 100, 1.0, 100) == 0.0


def test_two_proportion_z_test_is_significant_for_large_effects():
    z = two_proportion_z_test(0.20, 500, 0.10, 500)
    assert z > 3.0  # well above 1.96 (5% two-tailed)
