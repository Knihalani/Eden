"""Tests for CostEstimator."""

from eden.nudges.cost_estimator import CostEstimator


def test_value_score_increases_with_lift():
    est = CostEstimator()
    low = est.estimate("short", success_lift_pp=1.0)
    high = est.estimate("short", success_lift_pp=5.0)
    assert high.value_score > low.value_score


def test_passes_value_floor_default():
    est = CostEstimator()
    assert est.passes_value_floor(1.0) is True
    assert est.passes_value_floor(0.1) is False
