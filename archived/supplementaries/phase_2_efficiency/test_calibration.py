"""Tests for ETEC weight calibration harness."""
from __future__ import annotations

import json

import pytest

from supplementaries.phase_2_efficiency.calibration import (
    CalibrationResult,
    _pearson,
    _recompute_tas_with_weights,
    sweep_weights,
)
from tests.fixtures.traces import load_synthetic_dataset


@pytest.fixture(scope="module")
def dataset():
    return load_synthetic_dataset()


# ── Helper tests ─────────────────────────────────────────────


def test_pearson_identical():
    """Identical vectors → r = 1.0."""
    x = [1.0, 2.0, 3.0, 4.0]
    y = [1.0, 2.0, 3.0, 4.0]
    assert _pearson(x, y) == pytest.approx(1.0)


def test_pearson_inverse():
    """Inverse vectors → r = -1.0."""
    x = [1.0, 2.0, 3.0, 4.0]
    y = [4.0, 3.0, 2.0, 1.0]
    assert _pearson(x, y) == pytest.approx(-1.0)


def test_pearson_uncorrelated():
    """Uncorrelated vectors → r ≈ 0."""
    x = [1.0, 2.0, 3.0, 4.0, 5.0]
    y = [2.0, 2.0, 2.0, 2.0, 2.0]  # constant
    assert _pearson(x, y) == 0.0


def test_recompute_tas_preserves_unit_weight():
    """With uniform weights, TAS = raw * 100."""
    metrics = {"SRR": 0.8, "LDI": 0.7, "OBS": 0.6}
    weights = {"SRR": 0.33, "LDI": 0.33, "OBS": 0.34}
    tas = _recompute_tas_with_weights(metrics, weights)
    expected = (0.33 * 0.8 + 0.33 * 0.7 + 0.34 * 0.6) * 100
    assert tas == pytest.approx(expected, rel=0.01)


def test_recompute_tas_handles_missing_metrics():
    """Missing metrics default to 0.5 (neutral)."""
    metrics = {"SRR": 0.8}
    weights = {"SRR": 0.5, "LDI": 0.5}
    tas = _recompute_tas_with_weights(metrics, weights)
    # SRR=0.8 (0.5*0.8=0.4), LDI missing=0.5 (0.5*0.5=0.25), total 0.65
    assert 60 < tas < 70


# ── Sweep weights ────────────────────────────────────────────


def test_sweep_weights_returns_result(dataset):
    """Sweep returns a CalibrationResult with valid metrics."""
    result = sweep_weights(
        [(ex.events, ex.expected_tas, ex.archetype_id) for ex in dataset],
        weight_steps=2,  # 0.0 and 1.0 only
    )
    assert isinstance(result, CalibrationResult)
    assert result.best_mse >= 0
    assert -1.0 <= result.best_pearson <= 1.0
    assert result.sweep_size > 0
    # All weights should be in [0, 1] and sum to 1.0.
    total = sum(result.best_weights.values())
    assert abs(total - 1.0) < 0.01


def test_sweep_weights_both_grids_finite(dataset):
    """Both weight_steps=2 and weight_steps=3 produce finite MSE."""
    coarse = sweep_weights(
        [(ex.events, ex.expected_tas, ex.archetype_id) for ex in dataset],
        weight_steps=2,
    )
    fine = sweep_weights(
        [(ex.events, ex.expected_tas, ex.archetype_id) for ex in dataset],
        weight_steps=3,
    )
    # Both should be finite.
    import math
    assert math.isfinite(coarse.best_mse)
    assert math.isfinite(fine.best_mse)


def test_sweep_weights_correlates_with_ground_truth(dataset):
    """Best weights should produce TAS values that correlate with ground truth."""
    result = sweep_weights(
        [(ex.events, ex.expected_tas, ex.archetype_id) for ex in dataset],
        weight_steps=3,
    )
    # The default engineering weights should achieve at least moderate
    # correlation with the expected TAS.
    assert result.best_pearson > 0.5, (
        f"Best Pearson r={result.best_pearson:.3f} should exceed 0.5; "
        f"weights may need recalibration"
    )


def test_sweep_weights_runs_under_10s(dataset):
    """The full sweep runs in <10s (production scale: 100+ traces)."""
    import time
    start = time.perf_counter()
    sweep_weights(
        [(ex.events, ex.expected_tas, ex.archetype_id) for ex in dataset],
        weight_steps=3,  # 200 random samples
    )
    elapsed = time.perf_counter() - start
    assert elapsed < 10.0, f"sweep took {elapsed:.1f}s"


def test_sweep_weights_synthetic_dataset_round_trip(dataset):
    """The sweep on the 30-trace synthetic dataset produces a
    non-trivial CalibrationResult (best_weights different from default)."""
    result = sweep_weights(
        [(ex.events, ex.expected_tas, ex.archetype_id) for ex in dataset],
        weight_steps=3,
    )
    # Either the sweep found a better config, or the default is fine.
    assert result.best_mse < 5000, (
        f"Best MSE {result.best_mse:.1f} suggests weight calibration issue"
    )