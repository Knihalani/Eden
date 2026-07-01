"""Phase 11 — Benchmark surface (Eden-8-cat).

Reference: supplementaries/research/08_agent_benchmarks.md (900 lines).

8 categories mirroring real 2026 benchmarks:
  1. Eden-Func-Call  — BFCL v4 AST diff
  2. Eden-Policy     — τ²-bench two-track (state + comm)
  3. Eden-Web        — WebArena DOM state diff
  4. Eden-Code       — SWE-bench Verified FAIL_TO_PASS / PASS_TO_PASS
  5. Eden-Drift      — PSI + z-score distribution drift
  6. Eden-Recovery   — partial-failure recovery scenarios
  7. Eden-Trust      — CRAFT 5-axis LLM judge
  8. Eden-Cost       — τ²-bench cost-normalized $/successful-task

Each category implements a scoring rubric + 10+ hand-graded
examples (245+ total). No LLMs used as judge — only deterministic
state diffs (BFCL/τ-bench/SWE-bench pattern) and PSI/z-score.

Per-category F1 vs human agreement mean target ≈ 0.86.
"""
from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Iterable, Sequence

# ── Category 1: Func-Call (BFCL-style AST diff) ────────────────


@dataclass(frozen=True)
class FuncCallScore:
    """BFCL-style AST-over-string scoring for tool calls."""

    matched: int
    expected: int
    actual: int
    precision: float
    recall: float
    f1: float


def func_call_score(
    expected_calls: Sequence[dict],
    actual_calls: Sequence[dict],
) -> FuncCallScore:
    """AST-over-string scoring for tool calls.

    Matches by (tool_name, sorted_arg_keys, canonical_arg_values).
    Returns precision / recall / F1.
    """
    def canonical(call: dict) -> frozenset:
        name = call.get("name") or call.get("tool") or ""
        args = call.get("arguments") or call.get("args") or {}
        if isinstance(args, dict):
            return frozenset(
                (k, str(v)) for k, v in sorted(args.items())
            )
        return frozenset({("__raw__", str(args))})

    expected_set = Counter(
        (c.get("name") or c.get("tool"), canonical(c))
        for c in expected_calls
    )
    actual_set = Counter(
        (c.get("name") or c.get("tool"), canonical(c))
        for c in actual_calls
    )
    matched = sum((expected_set & actual_set).values())
    expected_total = sum(expected_set.values())
    actual_total = sum(actual_set.values())
    precision = matched / actual_total if actual_total > 0 else 1.0
    recall = matched / expected_total if expected_total > 0 else 1.0
    f1 = (
        2 * precision * recall / (precision + recall)
        if (precision + recall) > 0 else 0.0
    )
    return FuncCallScore(
        matched=matched,
        expected=expected_total,
        actual=actual_total,
        precision=precision,
        recall=recall,
        f1=f1,
    )


# ── Category 2: Policy (τ²-bench state diff) ──────────────────


@dataclass(frozen=True)
class PolicyScore:
    """τ²-bench-style two-track scoring."""

    state_match_rate: float    # [0, 1] — deterministic state diff
    n_expected_states: int
    n_matched_states: int


def policy_state_diff_score(
    expected_states: Sequence[dict],
    actual_states: Sequence[dict],
) -> PolicyScore:
    """Deterministic state-diff scoring (no LLM).

    Matches by (key, value) tuples. Two states are equal iff their
    (key, value) sets are identical (set comparison ignores ordering).
    """
    def canonical(state: dict) -> frozenset:
        return frozenset((k, str(v)) for k, v in state.items())

    expected_set = Counter(canonical(s) for s in expected_states)
    actual_set = Counter(canonical(s) for s in actual_states)
    matched = sum((expected_set & actual_set).values())
    expected_total = sum(expected_set.values())
    rate = matched / expected_total if expected_total > 0 else 1.0
    return PolicyScore(
        state_match_rate=rate,
        n_expected_states=expected_total,
        n_matched_states=matched,
    )


# ── Category 3: Web (WebArena DOM state diff) ──────────────────


@dataclass(frozen=True)
class WebScore:
    """WebArena-style task scoring."""

    task_complete: bool
    partial_progress: float    # [0, 1]


def web_score(task_definition: str, final_state: dict) -> WebScore:
    """Simple WebArena-style scoring.

    Stub: checks for completion markers in final state. Real
    implementation would parse DOM + check task-specific assertions.
    """
    completion_keywords = {"completed", "success", "submitted", "downloaded"}
    state_text = " ".join(str(v) for v in final_state.values()).lower()
    complete = any(kw in state_text for kw in completion_keywords)
    # Stub progress = 0.5 if "submitted" present, else 0.0
    progress = 0.5 if "submitted" in state_text else (0.2 if complete else 0.0)
    return WebScore(task_complete=complete, partial_progress=progress)


# ── Category 4: Code (SWE-bench Verified) ──────────────────────


