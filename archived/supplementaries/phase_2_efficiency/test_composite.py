"""Unit tests for the Phase 2 composite TAS module.

These tests cover ``compute_tas`` and its internal helpers directly,
in addition to the end-to-end coverage already exercised by
``cross_phase/test_cross_phase_integration.py``. The synthetic
30-trace dataset is used to validate the per-archetype expectations.
"""
from __future__ import annotations

import pytest

from supplementaries.phase_2_efficiency.composite import (
    ARCHETYPE_TVS,
    TASResult,
    WEIGHTS,
    _compute_ccr,
    _compute_cce,
    _compute_isr,
    _compute_lhp,
    _compute_obs,
    _compute_rda,
    _compute_tca,
    _compute_vhp,
    _grade,
    _pick_intervention,
    compute_tas,
)
from tests.fixtures.traces import load_synthetic_dataset


# ── Constants ────────────────────────────────────────────────────


def test_weights_dict_has_ten_metrics():
    """WEIGHTS is the 10-metric composite per spec."""
    expected = {"SRR", "LDI", "TCA", "CCE", "RDA", "ISR", "OBS", "LHP", "VHP", "CCR"}
    assert set(WEIGHTS) == expected


def test_weights_are_positive_and_sum_to_oneish():
    """All weights positive, sum ≈ 1.0 (so raw_tas is a 0-100 number)."""
    for name, w in WEIGHTS.items():
        assert w > 0.0, f"{name} weight must be > 0"
        assert w <= 1.0, f"{name} weight must be ≤ 1.0"
    total = sum(WEIGHTS.values())
    assert 0.95 <= total <= 1.05, f"weights sum {total} not ≈ 1.0"


def test_archetype_tvs_has_ten_archetypes():
    """ARCHETYPE_TVS covers exactly the 10 spec archetypes."""
    expected = {
        "efficient-good",
        "redundant-repeated-context",
        "loop-stuck",
        "hallucinating",
        "slow-cost-overrun",
        "failing-tool",
        "optimal-path-exists",
        "efficient-multi-agent-handoff",
        "output-truncation",
        "adversarial-paraphrase-loop",
    }
    assert set(ARCHETYPE_TVS) == expected


def test_archetype_tvs_in_unit_interval():
    """Every archetype TVS is in [0, 1]."""
    for arch, tvs in ARCHETYPE_TVS.items():
        assert 0.0 <= tvs <= 1.0, f"{arch} TVS={tvs} not in [0, 1]"


# ── _grade boundaries ──────────────────────────────────────────


@pytest.mark.parametrize("tas,expected_grade", [
    (100.0, "A"),
    (90.0, "A"),
    (89.999, "B"),
    (80.0, "B"),
    (79.999, "C"),
    (70.0, "C"),
    (69.999, "D"),
    (60.0, "D"),
    (59.999, "F"),
    (0.0, "F"),
])
def test_grade_thresholds(tas, expected_grade):
    assert _grade(tas) == expected_grade


# ── _pick_intervention policy ──────────────────────────────────


def test_pick_intervention_loop_stuck_is_block():
    intervention, fixes = _pick_intervention(50.0, "loop-stuck", 0.3)
    assert intervention == "block"
    assert len(fixes) >= 1
    assert any("loop" in f.lower() for f in fixes)


def test_pick_intervention_failing_tool_is_escalate():
    intervention, fixes = _pick_intervention(40.0, "failing-tool", 0.3)
    assert intervention == "escalate"


def test_pick_intervention_slow_cost_overrun_is_summarize():
    intervention, fixes = _pick_intervention(75.0, "slow-cost-overrun", 0.85)
    assert intervention == "summarize"


def test_pick_intervention_hallucinating_is_warn():
    intervention, fixes = _pick_intervention(60.0, "hallucinating", 0.5)
    assert intervention == "warn"


def test_pick_intervention_high_tas_is_allow():
    """TAS ≥ 80 with no archetype override → allow + empty fixes."""
    intervention, fixes = _pick_intervention(85.0, None, 0.7)
    assert intervention == "allow"
    assert fixes == []


def test_pick_intervention_mid_tas_is_warn():
    intervention, fixes = _pick_intervention(70.0, None, 0.7)
    assert intervention == "warn"
    assert len(fixes) >= 1


def test_pick_intervention_low_tas_is_block():
    intervention, fixes = _pick_intervention(50.0, None, 0.7)
    assert intervention == "block"
    assert len(fixes) >= 1


# ── compute_tas on the synthetic dataset ────────────────────────


@pytest.fixture(scope="module")
def dataset():
    return load_synthetic_dataset()


def test_compute_tas_returns_tas_result(dataset):
    """Every trace produces a fully-populated TASResult."""
    ex = dataset[0]
    result = compute_tas(ex.events, archetype_id=ex.archetype_id)
    assert isinstance(result, TASResult)
    assert 0.0 <= result.tas <= 100.0
    assert 0.0 <= result.raw_tas <= 100.0
    assert result.grade in {"A", "B", "C", "D", "F"}
    assert result.intervention in {
        "allow", "warn", "skip_step", "block", "summarize", "escalate"
    }
    assert isinstance(result.fix_patches, list)
    assert isinstance(result.metrics, dict)
    assert len(result.metrics) == 10
    assert result.archetype_id == ex.archetype_id


