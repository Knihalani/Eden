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


def _mock_repo_provider(*, default_branch: str = "develop") -> MagicMock:
    repo = MagicMock()
    repo.read_file = AsyncMock(return_value="old\n")
    repo.get_default_branch = AsyncMock(return_value=default_branch)
    return repo


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
        base="develop",
        url="https://github.com/org/repo/pull/42",
        state="open",
        created_at=datetime.now(UTC),
    )
    mock_provider = MagicMock()
    mock_provider.create_pr = AsyncMock(return_value=pr_info)
    mock_repo = _mock_repo_provider(default_branch="develop")

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
            "eden.improvement.approve._resolve_repo_id",
            AsyncMock(return_value="repo-conn-1"),
        ),
        patch(
            "eden.providers.factory.get_repo_provider_for_org",
            AsyncMock(return_value=mock_repo),
        ),
        patch(
            "eden.providers.factory.active_repo_connection",
            AsyncMock(return_value={"default_branch": "develop"}),
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
    req = mock_provider.create_pr.await_args.args[0]
    assert req.repo_id == "repo-conn-1"
    assert req.repo_id != plan["agent_id"]
    assert req.base == "develop"
    assert req.draft is True
    assert len(req.files) == 1
    assert req.files[0].path == "foo.py"
    # Committed content must be patched source, not hunk text.
    assert req.files[0].content == "new\n"
    assert "@@" not in req.files[0].content
    assert "-old" not in req.files[0].content
    assert "+new" not in req.files[0].content


@pytest.mark.asyncio
async def test_approve_plan_fail_closed_on_create_pr_failure() -> None:
    plan = {
        "id": "plan-1",
        "status": "draft",
        "plan_kind": "code_patch",
        "title": "Fix foo",
        "diff_unified": _SAMPLE_DIFF,
    }
    failed = PullRequestInfo(
        number=0,
        title="[Eden] Fix foo",
        body="",
        branch="eden/improve-plan-1",
        base="develop",
        url="",
        state="failed",
        created_at=datetime.now(UTC),
    )
    mock_provider = MagicMock()
    mock_provider.create_pr = AsyncMock(return_value=failed)
    mock_repo = _mock_repo_provider()

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
            "eden.improvement.approve._resolve_repo_id",
            AsyncMock(return_value="repo-conn-1"),
        ),
        patch(
            "eden.providers.factory.get_repo_provider_for_org",
            AsyncMock(return_value=mock_repo),
        ),
        patch(
            "eden.providers.factory.active_repo_connection",
            AsyncMock(return_value={"default_branch": "develop"}),
        ),
        patch(
            "eden.improvement.approve.plans_repo.mark_pr_opened",
            AsyncMock(),
        ) as mark,
    ):
        result = await approve_plan(
            "org-1", "plan-1", provider=mock_provider
        )

    assert result["status"] == "error"
    assert result["error"] == "pr_create_failed"
    mark.assert_not_awaited()


@pytest.mark.asyncio
async def test_approve_plan_repo_not_connected_when_no_connection() -> None:
    plan = {
        "id": "plan-1",
        "status": "draft",
        "plan_kind": "code_patch",
        "agent_id": "agent-not-a-repo",
        "title": "Fix foo",
        "diff_unified": _SAMPLE_DIFF,
    }
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
            "eden.improvement.approve._resolve_repo_id",
            AsyncMock(return_value=None),
        ),
    ):
        result = await approve_plan("org-1", "plan-1")

    assert result["status"] == "error"
    assert result["error"] == "repo_not_connected"
    # Copy is not pinned verbatim — the invariant is that the error tells
    # the user, imperatively, to connect a GitHub repo.
    _msg = result.get("message") or ""
    assert "GitHub" in _msg and _msg.lower().startswith("connect"), _msg


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


@pytest.mark.asyncio
async def test_approve_prompt_update_fail_closed_f68() -> None:
    plan = {
        "id": "plan-1",
        "status": "draft",
        "plan_kind": "prompt_update",
        "evidence": {"prompt_version_id": "pv-1"},
    }
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
            "eden.improvement.approve.plans_repo.mark_approved",
            AsyncMock(),
        ) as mark,
    ):
        result = await approve_plan("org-1", "plan-1", approved_by="user-1")

    assert result["status"] == "not_implemented"
    assert result["supported"] is False
    assert result["error"] == "f68_gateway_deploy_not_implemented"
    mark.assert_not_awaited()


@pytest.mark.asyncio
async def test_approve_guardrail_tune_fail_closed_f68() -> None:
    plan = {
        "id": "plan-2",
        "status": "pending_review",
        "plan_kind": "guardrail_tune",
        "evidence": {"guardrail_id": "g-1"},
    }
    with (
        patch(
            "eden.improvement.approve.plans_repo.get_plan",
            AsyncMock(return_value=plan),
        ),
        patch(
            "eden.improvement.approve._n22_blocked",
            AsyncMock(return_value=None),
        ),
    ):
        result = await approve_plan("org-1", "plan-2")

    assert result["status"] == "not_implemented"
    assert result.get("supported") is False


@pytest.mark.asyncio
async def test_approve_nudge_f41_failure_not_fake_approved() -> None:
    plan = {
        "id": "plan-3",
        "status": "draft",
        "plan_kind": "nudge_promote",
        "evidence": {"nudge_id": "n-1"},
    }

    class _BoomGate:
        async def enqueue(self, *a, **k):
            raise RuntimeError("f41 down")

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
            "eden.promotion.evidence_gate.EvidenceGate",
            return_value=_BoomGate(),
        ),
        patch(
            "eden.improvement.approve.plans_repo.mark_approved",
            AsyncMock(),
        ) as mark,
    ):
        result = await approve_plan("org-1", "plan-3")

    assert result["status"] == "error"
    assert result["error"] == "promotion_enqueue_failed"
    mark.assert_not_awaited()


@pytest.mark.asyncio
async def test_queue_verify_returns_schedule_verify_id() -> None:
    from eden.improvement.approve import _queue_verify

    plan = {
        "evidence": {"issue_id": "iss-1"},
        "github_branch": "eden/improve-plan-1",
    }
    with patch(
        "eden.closed_loop.verify.schedule_verify",
        AsyncMock(return_value="verify-real-id"),
    ) as sched:
        job_id = await _queue_verify("org-1", plan, branch="eden/improve-plan-1")

    assert job_id == "verify-real-id"
    sched.assert_awaited_once_with(
        "org-1", "iss-1", ref="eden/improve-plan-1"
    )


@pytest.mark.asyncio
async def test_queue_verify_returns_none_when_schedule_fails() -> None:
    from eden.improvement.approve import _queue_verify

    plan = {"evidence": {"issue_id": "iss-1"}}
    with patch(
        "eden.closed_loop.verify.schedule_verify",
        AsyncMock(return_value=None),
    ):
        assert await _queue_verify("org-1", plan) is None
