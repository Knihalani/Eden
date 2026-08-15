"""StatGate incident-scorer performance microbench — N08 SLA gate.

Asserts that ``StatGateIncidentScorer.score`` (the deterministic P0
auto-escalation check run before any LLM triage) stays under the
PERFORMANCE-COST-STANDARDS §1 SLA for "StatGate checks (N08)":
p95 < 80ms, p99 < 150ms (no LLM, no I/O).

Run with::

    uv run pytest tests/perf/test_statgate_microbench.py -s

Mirrors ``tests/perf/test_hot_path_microbench.py`` (the F83 NudgeEngine
bench): pure-compute timing loop over synthetic inputs, with p50/p95/p99
printed explicitly so CI logs carry the measured numbers, not just a
pass/fail.

Each timed iteration is one ``score()`` call — one StatGate check — drawn
round-robin from a pre-built pool of representative synthetic incidents:

* a mix of issue kinds (``loop``, ``tool_error``, ``mcp_auth_failure``,
  ``latency_regression``, plain) and severities (p0..p3);
* 0–8 attached stumbles carrying the P0 signals the scorer reads
  (``statgate_p0``, ``mcp_auth_failure``, ``repeat_count``,
  ``etec_loop_score``, ``cost_z_score``);
* ~20% of incidents carry ``triage_result.metric_samples`` with 60
  control / 60 treatment floats so the numeric StatGate regression path
  (``supplementaries.phase_6_stat_gate.gate.evaluate``) is exercised too.
"""

from __future__ import annotations

import random
import statistics
import time
from typing import Any

import pytest

P95_THRESHOLD_MS = 80.0
P99_THRESHOLD_MS = 150.0
ITERATIONS = 2000
INCIDENT_POOL_SIZE = 200
_SEED = 20260804


def _build_incident_pool(
    size: int = INCIDENT_POOL_SIZE,
) -> list[tuple[dict[str, Any], list[dict[str, Any]]]]:
    """Synthetic (issue, stumbles) pairs covering every scorer branch."""
    rng = random.Random(_SEED)
    kinds = ["loop", "tool_error", "mcp_auth_failure", "latency_regression", ""]
    severities = ["p0", "p1", "p2", "p3"]
    stumble_kinds = ["statgate_p0", "mcp_auth_failure", "tool_error", "loop", ""]

    pool: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    for i in range(size):
        issue: dict[str, Any] = {
            "id": f"issue-{i}",
            "kind": rng.choice(kinds),
            "severity": rng.choice(severities),
            "stumble_count": rng.randint(0, 8),
            "title": f"synthetic incident {i}",
        }

        # ~20% carry before/after metric samples so the numeric
        # StatGate regression branch (_maybe_gate) runs.
        if i % 5 == 0:
            base = rng.uniform(0.5, 2.0)
            shift = rng.choice([0.0, 0.4])
            issue["triage_result"] = {
                "metric_samples": {
                    "control": [base + rng.gauss(0, 0.05) for _ in range(60)],
                    "treatment": [
                        base + shift + rng.gauss(0, 0.05) for _ in range(60)
                    ],
                }
            }

        stumbles: list[dict[str, Any]] = []
        for j in range(rng.randint(0, 8)):
            detail: dict[str, Any] = {}
            if rng.random() < 0.4:
                detail["repeat_count"] = rng.randint(1, 6)
            if rng.random() < 0.3:
                detail["etec_loop_score"] = round(rng.uniform(0.0, 1.0), 3)
            if rng.random() < 0.3:
                detail["cost_z_score"] = round(rng.uniform(0.0, 5.0), 2)
            stumbles.append(
                {
                    "id": f"stumble-{i}-{j}",
                    "kind": rng.choice(stumble_kinds),
                    "detail": detail,
                }
            )

        pool.append((issue, stumbles))
    return pool


def _percentile(sorted_samples: list[float], pct: float) -> float:
    idx = min(len(sorted_samples) - 1, int(len(sorted_samples) * pct))
    return sorted_samples[idx]


def _run_microbench(iterations: int = ITERATIONS) -> dict[str, Any]:
    from eden.issues.statgate_scorer import StatGateIncidentScorer

    scorer = StatGateIncidentScorer()
    pool = _build_incident_pool()

    # Warm-up: touch every incident once (imports, first-call caches).
    for issue, stumbles in pool:
        scorer.score(issue, stumbles)

    samples_ms: list[float] = []
    for i in range(iterations):
        issue, stumbles = pool[i % len(pool)]
        start = time.perf_counter()
        scorer.score(issue, stumbles)
        samples_ms.append((time.perf_counter() - start) * 1000.0)

    samples_ms.sort()
    return {
        "iterations": iterations,
        "p50_ms": statistics.median(samples_ms),
        "p95_ms": _percentile(samples_ms, 0.95),
        "p99_ms": _percentile(samples_ms, 0.99),
    }


def test_statgate_p95_p99_under_sla():
    """StatGate check latency must meet the N08 SLA (§1: p95<80ms, p99<150ms)."""
    result = _run_microbench(iterations=ITERATIONS)

    p50 = result["p50_ms"]
    p95 = result["p95_ms"]
    p99 = result["p99_ms"]

    # Emit numbers into pytest output so CI logs carry evidence.
    print(
        f"\n[N08 statgate] iterations={ITERATIONS} "
        f"pool={INCIDENT_POOL_SIZE} "
        f"p50={p50:.4f}ms p95={p95:.4f}ms p99={p99:.4f}ms"
    )

    assert p95 < P95_THRESHOLD_MS, (
        f"p95 {p95:.4f}ms >= threshold {P95_THRESHOLD_MS}ms — "
        f"StatGate scorer regression"
    )
    assert p99 < P99_THRESHOLD_MS, (
        f"p99 {p99:.4f}ms >= threshold {P99_THRESHOLD_MS}ms — "
        f"StatGate scorer regression"
    )


def test_statgate_microbench_returns_required_keys():
    """_run_microbench must return p50/p95/p99 keys."""
    result = _run_microbench(iterations=100)
    assert "p50_ms" in result
    assert "p95_ms" in result
    assert "p99_ms" in result
    assert "iterations" in result


def test_statgate_pool_exercises_p0_and_gate_paths():
    """The synthetic pool must hit both P0 escalations and the numeric gate."""
    from eden.issues.statgate_scorer import StatGateIncidentScorer

    scorer = StatGateIncidentScorer()
    escalated = 0
    gate_ran = 0
    for issue, stumbles in _build_incident_pool():
        score = scorer.score(issue, stumbles)
        if score.auto_escalate:
            escalated += 1
        if score.detail.get("gate_verdict"):
            gate_ran += 1

    assert escalated > 0, "pool never triggered auto-escalation"
    assert gate_ran > 0, "pool never exercised the numeric StatGate path"
