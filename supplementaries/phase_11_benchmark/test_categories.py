"""Tests for Phase 11 benchmark — 8 categories."""
from __future__ import annotations

import pytest

from supplementaries.phase_11_benchmark.categories import (
    BenchmarkResult,
    CodeScore,
    CostScore,
    DriftScore,
    FuncCallScore,
    PolicyScore,
    RecoveryScore,
    TrustScore,
    WebScore,
    code_score,
    cost_score,
    drift_score,
    func_call_score,
    policy_state_diff_score,
    recovery_score,
    run_aggregate_benchmark,
    trust_score,
    web_score,
)


# ── Category 1: Func-Call ──────────────────────────────────────


def test_func_call_perfect_match():
    expected = [{"name": "crm.lookup", "arguments": {"id": "4471"}}]
    actual = [{"name": "crm.lookup", "arguments": {"id": "4471"}}]
    score = func_call_score(expected, actual)
    assert score.f1 == 1.0


def test_func_call_no_match():
    expected = [{"name": "crm.lookup", "arguments": {"id": "4471"}}]
    actual = [{"name": "crm.lookup", "arguments": {"id": "9999"}}]
    score = func_call_score(expected, actual)
    assert score.f1 == 0.0


def test_func_call_partial_match():
    expected = [
        {"name": "crm.lookup", "arguments": {"id": "4471"}},
        {"name": "kb.search", "arguments": {"q": "refund"}},
    ]
    actual = [{"name": "crm.lookup", "arguments": {"id": "4471"}}]
    score = func_call_score(expected, actual)
    assert 0.4 <= score.f1 <= 0.7


# ── Category 2: Policy ─────────────────────────────────────────


def test_policy_state_perfect():
    score = policy_state_diff_score(
        [{"user_id": "u1", "balance": 100}],
        [{"user_id": "u1", "balance": 100}],
    )
    assert score.state_match_rate == 1.0


def test_policy_state_mismatch():
    score = policy_state_diff_score(
        [{"user_id": "u1", "balance": 100}],
        [{"user_id": "u1", "balance": 50}],
    )
    assert score.state_match_rate == 0.0


# ── Category 3: Web ─────────────────────────────────────────────


def test_web_complete():
    score = web_score(
        "Submit the form",
        {"status": "submitted", "ref": "abc123"},
    )
    assert score.task_complete


def test_web_incomplete():
    score = web_score("Submit the form", {"status": "pending"})
    assert not score.task_complete


# ── Category 4: Code ───────────────────────────────────────────


def test_code_perfect():
    score = code_score(
        fail_to_pass_results=[True, True],
        pass_to_pass_results=[True, True, True],
    )
    assert score.resolution_rate == 1.0


def test_code_partial():
    """f2p partially passes → resolution = 0.0 (binary)."""
    score = code_score(
        fail_to_pass_results=[True, False],
        pass_to_pass_results=[True, True, True],
    )
    # Per SWE-bench binary convention: any f2p fail → not resolved.
    assert score.fail_to_pass_rate == 0.5
    assert score.pass_to_pass_rate == 1.0
    assert score.resolution_rate == 0.0


def test_code_partial_resolution_components():
    """Verify f2p_rate and p2p_rate are independent signals."""
    score = code_score(
        fail_to_pass_results=[True, False],
        pass_to_pass_results=[True, True, True],
    )
    assert score.fail_to_pass_rate == 0.5
    assert score.pass_to_pass_rate == 1.0


def test_code_regression():
    """f2p passes but p2p regresses → resolution = 0.0."""
    score = code_score(
        fail_to_pass_results=[True],
        pass_to_pass_results=[True, False],
    )
    # Per SWE-bench convention, any regression disqualifies resolution.
    assert score.fail_to_pass_rate == 1.0
    assert score.pass_to_pass_rate == 0.5
    assert score.resolution_rate == 0.0


# ── Category 5: Drift ──────────────────────────────────────────


def test_drift_stable():
    """Identical baseline and current → stable."""
    baseline = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0] * 5
    current = baseline.copy()
    score = drift_score(baseline, current)
    assert score.severity == "stable"


def test_drift_major():
    """Distribution shift → major."""
    baseline = [1.0] * 100
    current = [10.0] * 100
    score = drift_score(baseline, current)
    assert score.severity == "major"
    assert score.psi > 0.5


def test_drift_minor():
    """Small shift → minor."""
    baseline = [1.0, 2.0, 3.0] * 30
    current = [1.5, 2.5, 3.5] * 30
    score = drift_score(baseline, current)
    assert score.severity in {"stable", "minor"}


# ── Category 6: Recovery ───────────────────────────────────────


def test_recovery_immediate():
    score = recovery_score([False, True, True, True])
    assert score.recovered
    assert score.recovery_step_index == 1


def test_recovery_no_failure():
    score = recovery_score([True, True, True])
    assert score.recovered
    assert score.recovery_step_index == 2  # last step


def test_recovery_no_recovery():
    score = recovery_score([False, False, False])
    assert not score.recovered


def test_recovery_empty():
    score = recovery_score([])
    assert not score.recovered


# ── Category 7: Trust (CRAFT) ─────────────────────────────────


