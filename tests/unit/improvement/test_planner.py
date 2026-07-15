"""Unit tests for N23 improvement planner."""

from __future__ import annotations

from eden.improvement.planner import PlanCandidate, rank_candidates


def test_rank_candidates_orders_by_score() -> None:
    low = PlanCandidate(
        plan_kind="code_patch",
        title="low",
        source_ref="a",
        source_fingerprint="a",
        severity="low",
        confidence=0.3,
    )
    high = PlanCandidate(
        plan_kind="code_patch",
        title="high",
        source_ref="b",
        source_fingerprint="b",
        severity="critical",
        confidence=0.9,
        estimated_blast_radius="low",
    )
    ranked = rank_candidates([low, high])
    assert ranked[0].title == "high"
    assert ranked[1].title == "low"


def test_plan_candidate_score_increases_with_severity() -> None:
    crit = PlanCandidate(
        plan_kind="code_patch",
        title="c",
        source_ref="c",
        source_fingerprint="c",
        severity="critical",
        confidence=0.8,
    )
    med = PlanCandidate(
        plan_kind="code_patch",
        title="m",
        source_ref="m",
        source_fingerprint="m",
        severity="medium",
        confidence=0.8,
    )
    assert crit.score > med.score
