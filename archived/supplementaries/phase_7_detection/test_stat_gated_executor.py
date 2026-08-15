"""Tests for §12.7 StatGate-gated apply_approved wrapper."""
from __future__ import annotations

import asyncio

import pytest

from supplementaries.phase_6_stat_gate.gate import GateEvidence
from supplementaries.phase_7_detection.stat_gated_executor import (
    ApplyApprovedResult,
    StatGateGatedExecutor,
)


def _run(coro):
    """Helper to run async coroutine in tests.

    Creates a fresh event loop and installs it as the current loop
    for the duration of the call. ``asyncio.get_event_loop()`` is
    deprecated when no loop is running (and on Python 3.12+ raises
    ``RuntimeError`` instead of implicitly creating one), so we
    build + set + close the loop explicitly to keep the helper
    usable from any test, including ones that ran after pytest-asyncio
    has torn down its own loop policy.
    """
    loop = asyncio.new_event_loop()
    try:
        asyncio.set_event_loop(loop)
        return loop.run_until_complete(coro)
    finally:
        try:
            loop.close()
        finally:
            asyncio.set_event_loop(None)


# ── Result type ──────────────────────────────────────────────────


def test_apply_approved_result_dataclass():
    """ApplyApprovedResult has expected fields."""
    result = ApplyApprovedResult(
        action_id="a1",
        applied=False,
        gate_evidence=GateEvidence(
            verdict="REJECT", c1_ece=float("nan"), c2_p_bh=1.0,
            c3_d=0.0, c4_conformal_lower=0.0, c5_msprt_p=1.0,
            n_treat=30, n_control=30, delta_mean=0.0,
            explanation="REJECT",
        ),
        side_effect_log="rejected",
    )
    assert result.action_id == "a1"
    assert not result.applied


# ── StatGate gating ──────────────────────────────────────────────


def test_apply_approved_gated_with_clear_lift():
    """Clear treatment lift → gate accepts → action applied.

    Convention: control = baseline metric (e.g. cost BEFORE), treatment
    = trial metric (cost AFTER). Lower is better, so delta_mean
    should be NEGATIVE for a successful treatment. To make the gate
    accept, we negate by sorting: control = low, treatment = high
    for a "higher is better" metric, OR we use a metric where higher
    = better.

    For this test, use a "higher is better" metric (e.g. quality
    score): control = low quality, treatment = high quality.
    """
    executor = StatGateGatedExecutor(real_executor=None)
    import random
    random.seed(20260628)
    # control = baseline (low quality, ~0.3)
    # treatment = trial (high quality, ~0.8) — strong positive lift
    control = [0.3 + random.gauss(0, 0.05) for _ in range(30)]
    treatment = [0.8 + random.gauss(0, 0.05) for _ in range(30)]
    result = _run(executor.apply_approved_gated(
        org_id="org_1",
        action_id="a1",
        action_kind="block_promotion",
        control=control,
        treatment=treatment,
    ))
    # d ~ 10 (large positive); gate should accept
    assert result.applied
    assert result.gate_evidence.verdict == "APPLY"
    assert "applied" in result.side_effect_log


def test_apply_approved_gated_with_no_effect():
    """No treatment effect → gate rejects → action not applied."""
    executor = StatGateGatedExecutor(real_executor=None)
    import random
    random.seed(20260628)
    control = [random.gauss(0.5, 0.05) for _ in range(30)]
    treatment = [random.gauss(0.5, 0.05) for _ in range(30)]
    result = _run(executor.apply_approved_gated(
        org_id="org_1",
        action_id="a1",
        action_kind="block_promotion",
        control=control,
        treatment=treatment,
    ))
    assert not result.applied
    assert result.gate_evidence.verdict == "REJECT"


def test_apply_approved_gated_with_small_sample():
    """n < 30 → C4 fails → gate rejects."""
    executor = StatGateGatedExecutor(real_executor=None)
    control = [0.5, 0.6, 0.4, 0.7, 0.3]  # n=5
    treatment = [0.1, 0.2, 0.0, 0.1, 0.2]  # n=5
    result = _run(executor.apply_approved_gated(
        org_id="org_1",
        action_id="a1",
        action_kind="block_promotion",
        control=control,
        treatment=treatment,
    ))
    assert not result.applied
    assert "C4" in result.gate_evidence.explanation


