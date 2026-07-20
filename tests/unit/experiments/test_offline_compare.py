"""Unit tests for F51 offline experiment compare."""

from __future__ import annotations

import pytest

from eden.experiments.compare import aggregate_grades, grade_datapoint


def test_grade_improvement() -> None:
    grade, delta = grade_datapoint({"score": 0.5}, {"score": 0.8})
    assert grade == "improvement"
    assert delta > 0


def test_grade_regression() -> None:
    grade, _ = grade_datapoint({"score": 0.9}, {"score": 0.4})
    assert grade == "regression"


def test_aggregate() -> None:
    counts = aggregate_grades(["improvement", "improvement", "regression", "tie"])
    assert counts["improvement"] == 2
    assert counts["regression"] == 1


@pytest.mark.asyncio
async def test_run_row_marks_heuristic_stub() -> None:
    from eden.experiments.offline_runner import OfflineExperimentRunner

    out = await OfflineExperimentRunner()._run_row(
        {"input": "hello", "expected_output": ""},
        {"model": "stub"},
    )
    assert out["synthetic"] is True
    assert out["method"] == "heuristic_stub"
    assert "score" in out
