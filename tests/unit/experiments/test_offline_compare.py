"""Unit tests for F51 offline experiment compare."""

from __future__ import annotations

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
