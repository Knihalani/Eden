"""Focused unit tests for Improve value gates + rank-then-generate."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.improvement.issue_patch_trigger import (
    issue_passes_cheap_gates,
    propose_plan_for_issue,
)
from eden.improvement.planner import PlanCandidate, persist_candidates, rank_candidates
from eden.improvement.sweep_budget import (
    begin_sweep_llm_budget,
    clear_sweep_llm_budget,
    try_consume_llm_call,
)
from eden.issues.models import Issue


def _issue(**kw):
    base = {
        "id": "iss-1",
        "org_id": "org_test",
        "fingerprint": "fp-1",
        "kind": "tool_error",
        "title": "checkout loop",
        "status": "triaged",
        "severity": "p1",
        "agent_id": "agent-a",
        "stumble_count": 8,
        "user_count": 2,
        "triage_result": {
            "confidence": 0.8,
            "recommended_action": "code_change",
            "candidate_files": ["a.py"],
        },
    }
    base.update(kw)
    return Issue(**base)


def test_cheap_gates_reject_low_confidence() -> None:
    ok, reason = issue_passes_cheap_gates(
        _issue(triage_result={"confidence": 0.4, "recommended_action": "code_change"})
    )
    assert ok is False
    assert reason == "confidence_below_floor"


def test_cheap_gates_reject_low_stumble() -> None:
    ok, reason = issue_passes_cheap_gates(_issue(stumble_count=2))
    assert ok is False
    assert reason == "fingerprint_below_threshold"


def test_cheap_gates_reject_non_code_action() -> None:
    ok, reason = issue_passes_cheap_gates(
        _issue(
            triage_result={
                "confidence": 0.9,
                "recommended_action": "investigate",
            }
        )
    )
    assert ok is False
    assert reason == "recommended_action_not_code"


def test_cheap_gates_accept_eligible() -> None:
    ok, reason = issue_passes_cheap_gates(_issue())
    assert ok is True
    assert reason == "ok"


def test_rank_includes_stumble_boost() -> None:
    low_stumble = PlanCandidate(
        plan_kind="code_patch",
        title="a",
        source_ref="a",
        source_fingerprint="a",
        severity="high",
        confidence=0.8,
        evidence={"stumble_count": 5},
    )
    high_stumble = PlanCandidate(
        plan_kind="code_patch",
        title="b",
        source_ref="b",
        source_fingerprint="b",
        severity="high",
        confidence=0.8,
        evidence={"stumble_count": 40},
    )
    ranked = rank_candidates([low_stumble, high_stumble])
    assert ranked[0].title == "b"


@pytest.mark.asyncio
async def test_persist_skips_empty_code_patch() -> None:
    empty = PlanCandidate(
        plan_kind="code_patch",
        title="empty",
        source_ref="e",
        source_fingerprint="e",
        severity="high",
        confidence=0.9,
        diff_unified="",
    )
    with patch(
        "eden.improvement.planner.plans_repo.create_plan",
        AsyncMock(),
    ) as create:
        created, skipped = await persist_candidates("org", [empty], max_plans=10)
    assert created == []
    assert skipped == 1
    create.assert_not_awaited()


@pytest.mark.asyncio
async def test_propose_suppresses_low_quality() -> None:
    issue = _issue()
    with (
        patch(
            "eden.improvement.issue_patch_trigger._improvement_enabled",
            AsyncMock(return_value=True),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._issue_context",
            AsyncMock(
                return_value={
                    "issue": issue,
                    "agent_id": "agent-a",
                    "kind": issue.kind,
                    "fingerprint": issue.fingerprint,
                    "triage": issue.triage_result,
                    "rca_summary": "rca",
                }
            ),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._n22_may_propose",
            AsyncMock(return_value=(True, "ok")),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._budget_ok",
            AsyncMock(return_value=(True, "ok")),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._find_open_plan",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.improvement.plans_repo.is_rejection_active",
            AsyncMock(return_value=False),
        ),
        patch(
            "eden.closed_loop.efficiency.AgentEfficiencyController.should_run_patch",
            AsyncMock(return_value=(True, "ok")),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._resolve_repo_id",
            AsyncMock(return_value="repo-1"),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._linked_files",
            AsyncMock(return_value=[{"path": "a.py", "content": ""}]),
        ),
        patch(
            "eden.patches.patch_generator.PatchGenerator.generate",
            AsyncMock(
                return_value={
                    "data": {
                        "status": "low_quality",
                        "diff": "--- a\n+++ b\n",
                        "cost_usd": 0.1,
                    }
                }
            ),
        ),
        patch(
            "eden.improvement.plans_repo.create_plan",
            AsyncMock(),
        ) as create,
    ):
        result = await propose_plan_for_issue("org_test", "iss-1")
    assert result["status"] == "suppressed"
    assert result["reason"] == "low_quality"
    create.assert_not_awaited()


@pytest.mark.asyncio
async def test_propose_suppresses_rejection_memory() -> None:
    issue = _issue()
    with (
        patch(
            "eden.improvement.issue_patch_trigger._improvement_enabled",
            AsyncMock(return_value=True),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._issue_context",
            AsyncMock(
                return_value={
                    "issue": issue,
                    "agent_id": "agent-a",
                    "kind": issue.kind,
                    "fingerprint": issue.fingerprint,
                    "triage": issue.triage_result,
                    "rca_summary": "rca",
                }
            ),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._n22_may_propose",
            AsyncMock(return_value=(True, "ok")),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._budget_ok",
            AsyncMock(return_value=(True, "ok")),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._find_open_plan",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.improvement.plans_repo.is_rejection_active",
            AsyncMock(return_value=True),
        ),
        patch(
            "eden.patches.patch_generator.PatchGenerator.generate",
            AsyncMock(),
        ) as generate,
    ):
        result = await propose_plan_for_issue("org_test", "iss-1")
    assert result["status"] == "suppressed"
    assert result["reason"] == "rejection_memory"
    generate.assert_not_awaited()


@pytest.mark.asyncio
async def test_rank_and_generate_caps_at_three() -> None:
    from eden.improvement.agent import ImprovementAgent

    issues = []
    for i in range(8):
        issues.append(
            _issue(
                id=f"iss-{i}",
                title=f"bug {i}",
                stumble_count=10 + i,
                triage_result={
                    "confidence": 0.9,
                    "recommended_action": "code_change",
                },
            )
        )

    propose = AsyncMock(
        return_value={"status": "proposed", "plan_id": "p1", "plan": {"llm_cost_usd": 0.01}}
    )

    with (
        patch("eden.issues.repo.IssuesRepo") as repo_cls,
        patch(
            "eden.improvement.agent.plans_repo.find_open_fingerprints",
            AsyncMock(return_value=set()),
        ),
        patch(
            "eden.improvement.agent.plans_repo.is_rejection_active",
            AsyncMock(return_value=False),
        ),
        patch(
            "eden.improvement.agent.plans_repo.find_blocking_by_fingerprint",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.improvement.issue_patch_trigger.propose_plan_for_issue",
            propose,
        ),
    ):
        repo = MagicMock()
        repo.list_issues = AsyncMock(side_effect=[issues, []])
        repo_cls.return_value = repo
        result = await ImprovementAgent()._rank_and_generate_issue_patches(
            "org-1",
            __import__("datetime").datetime(2020, 1, 1),
            None,
            run_id="run-1",
            max_generates=3,
        )

    assert result["created"] == 3
    assert propose.await_count == 3


def test_sweep_llm_budget_consumes() -> None:
    begin_sweep_llm_budget(2)
    try:
        assert try_consume_llm_call() is True
        assert try_consume_llm_call() is True
        assert try_consume_llm_call() is False
    finally:
        clear_sweep_llm_budget()


@pytest.mark.asyncio
async def test_propose_suppresses_no_linked_files() -> None:
    issue = _issue()
    with (
        patch(
            "eden.improvement.issue_patch_trigger._improvement_enabled",
            AsyncMock(return_value=True),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._issue_context",
            AsyncMock(
                return_value={
                    "issue": issue,
                    "agent_id": "agent-a",
                    "kind": issue.kind,
                    "fingerprint": issue.fingerprint,
                    "triage": issue.triage_result,
                    "rca_summary": "rca",
                }
            ),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._n22_may_propose",
            AsyncMock(return_value=(True, "ok")),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._budget_ok",
            AsyncMock(return_value=(True, "ok")),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._find_open_plan",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.improvement.plans_repo.is_rejection_active",
            AsyncMock(return_value=False),
        ),
        patch(
            "eden.closed_loop.efficiency.AgentEfficiencyController.should_run_patch",
            AsyncMock(return_value=(True, "ok")),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._resolve_repo_id",
            AsyncMock(return_value="repo-1"),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._linked_files",
            AsyncMock(return_value=[]),
        ),
        patch(
            "eden.patches.patch_generator.PatchGenerator.generate",
            AsyncMock(),
        ) as generate,
    ):
        result = await propose_plan_for_issue("org_test", "iss-1")
    assert result["status"] == "suppressed"
    assert result["reason"] == "no_linked_files"
    generate.assert_not_awaited()


@pytest.mark.asyncio
async def test_propose_suppresses_patch_max_per_day() -> None:
    issue = _issue()
    with (
        patch(
            "eden.improvement.issue_patch_trigger._improvement_enabled",
            AsyncMock(return_value=True),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._issue_context",
            AsyncMock(
                return_value={
                    "issue": issue,
                    "agent_id": "agent-a",
                    "kind": issue.kind,
                    "fingerprint": issue.fingerprint,
                    "triage": issue.triage_result,
                    "rca_summary": "rca",
                }
            ),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._n22_may_propose",
            AsyncMock(return_value=(True, "ok")),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._budget_ok",
            AsyncMock(return_value=(False, "patch_max_per_day:10>=10")),
        ),
        patch(
            "eden.patches.patch_generator.PatchGenerator.generate",
            AsyncMock(),
        ) as generate,
    ):
        result = await propose_plan_for_issue("org_test", "iss-1")
    assert result["status"] == "suppressed"
    assert "patch_max_per_day" in result["reason"]
    generate.assert_not_awaited()


@pytest.mark.asyncio
async def test_budget_ok_enforces_patch_max_per_day() -> None:
    from eden.improvement.issue_patch_trigger import _budget_ok

    settings = MagicMock()
    settings.daily_maintenance_budget_usd = 0
    settings.patch_max_per_day = 3
    with (
        patch("eden.config.get_settings", return_value=settings),
        patch(
            "eden.improvement.plans_repo.count_code_patches_today",
            AsyncMock(return_value=3),
        ),
    ):
        ok, reason = await _budget_ok("org_test")
    assert ok is False
    assert reason.startswith("patch_max_per_day:")
