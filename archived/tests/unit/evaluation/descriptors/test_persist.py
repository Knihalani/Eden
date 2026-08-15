"""Tests for Layer A persist → tags + judge_scores shaping."""

from __future__ import annotations

from eden.evaluation.descriptors.engine import DescriptorEngine
from eden.evaluation.descriptors.persist import report_to_judge_score_rows
from tests.unit.evaluation.descriptors.cases import LAYER_A_CASES


def test_report_includes_aggregate_axes() -> None:
    case = next(c for c in LAYER_A_CASES if c["id"] == "healthy_transfer")
    report = DescriptorEngine().describe(case["events"], trace_id=case["id"])
    rows = report_to_judge_score_rows("org", "tr", report)
    axes = {r["judge_id"] for r in rows}
    for axis in (
        "tool_selection_quality",
        "action_completion",
        "groundedness",
        "safety",
        "efficiency",
        "trace_quality",
    ):
        assert axis in axes
    tq = next(r for r in rows if r["judge_id"] == "trace_quality")
    assert tq["score"] >= 0.95
    assert tq["metadata"]["source"] == "layer_a"
