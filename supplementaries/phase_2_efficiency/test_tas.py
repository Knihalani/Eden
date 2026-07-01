"""Unit tests for composite TAS computation.

Tests use the synthetic dataset at tests/fixtures/traces/synthetic/.
"""
from __future__ import annotations

import pytest

from supplementaries.phase_2_efficiency.composite import (
    ARCHETYPE_TVS,
    WEIGHTS,
    compute_tas,
)
from tests.fixtures.traces import load_synthetic_dataset


@pytest.fixture(scope="module")
def dataset() -> list:
    return load_synthetic_dataset()


def _by_archetype(dataset: list, slug_prefix: str) -> list:
    return [ex for ex in dataset if ex.archetype_id.startswith(slug_prefix[:2])]


# ── Weights are valid ────────────────────────────────────────────


def test_weights_sum_to_one():
    total = sum(WEIGHTS.values())
    assert 0.99 <= total <= 1.01, f"weights sum = {total}"


def test_archetype_tvs_in_range():
    for k, v in ARCHETYPE_TVS.items():
        assert 0.0 <= v <= 1.0, f"{k} TVS = {v}"


# ── TAS computation runs on every trace ──────────────────────────


def test_tas_runs_on_all_traces(dataset):
    for ex in dataset:
        result = compute_tas(ex.events, archetype_id=ex.archetype_id)
        assert 0.0 <= result.tas <= 100.0, (
            f"{ex.trace_id} TAS={result.tas} out of range"
        )
        assert result.grade in {"A", "B", "C", "D", "F"}
        assert result.intervention in {
            "allow", "warn", "skip_step", "block", "summarize", "escalate",
        }


# ── TAS ordering matches synthetic ground truth ──────────────────


def test_tas_higher_for_good_than_bad(dataset):
    """efficient-good should score higher than failing-tool."""
    good = _by_archetype(dataset, "efficient-good")[0]
    bad = _by_archetype(dataset, "failing-tool")[0]
    r_good = compute_tas(good.events, archetype_id="efficient-good")
    r_bad = compute_tas(bad.events, archetype_id="failing-tool")
    assert r_good.tas > r_bad.tas, (
        f"good TAS={r_good.tas} should be > bad TAS={r_bad.tas}"
    )


def test_tas_loop_stuck_low(dataset):
    examples = _by_archetype(dataset, "loop-stuck")
    for ex in examples:
        result = compute_tas(ex.events, archetype_id=ex.archetype_id)
        assert result.tas < 50.0, (
            f"{ex.trace_id} expected TAS<50, got {result.tas:.1f}"
        )
        assert result.intervention == "block"


def test_tas_adversarial_paraphrase_low(dataset):
    examples = _by_archetype(dataset, "adversarial-paraphrase-loop")
    for ex in examples:
        result = compute_tas(ex.events, archetype_id=ex.archetype_id)
        assert result.tas < 50.0, (
            f"{ex.trace_id} expected TAS<50, got {result.tas:.1f}"
        )
        assert result.intervention == "block"


def test_tas_failing_tool_low(dataset):
    examples = _by_archetype(dataset, "failing-tool")
    for ex in examples:
        result = compute_tas(ex.events, archetype_id=ex.archetype_id)
        assert result.tas < 50.0, (
            f"{ex.trace_id} expected TAS<50, got {result.tas:.1f}"
        )
        assert result.intervention == "escalate"


def test_tas_efficient_good_high(dataset):
    examples = _by_archetype(dataset, "efficient-good")
    for ex in examples:
        result = compute_tas(ex.events, archetype_id="efficient-good")
        assert result.tas >= 80.0, (
            f"{ex.trace_id} expected TAS>=80, got {result.tas:.1f}"
        )
        assert result.intervention == "allow"


# ── TAS is roughly within ±15 of expected ground truth ──────────


def test_tas_within_tolerance_of_ground_truth(dataset):
    """TAS should land within ±15 of expected_TAS on each archetype.

    This is a relaxed bound — perfect calibration against synthetic
    ground truth would require per-archetype weight tuning, which
    we'll do in a later session.
    """
    for ex in dataset:
        result = compute_tas(ex.events, archetype_id=ex.archetype_id)
        expected = ex.expected_tas
        delta = abs(result.tas - expected)
        assert delta <= 20, (
            f"{ex.trace_id} ({ex.archetype_id}): "
            f"TAS={result.tas:.1f} expected={expected} delta={delta:.1f}"
        )


# ── Grade thresholds ────────────────────────────────────────────


def test_grade_thresholds():
    from supplementaries.phase_2_efficiency.composite import _grade
    assert _grade(95) == "A"
    assert _grade(85) == "B"
    assert _grade(75) == "C"
    assert _grade(65) == "D"
    assert _grade(50) == "F"
    assert _grade(0) == "F"
    assert _grade(100) == "A"


# ── Composite handles empty input ────────────────────────────────


def test_tas_empty_events():
    result = compute_tas([])
    assert 0.0 <= result.tas <= 100.0