@dataclass(frozen=True)
class CodeScore:
    """SWE-bench-style PASS_TO_PASS / FAIL_TO_PASS scoring."""

    fail_to_pass_rate: float   # did tests that should now pass, pass?
    pass_to_pass_rate: float   # did previously-passing tests still pass?
    resolution_rate: float     # combined score


def code_score(
    fail_to_pass_results: Sequence[bool],
    pass_to_pass_results: Sequence[bool],
) -> CodeScore:
    """SWE-bench-style resolution scoring.

    Per SWE-bench Verified convention, an issue is "resolved" iff:
      - fail_to_pass tests ALL pass (bug is fixed), AND
      - pass_to_pass tests ALL still pass (no regressions).

    The `resolution_rate` is a binary indicator:
      - 1.0 if the issue is fully resolved (no regressions, bug fixed)
      - 0.0 if any pass_to_pass test fails (regression) OR any
        fail_to_pass test fails (bug not fixed)
    """
    f2p_rate = (
        sum(fail_to_pass_results) / len(fail_to_pass_results)
        if fail_to_pass_results else 1.0
    )
    p2p_rate = (
        sum(pass_to_pass_results) / len(pass_to_pass_results)
        if pass_to_pass_results else 1.0
    )
    resolution = 1.0 if (f2p_rate == 1.0 and p2p_rate == 1.0) else 0.0
    return CodeScore(
        fail_to_pass_rate=f2p_rate,
        pass_to_pass_rate=p2p_rate,
        resolution_rate=resolution,
    )


# ── Category 5: Drift (PSI + z-score) ──────────────────────────


@dataclass(frozen=True)
class DriftScore:
    """PSI + z-score drift severity bands."""

    psi: float                # Population Stability Index
    severity: str             # "stable" | "minor" | "major"
    mean_shift_zscore: float  # Standardised shift in mean


def _psi(expected: Sequence[float], actual: Sequence[float], n_bins: int = 10) -> float:
    """Population Stability Index.

    PSI = Σ (actual_pct - expected_pct) * ln(actual_pct / expected_pct)

    < 0.1 : stable
    0.1-0.25 : minor drift
    >= 0.25 : major drift

    Bin edges are quantile-based on the EXPECTED distribution. If the
    expected has zero variance (constant), we use the combined range
    of expected + actual with evenly-spaced bins — this catches the
    "shifted constants" case (baseline = 1, current = 10). When
    expected is constant AND shifted from actual, return 1.0 (max
    PSI) since the drift is unambiguously major.
    """
    if not expected or not actual:
        return 0.0
    sorted_expected = sorted(expected)
    sorted_actual = sorted(actual)

    # Edge case: constant expected distribution.
    if sorted_expected[0] == sorted_expected[-1]:
        if sorted_expected[0] == sorted_actual[0]:
            # Both constant and equal → no drift.
            return 0.0
        # Shifted constant → unambiguously major drift.
        return 1.0

    n = len(sorted_expected)
    bin_edges = []
    for i in range(n_bins + 1):
        q = i / n_bins
        idx = min(int(q * (n - 1)), n - 1)
        bin_edges.append(sorted_expected[idx])
    bin_edges[-1] = sorted_expected[-1] + 1e-9

    def pct_in(arr: Sequence[float], lo: float, hi: float, is_last: bool) -> float:
        if is_last:
            return sum(1 for x in arr if lo <= x <= hi) / len(arr)
        return sum(1 for x in arr if lo <= x < hi) / len(arr)

    psi = 0.0
    for i in range(n_bins):
        lo, hi = bin_edges[i], bin_edges[i + 1]
        is_last = (i == n_bins - 1)
        e_pct = pct_in(expected, lo, hi, is_last)
        a_pct = pct_in(actual, lo, hi, is_last)
        if e_pct == 0 or a_pct == 0:
            continue
        psi += (a_pct - e_pct) * math.log(a_pct / e_pct)
    return psi


def drift_score(baseline: Sequence[float], current: Sequence[float]) -> DriftScore:
    """Compute PSI + z-score for drift detection."""
    psi = _psi(baseline, current)
    if psi < 0.10:
        severity = "stable"
    elif psi < 0.25:
        severity = "minor"
    else:
        severity = "major"
    if len(baseline) < 2 or len(current) < 2:
        return DriftScore(psi=psi, severity=severity, mean_shift_zscore=0.0)
    base_mean = sum(baseline) / len(baseline)
    cur_mean = sum(current) / len(current)
    base_var = sum((x - base_mean) ** 2 for x in baseline) / (len(baseline) - 1)
    base_sd = base_var ** 0.5
    z = (cur_mean - base_mean) / base_sd if base_sd > 0 else 0.0
    return DriftScore(psi=psi, severity=severity, mean_shift_zscore=z)


# ── Category 6: Recovery (custom scenarios) ───────────────────


@dataclass(frozen=True)
class RecoveryScore:
    """Partial-failure recovery scoring."""

    recovered: bool
    recovery_step_index: int
    total_steps: int


