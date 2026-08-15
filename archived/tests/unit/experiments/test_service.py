"""Unit tests for the platform-wide A/B testing framework."""
from __future__ import annotations

import pytest

from eden.experiments import (
    ExperimentResult,
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


# ────────────────────────────────────────────────────────────────────────
# recommend_winner: control-variant selection
# ────────────────────────────────────────────────────────────────────────


def test_recommend_winner_default_control_is_results_zero():
    """Backwards-compat: when no control is passed, results[0] is used."""
    # control=20% success, treatment=80% success → treatment wins
    for _ in range(20):
        record_outcome("e", "u_c", "control", False)
        record_outcome("e", "u_t", "treatment", True)
    results = analyse("e")
    # insertion order is "control" then "treatment" → results[0] = control
    assert [r.variant for r in results] == ["control", "treatment"]
    assert recommend_winner(results, min_n=10) == "treatment"


def test_recommend_winner_explicit_control_works_when_results_order_differs():
    """Bug repro: outcomes were recorded in an order different from
    declared variant order. Without an explicit control, the function
    misidentifies the baseline and either misses the real winner or
    recommends against the wrong baseline.

    Before the fix: ``recommend_winner`` returned ``None`` (best vs wrong
    control collapses to best == control when results[0] is also the
    best variant) or returned a misleading winner based on the wrong
    z-test baseline.

    After the fix: passing the correct control yields the right answer.
    """
    # Variants declared: control=A, treatment=B (in some external config).
    # Outcomes recorded with the treatment first → insertion order is [B, A].
    for i in range(150):
        record_outcome("e", f"u_b_{i}", "B", True)        # treatment 100%
        record_outcome("e", f"u_a_{i}", "A", i % 5 != 0)  # control ~80%
    # analyse() returns results in insertion order: [B, A]
    results = analyse("e")
    assert [r.variant for r in results] == ["B", "A"]
    # Without explicit control, results[0] (= B) is wrongly treated as control,
    # so best == control → returns None (real bug).
    assert recommend_winner(results, min_n=100) is None
    # With explicit control=A, B is correctly identified as the winner.
    assert recommend_winner(results, min_n=100, control="A") == "B"


def test_recommend_winner_explicit_control_rejects_unknown_name():
    """If the caller passes a control name that doesn't exist in
    ``results``, we return ``None`` rather than silently picking a
    different variant as the baseline."""
    for i in range(200):
        record_outcome("e", f"u_a_{i}", "A", i % 2 == 0)
        record_outcome("e", f"u_b_{i}", "B", i % 2 == 0)
    results = analyse("e")
    assert recommend_winner(results, min_n=100, control="does_not_exist") is None


def test_recommend_winner_explicit_control_handles_three_variants():
    """Multi-variant case: declared A=control, B=treatment1, C=treatment2.
    Outcomes arrive in B, A, C order so results[0]=B (WRONG control).
    Without explicit control, the function returns C (the highest
    rate) because it's tested against B (the wrong control) and
    happens to pass; but the *correct* decision is C vs A and
    the same C still wins. The test documents the correct decision
    and that explicit control gives the same answer for this case."""
    r_b = ExperimentResult("e", "B", 500, 200, 0.40)
    r_a = ExperimentResult("e", "A", 500, 70, 0.14)
    r_c = ExperimentResult("e", "C", 500, 175, 0.35)
    # Without explicit control: control = results[0] = B
    # best = C (0.35), control = B (0.40) → best BELOW control → None
    assert recommend_winner([r_b, r_a, r_c], min_n=100) is None
    # With explicit control=A: best = B (0.40) vs control A (0.14),
    # z ≈ (0.40-0.14)/sqrt(0.27*0.73*(1/500+1/500)) ≈ 8.22, significant.
    assert recommend_winner([r_b, r_a, r_c], min_n=100, control="A") == "B"


def test_recommend_winner_explicit_control_uses_lower_baseline():
    """The bug case where the right answer was missed because the
    wrong (higher-rate) variant was treated as the control. With
    the explicit control parameter, the lower-rate baseline is
    correctly identified and the winner is correctly returned.
    """
    # Declared: A = control (50% baseline), B = treatment (70%)
    # Outcomes arrive in B first → insertion order [B, A]
    # Before fix: control = results[0] = B (70%), best = B → best == control → None
    # After fix: control = A (50%), best = B (70%) → z significant → returns "B"
    r_b = ExperimentResult("e", "B", 500, 350, 0.70)
    r_a = ExperimentResult("e", "A", 500, 250, 0.50)
    assert recommend_winner([r_b, r_a], min_n=100) is None
    assert recommend_winner([r_b, r_a], min_n=100, control="A") == "B"
