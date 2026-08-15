"""FEAT-142 — cluster trend computation (recent vs baseline volume)."""

from __future__ import annotations

import pytest

from eden.observability.patterns_clusterer import compute_cluster_trend


@pytest.mark.parametrize(
    "recent,baseline,recent_days,baseline_days,expect_trend",
    [
        # Same rate → flat (score ≈ 0)
        (7, 21, 7, 21, "flat"),
        # 2× recent rate → rising
        (14, 21, 7, 21, "rising"),
        # Half recent rate → falling
        (3, 21, 7, 21, "falling"),
        # New topic (no baseline) with recent activity → rising
        (5, 0, 7, 21, "rising"),
        # Quiet both windows → flat
        (0, 0, 7, 21, "flat"),
    ],
)
def test_compute_cluster_trend_labels(
    recent: int,
    baseline: int,
    recent_days: int,
    baseline_days: int,
    expect_trend: str,
) -> None:
    out = compute_cluster_trend(
        recent,
        baseline,
        recent_days=recent_days,
        baseline_days=baseline_days,
    )
    assert out["trend"] == expect_trend
    assert out["recent_count"] == recent
    assert out["baseline_count"] == baseline
    assert isinstance(out["trend_score"], float)


def test_compute_cluster_trend_score_formula() -> None:
    # recent_rate = 14/7 = 2, baseline_rate = 21/21 = 1 → score = 1.0
    out = compute_cluster_trend(14, 21, recent_days=7, baseline_days=21)
    assert out["trend"] == "rising"
    assert out["trend_score"] == pytest.approx(1.0)


def test_compute_cluster_trend_near_threshold_stays_flat() -> None:
    # +20% is under the ±25% threshold → flat
    # recent_rate = 8.4/7 = 1.2, baseline = 21/21 = 1 → score = 0.2
    out = compute_cluster_trend(8, 21, recent_days=7, baseline_days=21)
    # 8/7 / 1 - 1 ≈ 0.142 → flat
    assert out["trend"] == "flat"
    assert abs(out["trend_score"]) < 0.25
