"""Unit tests for Phase 2b — GitHub webhook syncs improvement_plans on PR close.

``approve.py`` opens PRs and leaves the linked plan at ``pr_opened``.
Nothing previously updated the plan when the PR was merged/closed on
GitHub, so the portal's Improve inbox got stuck. These tests cover
``_sync_improvement_plan_on_pr_close`` — the helper the webhook calls
on ``pull_request`` ``closed`` events.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.api.routes.github import _sync_improvement_plan_on_pr_close


@pytest.mark.asyncio
async def test_pr_merged_marks_plan_merged_and_reuses_verify_scheduling() -> None:
    plan = {
        "id": "plan-1",
        "org_id": "org-1",
        "github_branch": "eden/improve-plan-1",
        "evidence": {"issue_id": "iss-1"},
    }
    merged_plan = {**plan, "status": "merged"}
    with (
        patch(
            "eden.improvement.plans_repo.find_by_pr",
            AsyncMock(return_value=plan),
        ) as find_by_pr,
        patch(
            "eden.improvement.plans_repo.mark_merged",
            AsyncMock(return_value=merged_plan),
        ) as mark_merged,
        patch(
            "eden.improvement.plans_repo.mark_closed",
            AsyncMock(),
        ) as mark_closed,
        patch(
            "eden.improvement.approve.queue_verify_for_plan",
            AsyncMock(return_value="verify-1"),
        ) as queue_verify,
    ):
        await _sync_improvement_plan_on_pr_close(
            repo_full="acme/widgets", pr_number=42, merged=True,
        )

    find_by_pr.assert_awaited_once_with(
        repo_full_name="acme/widgets", pr_number=42
    )
    mark_merged.assert_awaited_once_with("org-1", "plan-1")
    queue_verify.assert_awaited_once_with(
        "org-1", merged_plan, branch="eden/improve-plan-1"
    )
    mark_closed.assert_not_awaited()


@pytest.mark.asyncio
async def test_pr_closed_without_merge_marks_plan_closed() -> None:
    plan = {
        "id": "plan-2",
        "org_id": "org-1",
        "github_branch": "eden/improve-plan-2",
    }
    with (
        patch(
            "eden.improvement.plans_repo.find_by_pr",
            AsyncMock(return_value=plan),
        ),
        patch(
            "eden.improvement.plans_repo.mark_merged",
            AsyncMock(),
        ) as mark_merged,
        patch(
            "eden.improvement.plans_repo.mark_closed",
            AsyncMock(return_value={**plan, "status": "closed"}),
        ) as mark_closed,
        patch(
            "eden.improvement.approve.queue_verify_for_plan",
            AsyncMock(),
        ) as queue_verify,
    ):
        await _sync_improvement_plan_on_pr_close(
            repo_full="acme/widgets", pr_number=7, merged=False,
        )

    mark_closed.assert_awaited_once_with(
        "org-1", "plan-2", reason="pr_closed_without_merge"
    )
    mark_merged.assert_not_awaited()
    queue_verify.assert_not_awaited()


@pytest.mark.asyncio
async def test_no_linked_plan_is_a_noop() -> None:
    with (
        patch(
            "eden.improvement.plans_repo.find_by_pr",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.improvement.plans_repo.mark_merged",
            AsyncMock(),
        ) as mark_merged,
        patch(
            "eden.improvement.plans_repo.mark_closed",
            AsyncMock(),
        ) as mark_closed,
    ):
        await _sync_improvement_plan_on_pr_close(
            repo_full="acme/widgets", pr_number=1, merged=True,
        )

    mark_merged.assert_not_awaited()
    mark_closed.assert_not_awaited()


@pytest.mark.asyncio
async def test_sync_failure_is_swallowed_not_raised() -> None:
    """A DB blip here must never fail the GitHub webhook response."""
    with patch(
        "eden.improvement.plans_repo.find_by_pr",
        AsyncMock(side_effect=RuntimeError("db down")),
    ):
        await _sync_improvement_plan_on_pr_close(
            repo_full="acme/widgets", pr_number=1, merged=True,
        )
