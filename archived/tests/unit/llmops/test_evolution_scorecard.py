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
    assert result.get("synthetic") is True
    assert result.get("kind") == "process_gate_microbench"
    # Placeholders must not look like real org KPIs (0.0).
    assert metrics.get("lift_gate_pp") in (None, "n/a (synthetic)")
    assert metrics.get("cost_gate_usd") in (None, "n/a (synthetic)")


def test_run_scorecard_smoke_declares_synthetic() -> None:
    result = run_scorecard(suite="smoke")
    assert result.get("synthetic") is True
    assert result.get("kind") == "process_gate_microbench"
    assert "not org production" in (result.get("disclaimer") or "").lower()