def test_compute_tas_metrics_are_normalised(dataset):
    """Every metric value is in [0, 1]."""
    for ex in dataset:
        result = compute_tas(ex.events, archetype_id=ex.archetype_id)
        for name, value in result.metrics.items():
            assert 0.0 <= value <= 1.0, (
                f"{ex.archetype_id} {name}={value} not in [0, 1]"
            )


def test_compute_tas_efficient_good_is_high(dataset):
    """The efficient-good archetype must score ≥ 80 (ground truth)."""
    efficient = [ex for ex in dataset if ex.archetype_id == "efficient-good"]
    assert efficient, "synthetic dataset missing efficient-good archetype"
    for ex in efficient:
        result = compute_tas(ex.events, archetype_id=ex.archetype_id)
        assert result.tas >= 80.0, (
            f"efficient-good TAS {result.tas} < 80"
        )
        assert result.intervention in {"allow", "warn"}


def test_compute_tas_loop_stuck_triggers_block(dataset):
    """loop-stuck → block + non-empty fixes."""
    stuck = [ex for ex in dataset if ex.archetype_id == "loop-stuck"]
    assert stuck, "synthetic dataset missing loop-stuck archetype"
    for ex in stuck:
        result = compute_tas(ex.events, archetype_id=ex.archetype_id)
        assert result.intervention == "block"
        assert result.fix_patches


def test_compute_tas_hallucinating_triggers_warn(dataset):
    """hallucinating → warn + hallucination-related fix."""
    hallu = [ex for ex in dataset if ex.archetype_id == "hallucinating"]
    assert hallu, "synthetic dataset missing hallucinating archetype"
    for ex in hallu:
        result = compute_tas(ex.events, archetype_id=ex.archetype_id)
        assert result.intervention == "warn"
        assert result.fix_patches


def test_compute_tas_explicit_tvs_override(dataset):
    """Passing task_value_score= overrides the per-archetype default."""
    ex = dataset[0]
    by_default = compute_tas(ex.events, archetype_id=ex.archetype_id)
    overridden = compute_tas(
        ex.events,
        archetype_id=ex.archetype_id,
        task_value_score=1.0,
    )
    # Higher TVS → higher final TAS (same raw_tas).
    assert overridden.tas >= by_default.tas


def test_compute_tas_tvs_zero_yields_seventy_percent_of_raw(dataset):
    """tvs=0 → tas = raw_tas * 0.7 exactly."""
    ex = dataset[0]
    result = compute_tas(ex.events, task_value_score=0.0)
    assert result.tas == pytest.approx(result.raw_tas * 0.7, rel=1e-6)


def test_compute_tas_tvs_one_yields_full_raw(dataset):
    """tvs=1 → tas = raw_tas (clamped at 100)."""
    ex = dataset[0]
    result = compute_tas(ex.events, task_value_score=1.0)
    assert result.tas == pytest.approx(min(100.0, result.raw_tas), rel=1e-6)


def test_compute_tas_unknown_archetype_uses_neutral_tvs(dataset):
    """Unknown archetype_id → default TVS 0.7, no per-archetype override."""
    ex = dataset[0]
    result = compute_tas(ex.events, archetype_id="not-a-real-archetype")
    assert result.task_value_score == pytest.approx(0.7)


def test_compute_tas_avs_and_vae_formulas(dataset):
    """AVS = tas * 0.7; VAE = tas * tvs."""
    ex = dataset[0]
    result = compute_tas(ex.events, archetype_id=ex.archetype_id)
    assert result.avs == pytest.approx(result.tas * 0.7, rel=1e-6)
    assert result.vae == pytest.approx(result.tas * result.task_value_score, rel=1e-6)


def test_compute_tas_empty_events_is_graceful():
    """Empty event list → well-defined (low) score, not an exception."""
    result = compute_tas([])
    assert 0.0 <= result.tas <= 100.0
    assert result.grade in {"A", "B", "C", "D", "F"}


def test_compute_tas_accepts_generator():
    """compute_tas accepts any Iterable, not just list."""
    ex_events = []  # iterable, not list
    # Use the first synthetic trace lazily.
    from tests.fixtures.traces import load_synthetic_dataset as _load
    ds = _load()
    result = compute_tas(iter(ds[0].events), archetype_id=ds[0].archetype_id)
    assert isinstance(result, TASResult)


def test_compute_tas_tasresult_is_immutable(dataset):
    """TASResult is a frozen dataclass — can't be mutated post-construction."""
    ex = dataset[0]
    result = compute_tas(ex.events, archetype_id=ex.archetype_id)
    with pytest.raises(Exception):  # FrozenInstanceError
        result.tas = 99.0  # type: ignore[misc]


# ── Internal helpers on a single trace ─────────────────────────


def test_compute_tca_runs_on_real_events(dataset):
    """TCA helper returns a float in [0, 1] for a real trace."""
    ex = dataset[0]
    val = _compute_tca(list(ex.events))
    assert 0.0 <= val <= 1.0


@pytest.mark.parametrize("helper_name", [
    "_compute_cce", "_compute_rda", "_compute_isr",
    "_compute_obs", "_compute_lhp", "_compute_vhp", "_compute_ccr",
])
def test_internal_helpers_in_unit_interval(helper_name, dataset):
    """Every internal sub-metric helper is bounded to [0, 1]."""
    helper = globals()[helper_name]
    for ex in dataset:
        val = helper(list(ex.events))
        assert 0.0 <= val <= 1.0, (
            f"{helper_name} on {ex.archetype_id} returned {val}"
        )
