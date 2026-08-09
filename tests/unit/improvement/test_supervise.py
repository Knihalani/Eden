"""Unit tests for operator supervision (manual merge / revert)."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.improvement.supervise import manual_merge_plan, manual_revert_plan


@pytest.mark.asyncio
async def test_manual_merge_invalid_state() -> None:
    with patch(
        "eden.improvement.supervise.plans_repo.get_plan",
        new=AsyncMock(return_value={"id": "p1", "status": "draft"}),
    ):
        result = await manual_merge_plan("org_1", "p1", merged_by="user_1")
    assert result["status"] == "invalid_state"


@pytest.mark.asyncio
async def test_manual_merge_success() -> None:
    plan = {
        "id": "p1",
        "status": "pr_opened",
        "plan_kind": "code_patch",
        "pr_number": 42,
        "pr_url": "https://github.com/o/r/pull/42",
        "github_branch": "eden/improve-p1",
        "title": "Fix",
        "evidence": {},
    }
    with patch(
        "eden.improvement.supervise.plans_repo.get_plan",
        new=AsyncMock(return_value=plan),
    ), patch(
        "eden.providers.factory.get_pr_provider_for_org",
        new=AsyncMock(return_value=object()),
    ), patch(
        "eden.improvement.auto_merge.merge_pull_request",
        new=AsyncMock(return_value={"ok": True}),
    ), patch(
        "eden.improvement.supervise._merge_plan_evidence",
        new=AsyncMock(return_value=plan),
    ), patch(
        "eden.improvement.supervise.plans_repo.mark_merged",
        new=AsyncMock(return_value={**plan, "status": "merged"}),
    ), patch(
        "eden.improvement.supervise.queue_verify_for_plan",
        new=AsyncMock(return_value="verify_1"),
    ), patch(
        "eden.improvement.supervise._n06_ledger",
        new=AsyncMock(),
    ), patch(
        "eden.improvement.supervise.plans_repo.emit_event",
        new=AsyncMock(),
    ):
        result = await manual_merge_plan("org_1", "p1", merged_by="user_1")
    assert result["status"] == "merged"
    assert result["pr_number"] == 42


@pytest.mark.asyncio
async def test_manual_revert_blocked_by_policy() -> None:
    plan = {
        "id": "p1",
        "status": "merged",
        "plan_kind": "code_patch",
        "evidence": {"issue_id": "iss_1"},
    }
    with patch(
        "eden.improvement.supervise.plans_repo.get_plan",
        new=AsyncMock(return_value=plan),
    ), patch(
        "eden.improvement.guardian._decide_revert_allowed",
        new=AsyncMock(return_value=False),
    ):
        result = await manual_revert_plan("org_1", "p1", reverted_by="user_1")
    assert result["status"] == "blocked"
    assert result["blocked_reason"] == "rollback_policy_denied"


@pytest.mark.asyncio
async def test_manual_revert_drafts_and_approves() -> None:
    parent = {
        "id": "p1",
        "status": "merged",
        "plan_kind": "code_patch",
        "evidence": {"issue_id": "iss_1"},
    }
    revert = {"id": "p2", "plan_kind": "code_patch", "status": "draft"}
    with patch(
        "eden.improvement.supervise.plans_repo.get_plan",
        new=AsyncMock(return_value=parent),
    ), patch(
        "eden.improvement.guardian._decide_revert_allowed",
        new=AsyncMock(return_value=True),
    ), patch(
        "eden.improvement.guardian._existing_follow_up",
        new=AsyncMock(return_value=False),
    ), patch(
        "eden.improvement.guardian._draft_revert",
        new=AsyncMock(return_value=(revert, None)),
    ), patch(
        "eden.improvement.supervise.approve_plan",
        new=AsyncMock(
            return_value={
                "status": "pr_opened",
                "pr_url": "https://github.com/o/r/pull/99",
                "plan": revert,
            }
        ),
    ), patch(
        "eden.patches.knowledge_graph.record_plan_outcome",
        new=AsyncMock(),
    ), patch(
        "eden.improvement.supervise._merge_plan_evidence",
        new=AsyncMock(return_value=parent),
    ), patch(
        "eden.improvement.supervise._n06_ledger",
        new=AsyncMock(),
    ), patch(
        "eden.improvement.supervise.plans_repo.emit_event",
        new=AsyncMock(),
    ):
        result = await manual_revert_plan("org_1", "p1", reverted_by="user_1")
    assert result["status"] == "revert_initiated"
    assert result["revert_plan_id"] == "p2"
