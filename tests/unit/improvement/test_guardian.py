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
from eden.patches.diff_materializer import invert_unified_diff

#: The parent's merged diff: buggy → fixed checkout.
_PARENT_DIFF = (
    "--- a/app/checkout.py\n"
    "+++ b/app/checkout.py\n"
    "@@ -1,2 +1,2 @@\n"
    " def checkout(total):\n"
    "-    return total / 0\n"
    "+    return total\n"
)
#: What HEAD looks like after the parent merged (the fixed content).
_HEAD_FIXED = "def checkout(total):\n    return total\n"
_FOLLOW_UP_DIFF = (
    "--- a/app/checkout.py\n"
    "+++ b/app/checkout.py\n"
    "@@ -1,2 +1,3 @@\n"
    " def checkout(total):\n"
    "+    assert total >= 0\n"
    "     return total\n"
)

_MERGED_PLAN = {
    "id": "plan-parent-1",
    "org_id": "org-1",
    "status": "merged",
    "title": "Fix checkout loop",
    "agent_id": "agent-1",
    "pr_url": "https://github.com/acme/repo/pull/42",
    "pr_number": 42,
    "github_branch": "eden/improve-plan-1",
    "diff_unified": _PARENT_DIFF,
    "files_changed": ["app/checkout.py"],
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

        async def _draft(org_id, parent, *, issue_id, verify_detail):
            drafted["parent"] = parent
            return {"id": "plan-child-1"}, None

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
            patch.object(guardian, "_draft_revert", side_effect=_draft),
            patch.object(guardian, "_draft_follow_up", AsyncMock()) as follow,
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
        assert drafted["parent"]["id"] == "plan-parent-1"
        follow.assert_not_called()
        slack.assert_awaited_once()
        assert slack.await_args.kwargs["action"] == "revert"

    @pytest.mark.asyncio
    async def test_revert_conflict_falls_back_to_follow_up(self) -> None:
        """Drifted base → revert returns (None, reason) → follow-up is
        drafted with the conflict handed through for its evidence."""
        captured: dict = {}

        async def _follow(
            org_id, parent, *, issue_id, verify_detail, revert_conflict=None
        ):
            captured["revert_conflict"] = revert_conflict
            return {"id": "plan-child-8"}

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
            patch.object(
                guardian,
                "_draft_revert",
                AsyncMock(return_value=(None, "revert_apply_conflict:drift")),
            ),
            patch.object(guardian, "_draft_follow_up", side_effect=_follow),
            patch(
                "eden.services.slack_notify.notify_regression",
                AsyncMock(return_value={"status": "sent"}),
            ),
        ):
            out = await handle_regression("org-1", "iss-1", severity="P0")
        assert out["action"] == "follow_up"
        assert out["follow_up_plan_id"] == "plan-child-8"
        assert captured["revert_conflict"] == "revert_apply_conflict:drift"

    @pytest.mark.asyncio
    async def test_p2_drafts_follow_up_not_revert(self) -> None:
        async def _draft(
            org_id, parent, *, issue_id, verify_detail, revert_conflict=None
        ):
            return {"id": "plan-child-2"}

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
            patch.object(guardian, "_draft_revert", AsyncMock()) as revert,
            patch.object(guardian, "_draft_follow_up", side_effect=_draft),
            patch(
                "eden.services.slack_notify.notify_regression",
                AsyncMock(return_value={"status": "sent"}),
            ),
        ):
            out = await handle_regression("org-1", "iss-1", severity="P2")
        assert out["action"] == "follow_up"
        revert.assert_not_called()

    @pytest.mark.asyncio
    async def test_p0_without_rollback_permission_falls_back_to_follow_up(self) -> None:
        async def _draft(
            org_id, parent, *, issue_id, verify_detail, revert_conflict=None
        ):
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
            patch.object(guardian, "_draft_revert", AsyncMock()) as revert,
            patch.object(guardian, "_draft_follow_up", side_effect=_draft),
            patch(
                "eden.services.slack_notify.notify_regression",
                AsyncMock(return_value={"status": "sent"}),
            ),
        ):
            out = await handle_regression("org-1", "iss-1", severity="P0")
        assert out["action"] == "follow_up"
        revert.assert_not_called()

    @pytest.mark.asyncio
    async def test_slack_failure_does_not_break_draft(self) -> None:
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
            patch.object(
                guardian,
                "_draft_revert",
                AsyncMock(return_value=({"id": "plan-child-4"}, None)),
            ),
            patch(
                "eden.services.slack_notify.notify_regression",
                AsyncMock(side_effect=RuntimeError("slack down")),
            ),
        ):
            out = await handle_regression("org-1", "iss-1", severity="P0")
        assert out["status"] == "drafted"


