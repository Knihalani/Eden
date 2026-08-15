"""Contract tests for learn-route production wiring (scorecard + onboarding)."""

from __future__ import annotations

import ast
import inspect
from pathlib import Path

from eden.llmops.evolution_scorecard import run_scorecard


def test_scorecard_smoke_does_not_fail() -> None:
    result = run_scorecard(suite="smoke")
    assert result["failed"] is False
    assert result["metrics"]["trigger_dsl_ok"] is True


def test_improve_scorecard_route_imports_api_package() -> None:
    """Regression: production Docker only ships src/, not bench/."""
    learn_path = (
        Path(__file__).resolve().parents[3]
        / "src"
        / "eden"
        / "api"
        / "routes"
        / "learn.py"
    )
    source = learn_path.read_text(encoding="utf-8")
    assert "from eden.llmops.evolution_scorecard import run_scorecard" in source
    assert "from bench.evolution.scorecard" not in source
    assert "sys.path.insert" not in source or "improve_scorecard" not in source


def test_improvement_loop_sdk_step_points_at_live_connect() -> None:
    learn_path = (
        Path(__file__).resolve().parents[3]
        / "src"
        / "eden"
        / "api"
        / "routes"
        / "learn.py"
    )
    source = learn_path.read_text(encoding="utf-8")
    assert '"href": "/agents/connect"' in source
    assert '"href": "/onboarding/connect"' not in source
