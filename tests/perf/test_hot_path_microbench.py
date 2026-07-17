"""Hot-path guardrail performance microbench — F83 workstream #1.

Asserts that ``NudgeEngine.evaluate_sync`` (the guardrail evaluation
called on every ingest request) stays under the 5ms p99 target.

Run with::

    .venv/bin/python -m pytest tests/perf/test_hot_path_microbench.py -q

This test is the runnable evidence gate for the F83 "Ingest <5ms p99"
workstream.  It exercises ``microbench_evaluate_sync`` — the same function
called by ``bench/evolution/scorecard.py`` — and records p50/p95/p99
explicitly so CI logs carry the measured numbers, not just a pass/fail.
"""

from __future__ import annotations

import pytest

P99_THRESHOLD_MS = 5.0
P95_THRESHOLD_MS = 5.0
ITERATIONS = 2000


def test_hot_path_p99_under_5ms():
    """p99 guardrail latency must be < 5ms (F83 §1 target)."""
    from eden.nudges.engine import microbench_evaluate_sync

    result = microbench_evaluate_sync(iterations=ITERATIONS)

    p50 = result["p50_ms"]
    p95 = result["p95_ms"]
    p99 = result["p99_ms"]

    # Emit numbers into pytest output so CI logs carry evidence.
    print(
        f"\n[F83 hot-path] iterations={ITERATIONS} "
        f"p50={p50:.4f}ms p95={p95:.4f}ms p99={p99:.4f}ms"
    )

    assert p95 < P95_THRESHOLD_MS, (
        f"p95 {p95:.4f}ms >= threshold {P95_THRESHOLD_MS}ms — "
        f"hot-path guardrail regression"
    )
    assert p99 < P99_THRESHOLD_MS, (
        f"p99 {p99:.4f}ms >= threshold {P99_THRESHOLD_MS}ms — "
        f"hot-path guardrail regression"
    )


def test_hot_path_returns_required_keys():
    """microbench_evaluate_sync must return p50/p95/p99 keys."""
    from eden.nudges.engine import microbench_evaluate_sync

    result = microbench_evaluate_sync(iterations=100)
    assert "p50_ms" in result
    assert "p95_ms" in result
    assert "p99_ms" in result
    assert "iterations" in result