class TestDraftRevert:
    """M5 (D9): the revert draft carries the parent diff inverted,
    applied + statically checked against current HEAD."""

    @pytest.mark.asyncio
    async def test_clean_revert_creates_code_patch_with_inverted_diff(
        self,
    ) -> None:
        captured: dict = {}

        async def _create(org_id, **kwargs):
            captured.update(kwargs)
            return {"id": "plan-child-9", **kwargs}

        with (
            patch.object(
                guardian,
                "_hydrate_head_files",
                AsyncMock(
                    return_value=[{"path": "app/checkout.py", "content": _HEAD_FIXED}]
                ),
            ),
            patch("eden.improvement.plans_repo.create_plan", side_effect=_create),
        ):
            plan, reason = await guardian._draft_revert(
                "org-1",
                dict(_MERGED_PLAN),
                issue_id="iss-1",
                verify_detail={"window": "15m"},
            )
        assert reason is None
        assert plan is not None
        assert captured["plan_kind"] == "code_patch"
        assert captured["diff_unified"] == invert_unified_diff(_PARENT_DIFF)
        assert captured["diff_unified"].strip()
        assert captured["files_changed"] == ["app/checkout.py"]
        assert captured["parent_plan_id"] == "plan-parent-1"
        assert captured["source_fingerprint"] == "guardian:plan-parent-1:revert"
        assert "Revert:" in captured["title"]
        ev = captured["evidence"]
        assert ev["guardian"] == "revert"
        assert ev["guardian_action"] == "revert"
        assert ev["revert_strategy"] == "inverse_diff"
        assert ev["verify_detail"] == {"window": "15m"}
        assert ev["parent_pr_number"] == 42
        assert ev["parent_pr_url"] == "https://github.com/acme/repo/pull/42"
        # Statically checked before drafting.
        assert ev["static_check"].get("status") == "passed"

    @pytest.mark.asyncio
    async def test_drifted_base_returns_conflict(self) -> None:
        """HEAD no longer matches the merged diff → no revert plan."""
        with (
            patch.object(
                guardian,
                "_hydrate_head_files",
                AsyncMock(
                    return_value=[
                        {
                            "path": "app/checkout.py",
                            "content": "def checkout(total):\n    return total * 2\n",
                        }
                    ]
                ),
            ),
            patch(
                "eden.improvement.plans_repo.create_plan", AsyncMock()
            ) as create,
        ):
            plan, reason = await guardian._draft_revert(
                "org-1",
                dict(_MERGED_PLAN),
                issue_id="iss-1",
                verify_detail=None,
            )
        assert plan is None
        assert reason is not None and reason.startswith("revert_apply_conflict:")
        create.assert_not_called()

    @pytest.mark.asyncio
    async def test_static_failure_returns_reason(self) -> None:
        """Inverting a syntax-fix reintroduces the syntax error → the
        static check fails and the revert is refused."""
        parent = dict(_MERGED_PLAN)
        parent["diff_unified"] = (
            "--- a/app/bad.py\n"
            "+++ b/app/bad.py\n"
            "@@ -1,2 +1,2 @@\n"
            "-def broken(:\n"
            "+def broken():\n"
            "     return 1\n"
        )
        with (
            patch.object(
                guardian,
                "_hydrate_head_files",
                AsyncMock(
                    return_value=[
                        {
                            "path": "app/bad.py",
                            "content": "def broken():\n    return 1\n",
                        }
                    ]
                ),
            ),
            patch(
                "eden.improvement.plans_repo.create_plan", AsyncMock()
            ) as create,
        ):
            plan, reason = await guardian._draft_revert(
                "org-1", parent, issue_id="iss-1", verify_detail=None
            )
        assert plan is None
        assert reason is not None and reason.startswith("revert_static_failed:")
        create.assert_not_called()

    @pytest.mark.asyncio
    async def test_missing_parent_diff_returns_reason(self) -> None:
        parent = dict(_MERGED_PLAN)
        parent["diff_unified"] = ""
        plan, reason = await guardian._draft_revert(
            "org-1", parent, issue_id="iss-1", verify_detail=None
        )
        assert plan is None
        assert reason == "parent_diff_missing"


