"""Unit tests for the evolution scorecard (API-shipped, not bench-only)."""

from __future__ import annotations

from eden.llmops.evolution_scorecard import run_scorecard


def test_run_scorecard_smoke_shape() -> None:
    result = run_scorecard(suite="smoke")
    assert "metrics" in result
    assert "failed" in result
    metrics = result["metrics"]
    assert metrics["suite"] == "smoke"
    assert metrics["inject_tokens"] > 0
    assert "hot_path_p95_ms" in metrics
    assert metrics["trigger_dsl_ok"] is True
    assert metrics["elapsed_ms"] >= 0.01
    assert "full_suite" not in metrics


def test_run_scorecard_full_adds_gates() -> None:
    result = run_scorecard(suite="full")
    metrics = result["metrics"]
    assert metrics["suite"] == "full"
    assert metrics["full_suite"] is True
    assert "lift_gate_pp" in metrics
    assert "cost_gate_usd" in metrics
