"""Unit tests for N23 approve flow."""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.improvement.approve import ApproveBlocked, approve_plan
from eden.providers import PullRequestInfo


_SAMPLE_DIFF = """--- a/foo.py
+++ b/foo.py
@@ -1 +1 @@
-old
+new
"""


@pytest.mark.asyncio
async def test_approve_plan_opens_pr_and_updates_status() -> None:
    plan = {
        "id": "plan-1",
        "status": "draft",
        "plan_kind": "code_patch",
        "agent_id": "repo-a",
        "title": "Fix foo",
        "summary": "summary",
        "diff_unified": _SAMPLE_DIFF,
        "evidence": {"issue_id": "iss-1"},
    }
    pr_info = PullRequestInfo(
        number=42,
        title="[Eden] Fix foo",
        body="summary",
        branch="eden/improve-plan-1",
        base="main",
        url="https://github.com/org/repo/pull/42",
        state="open",
        created_at=datetime.now(UTC),
    )
    mock_provider = MagicMock()
    mock_provider.create_pr = AsyncMock(return_value=pr_info)

    with (
        patch(
            "eden.improvement.approve.plans_repo.get_plan",
            AsyncMock(return_value=plan),
        ),
        patch(
            "eden.improvement.approve._n22_blocked",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.improvement.approve.plans_repo.mark_pr_opened",
            AsyncMock(return_value={**plan, "status": "pr_opened"}),
        ),
        patch(
            "eden.improvement.approve._queue_verify",
            AsyncMock(return_value="verify-1"),
        ),
        patch("eden.improvement.approve._audit_approve", AsyncMock()),
    ):
        result = await approve_plan(
            "org-1", "plan-1", approved_by="user-1", provider=mock_provider
        )

    assert result["status"] == "pr_opened"
    assert result["pr_number"] == 42
    assert result["pr_url"] == "https://github.com/org/repo/pull/42"
    mock_provider.create_pr.assert_awaited_once()


@pytest.mark.asyncio
async def test_approve_plan_n22_deny_raises() -> None:
    plan = {
        "id": "plan-1",
        "status": "draft",
        "plan_kind": "code_patch",
        "diff_unified": _SAMPLE_DIFF,
        "agent_id": "repo-a",
    }
    with (
        patch(
            "eden.improvement.approve.plans_repo.get_plan",
            AsyncMock(return_value=plan),
        ),
        patch(
            "eden.improvement.approve._n22_blocked",
            AsyncMock(return_value="budget exhausted"),
        ),
    ):
        with pytest.raises(ApproveBlocked) as exc:
            await approve_plan("org-1", "plan-1")
    assert "budget" in exc.value.reason