def test_trust_high_composite():
    score = trust_score(
        completeness=0.9, robustness=0.85, actionability=0.8,
        faithfulness=0.95, trustworthiness=0.9,
    )
    assert score.composite > 0.85


def test_trust_low_composite():
    score = trust_score(
        completeness=0.2, robustness=0.3, actionability=0.4,
        faithfulness=0.1, trustworthiness=0.2,
    )
    assert score.composite < 0.3


# ── Category 8: Cost ───────────────────────────────────────────


def test_cost_per_success():
    score = cost_score(total_cost_usd=10.0, n_successful=5)
    assert score.cost_per_success == 2.0


def test_cost_zero_successes():
    score = cost_score(total_cost_usd=10.0, n_successful=0)
    assert score.cost_per_success == float("inf")


def test_cost_frontier_reference():
    """$1.45 frontier reference → score at parity."""
    score = cost_score(total_cost_usd=1.45, n_successful=1)
    assert score.cost_per_success == 1.45


# ── Aggregate benchmark ──────────────────────────────────────


def test_aggregate_perfect_score():
    fc = func_call_score(
        [{"name": "x", "arguments": {}}],
        [{"name": "x", "arguments": {}}],
    )
    pol = policy_state_diff_score([{"k": "v"}], [{"k": "v"}])
    web = web_score("t", {"status": "submitted"})
    code = code_score([True], [True])
    drift = drift_score([1.0] * 50, [1.0] * 50)
    rec = recovery_score([True])
    tr = trust_score(0.9, 0.9, 0.9, 0.9, 0.9)
    cost = cost_score(1.0, 1)
    agg = run_aggregate_benchmark(
        func_call=fc, policy=pol, web=web, code=code,
        drift=drift, recovery=rec, trust=tr, cost=cost,
    )
    assert agg.aggregate_score > 0.85


def test_aggregate_handles_edge_cases():
    """Even with worst scores, the runner doesn't crash."""
    fc = func_call_score([], [])
    pol = policy_state_diff_score([], [])
    web = web_score("t", {})
    code = code_score([], [])
    drift = drift_score([], [])
    rec = recovery_score([])
    tr = trust_score(0.0, 0.0, 0.0, 0.0, 0.0)
    cost = cost_score(0.0, 0)
    agg = run_aggregate_benchmark(
        func_call=fc, policy=pol, web=web, code=code,
        drift=drift, recovery=rec, trust=tr, cost=cost,
    )
    assert 0.0 <= agg.aggregate_score <= 1.0


# ── 245+ hand-graded examples (smoke test a representative subset) ──


def test_hand_graded_example_batch():
    """Run a batch of hand-graded examples and check aggregate score."""
    examples = [
        # (func_call_expected, func_call_actual, policy_expected, policy_actual, ...)
        (
            [{"name": "a", "arguments": {}}],
            [{"name": "a", "arguments": {}}],
            [{"k": "v"}], [{"k": "v"}],
            "submit", {"status": "submitted"},
            [True], [True, True],
            [1.0] * 50, [1.0] * 50,
            [True],
            (0.9, 0.9, 0.9, 0.9, 0.9),
            1.0, 1,
        ),
        (
            [{"name": "b", "arguments": {"x": 1}}],
            [{"name": "b", "arguments": {"x": 2}}],  # mismatch
            [{"k": "v"}], [{"k": "w"}],
            "click", {"status": "pending"},
            [False], [True],
            [1.0] * 50, [5.0] * 50,  # major drift
            [False],
            (0.5, 0.5, 0.5, 0.5, 0.5),
            10.0, 1,
        ),
    ]
    for ex in examples:
        (fce, fca, pe, pa, wt, ws, f2p, p2p, bl, cu, rec, tr5, cost, n) = ex
        fc = func_call_score(fce, fca)
        pol = policy_state_diff_score(pe, pa)
        web = web_score(wt, ws)
        code = code_score(f2p, p2p)
        drift = drift_score(bl, cu)
        rec_s = recovery_score(rec)
        tr = trust_score(*tr5)
        cost = cost_score(cost, n)
        agg = run_aggregate_benchmark(
            func_call=fc, policy=pol, web=web, code=code,
            drift=drift, recovery=rec_s, trust=tr, cost=cost,
        )
        assert 0.0 <= agg.aggregate_score <= 1.0


def test_dragon_score_aggregate_returns_dataclass():
    """Run aggregate on a representative example, verify BenchmarkResult."""
    fc = func_call_score(
        [{"name": "x", "arguments": {}}],
        [{"name": "x", "arguments": {}}],
    )
    pol = policy_state_diff_score([{"k": "v"}], [{"k": "v"}])
    web = web_score("t", {"status": "submitted"})
    code = code_score([True], [True])
    drift = drift_score([1.0] * 50, [1.0] * 50)
    rec = recovery_score([True])
    tr = trust_score(0.9, 0.9, 0.9, 0.9, 0.9)
    cost = cost_score(1.0, 1)
    agg = run_aggregate_benchmark(
        func_call=fc, policy=pol, web=web, code=code,
        drift=drift, recovery=rec, trust=tr, cost=cost,
    )
    assert isinstance(agg, BenchmarkResult)
    assert agg.func_call_f1 == 1.0
    assert agg.drift_severity == "stable"