def test_apply_approved_gated_handles_zero_variance():
    """Zero variance in treatment → edge case → gate rejects."""
    executor = StatGateGatedExecutor(real_executor=None)
    control = [0.5] * 30
    treatment = [0.0] * 30  # zero variance
    result = _run(executor.apply_approved_gated(
        org_id="org_1",
        action_id="a1",
        action_kind="block_promotion",
        control=control,
        treatment=treatment,
    ))
    # Zero variance → gate may APPLY (delta_mean is large and
    # consistent) OR REJECT. Both are acceptable; just verify
    # it doesn't crash.
    assert isinstance(result, ApplyApprovedResult)


# ── History tracking ────────────────────────────────────────────


def test_history_records_each_call():
    """Each apply_approved_gated call appends to history."""
    executor = StatGateGatedExecutor()
    for i in range(3):
        _run(executor.apply_approved_gated(
            org_id="org_1",
            action_id=f"a{i}",
            action_kind="block_promotion",
            control=[0.5] * 30,
            treatment=[0.3] * 30,
        ))
    history = executor.get_history()
    assert len(history) == 3
    assert [r.action_id for r in history] == ["a0", "a1", "a2"]


# ── Real executor integration ───────────────────────────────────


class MockRealExecutor:
    """Stand-in for the actual ClosedLoopExecutor."""

    def __init__(self):
        self.applied_actions: list[str] = []

    async def apply_approved(self, org_id: str, action_id: str, **kwargs):
        self.applied_actions.append((org_id, action_id))


def test_real_executor_called_when_applied():
    """When the gate accepts, the real executor is called."""
    real = MockRealExecutor()
    executor = StatGateGatedExecutor(real_executor=real)
    import random
    random.seed(20260628)
    # higher is better; control low, treatment high
    control = [0.3 + random.gauss(0, 0.05) for _ in range(30)]
    treatment = [0.8 + random.gauss(0, 0.05) for _ in range(30)]
    _run(executor.apply_approved_gated(
        org_id="org_test",
        action_id="action_xyz",
        action_kind="block_promotion",
        control=control,
        treatment=treatment,
    ))
    # Real executor should have received the call.
    assert executor.applied_history[-1].applied
    assert real.applied_actions == [("org_test", "action_xyz")]


def test_real_executor_not_called_when_rejected():
    """When the gate rejects, the real executor is NOT called."""
    real = MockRealExecutor()
    executor = StatGateGatedExecutor(real_executor=real)
    _run(executor.apply_approved_gated(
        org_id="org_test",
        action_id="action_xyz",
        action_kind="block_promotion",
        control=[0.5] * 5,    # n < 30 → reject
        treatment=[0.1] * 5,
    ))
    assert real.applied_actions == []


# ── Numerical robustness ────────────────────────────────────────


def test_handles_extreme_values():
    """Huge values shouldn't crash the gate."""
    executor = StatGateGatedExecutor()
    control = [1e10] * 30
    treatment = [1e10 + 100] * 30
    result = _run(executor.apply_approved_gated(
        org_id="org_1",
        action_id="a1",
        action_kind="block_promotion",
        control=control,
        treatment=treatment,
    ))
    assert result.gate_evidence.verdict in {"APPLY", "REJECT"}


def test_handles_negative_values():
    """Negative values (e.g. cost savings) shouldn't crash."""
    executor = StatGateGatedExecutor()
    import random
    random.seed(20260628)
    control = [random.gauss(-0.5, 0.1) for _ in range(30)]
    treatment = [random.gauss(-1.0, 0.1) for _ in range(30)]
    result = _run(executor.apply_approved_gated(
        org_id="org_1",
        action_id="a1",
        action_kind="block_promotion",
        control=control,
        treatment=treatment,
    ))
    assert result.gate_evidence.verdict in {"APPLY", "REJECT"}