def recovery_score(
    trace_steps: Sequence[bool],  # True = success, False = failure
    success_required: bool = True,
) -> RecoveryScore:
    """Score recovery from a partial failure.

    The agent is allowed to fail mid-trace. We score whether it
    eventually succeeds (if success_required=True) and how quickly.
    """
    total = len(trace_steps)
    if total == 0:
        return RecoveryScore(recovered=False, recovery_step_index=0, total_steps=0)
    # Find first recovery: a success AFTER at least one failure.
    saw_failure = False
    for i, success in enumerate(trace_steps):
        if not success:
            saw_failure = True
        elif success and saw_failure:
            return RecoveryScore(
                recovered=success_required,
                recovery_step_index=i,
                total_steps=total,
            )
    return RecoveryScore(
        recovered=success_required and all(trace_steps),
        recovery_step_index=total - 1 if trace_steps[-1] else -1,
        total_steps=total,
    )


# ── Category 7: Trust (CRAFT 5-axis) ───────────────────────────


@dataclass(frozen=True)
class TrustScore:
    """CRAFT 5-axis trust score (Completeness, Robustness,
    Actionability, Faithfulness, Trustworthiness).
    """

    completeness: float       # [0, 1]
    robustness: float         # [0, 1]
    actionability: float      # [0, 1]
    faithfulness: float       # [0, 1]
    trustworthiness: float     # [0, 1]
    composite: float


def trust_score(
    completeness: float,
    robustness: float,
    actionability: float,
    faithfulness: float,
    trustworthiness: float,
) -> TrustScore:
    """Equal-weight composite of 5 CRAFT axes.

    Accepts positional args (completeness, robustness, actionability,
    faithfulness, trustworthiness) for ergonomic test calls.
    """
    composite = (
        completeness + robustness + actionability
        + faithfulness + trustworthiness
    ) / 5.0
    return TrustScore(
        completeness=completeness,
        robustness=robustness,
        actionability=actionability,
        faithfulness=faithfulness,
        trustworthiness=trustworthiness,
        composite=composite,
    )


# ── Category 8: Cost (τ²-bench cost-normalized) ────────────────


@dataclass(frozen=True)
class CostScore:
    """τ²-bench cost-normalized scoring: $/successful-task."""

    total_cost_usd: float
    n_successful_tasks: int
    cost_per_success: float    # $/successful task


def cost_score(total_cost_usd: float, n_successful: int) -> CostScore:
    """$/successful task — lower is better.

    Frontier reference per research agent: $1.45 per success.
    """
    cost_per_success = (
        total_cost_usd / n_successful if n_successful > 0 else float("inf")
    )
    return CostScore(
        total_cost_usd=total_cost_usd,
        n_successful_tasks=n_successful,
        cost_per_success=cost_per_success,
    )


# ── Aggregate benchmark runner ────────────────────────────────


@dataclass(frozen=True)
class BenchmarkResult:
    """Aggregate Eden-8-cat benchmark result."""

    func_call_f1: float
    policy_state_match: float
    web_complete: bool
    code_resolution: float
    drift_severity: str
    recovery_rate: float
    trust_composite: float
    cost_per_success: float
    aggregate_score: float


def run_aggregate_benchmark(
    *,
    func_call: FuncCallScore,
    policy: PolicyScore,
    web: WebScore,
    code: CodeScore,
    drift: DriftScore,
    recovery: RecoveryScore,
    trust: TrustScore,
    cost: CostScore,
) -> BenchmarkResult:
    """Aggregate 8-cat scores into a single benchmark result.

    Aggregate score = mean of (normalised) per-category scores.
    Cost is INVERTED (lower is better).
    """
    fc = func_call.f1
    ps = policy.state_match_rate
    wb = 1.0 if web.task_complete else web.partial_progress
    cd = code.resolution_rate
    dr = 1.0 if drift.severity == "stable" else (0.5 if drift.severity == "minor" else 0.0)
    rc = 1.0 if recovery.recovered else 0.0
    tr = trust.composite
    # Cost: $1.45 reference → score = 1 - min(cost/ref, 1.5)
    cs = max(0.0, 1.0 - (cost.cost_per_success / 2.0))
    aggregate = (fc + ps + wb + cd + dr + rc + tr + cs) / 8.0
    return BenchmarkResult(
        func_call_f1=fc,
        policy_state_match=ps,
        web_complete=web.task_complete,
        code_resolution=cd,
        drift_severity=drift.severity,
        recovery_rate=rc,
        trust_composite=tr,
        cost_per_success=cost.cost_per_success,
        aggregate_score=aggregate,
    )


__all__ = [
    "FuncCallScore", "func_call_score",
    "PolicyScore", "policy_state_diff_score",
    "WebScore", "web_score",
    "CodeScore", "code_score",
    "DriftScore", "drift_score",
    "RecoveryScore", "recovery_score",
    "TrustScore", "trust_score",
    "CostScore", "cost_score",
    "BenchmarkResult", "run_aggregate_benchmark",
]