class TestDraftFollowUp:
    @pytest.mark.asyncio
    async def test_follow_up_success_carries_real_diff(self) -> None:
        captured: dict = {}
        gen_kwargs: dict = {}

        async def _create(org_id, **kwargs):
            captured.update(kwargs)
            return {"id": "plan-child-10", **kwargs}

        async def _generate(self, **kwargs):
            gen_kwargs.update(kwargs)
            return {
                "status": "ok",
                "data": {
                    "status": "proposed",
                    "diff": _FOLLOW_UP_DIFF,
                    "files": ["app/checkout.py"],
                    "patch_id": "patch-77",
                    "cost_usd": 0.02,
                    "critic_verdict": {"passed": True},
                },
            }

        with (
            patch.object(guardian, "_hydrate_head_files", AsyncMock(return_value=[])),
            patch(
                "eden.patches.patch_generator.PatchGenerator.generate", _generate
            ),
            patch("eden.improvement.plans_repo.create_plan", side_effect=_create),
        ):
            out = await guardian._draft_follow_up(
                "org-1",
                dict(_MERGED_PLAN),
                issue_id="iss-1",
                verify_detail={"reason": "new stumbles within quiet window"},
            )
        assert out is not None
        assert captured["plan_kind"] == "code_patch"
        assert captured["diff_unified"] == _FOLLOW_UP_DIFF
        assert captured["source_ref"] == "issue:iss-1"
        assert captured["source_fingerprint"] == "guardian:plan-parent-1:follow_up"
        assert captured["evidence"]["issue_id"] == "iss-1"
        assert captured["evidence"]["guardian_action"] == "follow_up"
        assert captured["evidence"]["patch_id"] == "patch-77"
        assert "Follow-up fix:" in captured["title"]
        # Generation ran unpersisted with the regression context.
        assert gen_kwargs["persist"] is False
        assert "new stumbles within quiet window" in gen_kwargs["static_feedback"]
        assert "return total / 0" in gen_kwargs["static_feedback"]

    @pytest.mark.asyncio
    async def test_suppressed_generation_degrades_to_advisory(self) -> None:
        captured: dict = {}

        async def _create(org_id, **kwargs):
            captured.update(kwargs)
            return {"id": "plan-child-11", **kwargs}

        with (
            patch.object(guardian, "_hydrate_head_files", AsyncMock(return_value=[])),
            patch(
                "eden.patches.patch_generator.PatchGenerator.generate",
                AsyncMock(
                    return_value={
                        "status": "ok",
                        "data": {"status": "low_quality", "diff": "x"},
                    }
                ),
            ),
            patch("eden.improvement.plans_repo.create_plan", side_effect=_create),
        ):
            out = await guardian._draft_follow_up(
                "org-1", dict(_MERGED_PLAN), issue_id="iss-1", verify_detail=None
            )
        assert out is not None
        assert captured["plan_kind"] == "advisory"
        assert captured["diff_unified"] is None
        assert captured["summary"] == "needs manual fix: low_quality"
        assert captured["evidence"]["generation_failure"] == "low_quality"

    @pytest.mark.asyncio
    async def test_empty_generated_diff_never_becomes_code_patch(self) -> None:
        captured: dict = {}

        async def _create(org_id, **kwargs):
            captured.update(kwargs)
            return {"id": "plan-child-12", **kwargs}

        with (
            patch.object(guardian, "_hydrate_head_files", AsyncMock(return_value=[])),
            patch(
                "eden.patches.patch_generator.PatchGenerator.generate",
                AsyncMock(
                    return_value={
                        "status": "ok",
                        "data": {"status": "proposed", "diff": "   "},
                    }
                ),
            ),
            patch("eden.improvement.plans_repo.create_plan", side_effect=_create),
        ):
            await guardian._draft_follow_up(
                "org-1", dict(_MERGED_PLAN), issue_id="iss-1", verify_detail=None
            )
        assert captured["plan_kind"] == "advisory"
        assert captured["diff_unified"] is None
        assert "needs manual fix" in captured["summary"]

    @pytest.mark.asyncio
    async def test_generation_exception_degrades_to_advisory(self) -> None:
        captured: dict = {}

        async def _create(org_id, **kwargs):
            captured.update(kwargs)
            return {"id": "plan-child-13", **kwargs}

        with (
            patch.object(guardian, "_hydrate_head_files", AsyncMock(return_value=[])),
            patch(
                "eden.patches.patch_generator.PatchGenerator.generate",
                AsyncMock(side_effect=RuntimeError("router down")),
            ),
            patch("eden.improvement.plans_repo.create_plan", side_effect=_create),
        ):
            await guardian._draft_follow_up(
                "org-1", dict(_MERGED_PLAN), issue_id="iss-1", verify_detail=None
            )
        assert captured["plan_kind"] == "advisory"
        assert captured["summary"].startswith("needs manual fix: generation_error")

    @pytest.mark.asyncio
    async def test_revert_conflict_noted_with_pr_fallback(self) -> None:
        """A failed inverse-diff revert is recorded on the follow-up,
        including the manual PRProvider.revert fallback (auto-revert
        is M15 — nothing executes here)."""
        captured: dict = {}

        async def _create(org_id, **kwargs):
            captured.update(kwargs)
            return {"id": "plan-child-14", **kwargs}

        with (
            patch.object(guardian, "_hydrate_head_files", AsyncMock(return_value=[])),
            patch(
                "eden.patches.patch_generator.PatchGenerator.generate",
                AsyncMock(
                    return_value={
                        "status": "ok",
                        "data": {"status": "proposed", "diff": _FOLLOW_UP_DIFF},
                    }
                ),
            ),
            patch("eden.improvement.plans_repo.create_plan", side_effect=_create),
        ):
            await guardian._draft_follow_up(
                "org-1",
                dict(_MERGED_PLAN),
                issue_id="iss-1",
                verify_detail=None,
                revert_conflict="revert_apply_conflict:diff_apply_failed",
            )
        ev = captured["evidence"]
        assert ev["revert_conflict"] == "revert_apply_conflict:diff_apply_failed"
        assert ev["revert_fallback"] == "pr_provider_revert:revert_pr"


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
