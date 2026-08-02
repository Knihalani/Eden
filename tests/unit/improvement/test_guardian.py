"""Soft Autonomy Phase 9: post-PR guardian unit tests.

Pins: no-plan no-op, follow-up dedupe, revert vs follow-up severity
routing, parent_plan_id linkage, and the Slack regression alert. All
DB/policy/Slack calls are faked.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.improvement import guardian
from eden.improvement.guardian import handle_regression

_MERGED_PLAN = {
    "id": "plan-parent-1",
    "org_id": "org-1",
    "status": "merged",
    "title": "Fix checkout loop",
    "agent_id": "agent-1",
    "pr_url": "https://github.com/acme/repo/pull/42",
    "pr_number": 42,
    "github_branch": "eden/improve-plan-1",
    "triage_snapshot": {"confidence": 0.9},
}


class TestHandleRegression:
    @pytest.mark.asyncio
    async def test_no_merged_plan_is_noop(self) -> None:
        with patch.object(
            guardian, "_find_merged_plan_for_issue", AsyncMock(return_value=None)
        ):
            out = await handle_regression("org-1", "iss-1", severity="P1")
        assert out["status"] == "no_plan"

    @pytest.mark.asyncio
    async def test_existing_follow_up_dedupes(self) -> None:
        with (
            patch.object(
                guardian,
                "_find_merged_plan_for_issue",
                AsyncMock(return_value=dict(_MERGED_PLAN)),
            ),
            patch.object(
                guardian, "_existing_follow_up", AsyncMock(return_value=True)
            ),
            patch.object(guardian, "_draft_follow_up", AsyncMock()) as draft,
        ):
            out = await handle_regression("org-1", "iss-1", severity="P0")
        assert out["status"] == "follow_up_exists"
        draft.assert_not_called()

    @pytest.mark.asyncio
    async def test_p0_with_rollback_allowed_drafts_revert(self) -> None:
        drafted: dict = {}

        async def _draft(org_id, parent, *, issue_id, action, verify_detail):
            drafted["action"] = action
            drafted["parent"] = parent
            return {"id": "plan-child-1"}

        with (
            patch.object(
                guardian,
                "_find_merged_plan_for_issue",
                AsyncMock(return_value=dict(_MERGED_PLAN)),
            ),
            patch.object(
                guardian, "_existing_follow_up", AsyncMock(return_value=False)
            ),
            patch.object(
                guardian, "_decide_revert_allowed", AsyncMock(return_value=True)
            ),
            patch.object(guardian, "_draft_follow_up", side_effect=_draft),
            patch(
                "eden.services.slack_notify.notify_regression",
                AsyncMock(return_value={"status": "sent"}),
            ) as slack,
        ):
            out = await handle_regression(
                "org-1", "iss-1", severity="P0", agent_id="agent-1"
            )
        assert out["status"] == "drafted"
        assert out["action"] == "revert"
        assert out["plan_id"] == "plan-parent-1"
        assert out["follow_up_plan_id"] == "plan-child-1"
        assert drafted["action"] == "revert"
        slack.assert_awaited_once()
        assert slack.await_args.kwargs["action"] == "revert"

    @pytest.mark.asyncio
    async def test_p2_drafts_follow_up_not_revert(self) -> None:
        async def _draft(org_id, parent, *, issue_id, action, verify_detail):
            return {"id": "plan-child-2", "action": action}

        with (
            patch.object(
                guardian,
                "_find_merged_plan_for_issue",
                AsyncMock(return_value=dict(_MERGED_PLAN)),
            ),
            patch.object(
                guardian, "_existing_follow_up", AsyncMock(return_value=False)
            ),
            patch.object(
                guardian, "_decide_revert_allowed", AsyncMock(return_value=True)
            ),
            patch.object(guardian, "_draft_follow_up", side_effect=_draft),
            patch(
                "eden.services.slack_notify.notify_regression",
                AsyncMock(return_value={"status": "sent"}),
            ),
        ):
            out = await handle_regression("org-1", "iss-1", severity="P2")
        assert out["action"] == "follow_up"

    @pytest.mark.asyncio
    async def test_p0_without_rollback_permission_falls_back_to_follow_up(self) -> None:
        async def _draft(org_id, parent, *, issue_id, action, verify_detail):
            return {"id": "plan-child-3"}

        with (
            patch.object(
                guardian,
                "_find_merged_plan_for_issue",
                AsyncMock(return_value=dict(_MERGED_PLAN)),
            ),
            patch.object(
                guardian, "_existing_follow_up", AsyncMock(return_value=False)
            ),
            patch.object(
                guardian, "_decide_revert_allowed", AsyncMock(return_value=False)
            ),
            patch.object(guardian, "_draft_follow_up", side_effect=_draft),
            patch(
                "eden.services.slack_notify.notify_regression",
                AsyncMock(return_value={"status": "sent"}),
            ),
        ):
            out = await handle_regression("org-1", "iss-1", severity="P0")
        assert out["action"] == "follow_up"

    @pytest.mark.asyncio
    async def test_slack_failure_does_not_break_draft(self) -> None:
        async def _draft(org_id, parent, *, issue_id, action, verify_detail):
            return {"id": "plan-child-4"}

        with (
            patch.object(
                guardian,
                "_find_merged_plan_for_issue",
                AsyncMock(return_value=dict(_MERGED_PLAN)),
            ),
            patch.object(
                guardian, "_existing_follow_up", AsyncMock(return_value=False)
            ),
            patch.object(
                guardian, "_decide_revert_allowed", AsyncMock(return_value=True)
            ),
            patch.object(guardian, "_draft_follow_up", side_effect=_draft),
            patch(
                "eden.services.slack_notify.notify_regression",
                AsyncMock(side_effect=RuntimeError("slack down")),
            ),
        ):
            out = await handle_regression("org-1", "iss-1", severity="P0")
        assert out["status"] == "drafted"


class TestDraftFollowUp:
    @pytest.mark.asyncio
    async def test_revert_plan_carries_parent_pr_coordinates(self) -> None:
        captured: dict = {}

        async def _create(org_id, **kwargs):
            captured.update(kwargs)
            return {"id": "plan-child-9"}

        with patch(
            "eden.improvement.plans_repo.create_plan", side_effect=_create
        ):
            out = await guardian._draft_follow_up(
                "org-1",
                dict(_MERGED_PLAN),
                issue_id="iss-1",
                action="revert",
                verify_detail={"window": "15m"},
            )
        assert out == {"id": "plan-child-9"}
        assert captured["parent_plan_id"] == "plan-parent-1"
        assert captured["source_fingerprint"] == "guardian:plan-parent-1:revert"
        ev = captured["evidence"]
        assert ev["guardian_action"] == "revert"
        assert ev["parent_pr_number"] == 42
        assert ev["parent_pr_url"] == "https://github.com/acme/repo/pull/42"
        assert "Revert:" in captured["title"]

    @pytest.mark.asyncio
    async def test_follow_up_plan_repoints_at_issue(self) -> None:
        captured: dict = {}

        async def _create(org_id, **kwargs):
            captured.update(kwargs)
            return {"id": "plan-child-10"}

        with patch(
            "eden.improvement.plans_repo.create_plan", side_effect=_create
        ):
            await guardian._draft_follow_up(
                "org-1",
                dict(_MERGED_PLAN),
                issue_id="iss-1",
                action="follow_up",
                verify_detail=None,
            )
        assert captured["source_ref"] == "issue:iss-1"
        assert captured["evidence"]["issue_id"] == "iss-1"
        assert "Follow-up fix:" in captured["title"]


class TestDecideRevertAllowed:
    @pytest.mark.asyncio
    async def test_policy_allow_and_require_approval_permit(self) -> None:
        for verdict in ("allow", "require_approval"):
            with (
                patch(
                    "eden.closed_loop.autonomy_policy.resolve", AsyncMock()
                ),
                patch(
                    "eden.closed_loop.autonomy_policy.decide",
                    return_value=(verdict, "ok", "rollback"),
                ),
            ):
                assert await guardian._decide_revert_allowed("org-1", None) is True

    @pytest.mark.asyncio
    async def test_policy_deny_blocks(self) -> None:
        with (
            patch("eden.closed_loop.autonomy_policy.resolve", AsyncMock()),
            patch(
                "eden.closed_loop.autonomy_policy.decide",
                return_value=("deny", "observe mode", "rollback"),
            ),
        ):
            assert await guardian._decide_revert_allowed("org-1", None) is False

    @pytest.mark.asyncio
    async def test_policy_error_fails_closed(self) -> None:
        with patch(
            "eden.closed_loop.autonomy_policy.resolve",
            AsyncMock(side_effect=RuntimeError("db down")),
        ):
            assert await guardian._decide_revert_allowed("org-1", None) is False
