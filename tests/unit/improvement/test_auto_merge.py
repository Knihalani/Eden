"""M15 (§9) auto-merge ladder unit tests."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.closed_loop.autonomy_policy import AutonomousMaintenancePolicy
from eden.improvement.auto_merge import (
    AutoMergeDecision,
    evaluate_auto_merge_eligibility,
    parent_is_canary_auto_merged,
)
from eden.providers import PullRequestInfo


_SMALL_DIFF = """--- a/foo.py
+++ b/foo.py
@@ -1 +1 @@
-old
+new
"""


def _policy(**kwargs: Any) -> AutonomousMaintenancePolicy:
    base = dict(
        org_id="org-1",
        auto_code_patch_merge=True,
        compliance_profile="standard",
        auto_merge_max_per_week=2,
    )
    base.update(kwargs)
    return AutonomousMaintenancePolicy(**base)  # type: ignore[arg-type]


def _plan(**kwargs: Any) -> dict[str, Any]:
    plan: dict[str, Any] = {
        "id": "plan-1",
        "agent_id": "agent-1",
        "diff_unified": _SMALL_DIFF,
        "files_changed": ["foo.py"],
        "evidence": {"evidence_tier": "replay", "issue_id": "iss-1"},
    }
    plan.update(kwargs)
    return plan


def _provider(*, allows_merge: bool = True, reason: str = "unprotected") -> MagicMock:
    p = MagicMock()
    p.branch_allows_app_merge = AsyncMock(return_value=(allows_merge, reason))
    p.merge_pr = AsyncMock(
        return_value=PullRequestInfo(
            number=7,
            title="t",
            body="",
            branch="eden/improve-plan-1",
            base="main",
            url="https://github.com/o/r/pull/7",
            state="merged",
            created_at=datetime.now(UTC),
        )
    )
    return p


async def _pass_through_eligibility_deps(
    *,
    policy: AutonomousMaintenancePolicy | None = None,
    weekly_used: int = 0,
    kg_reverted: int = 0,
    feature_ok: bool = True,
):
    """Context manager stack for a green eligibility path."""
    pol = policy or _policy()

    async def _kg_history(org_id, repo_id, path):
        return {
            "status": "ok",
            "data": {
                "reverted_count": kg_reverted,
                "code_path": path,
                "found": kg_reverted > 0,
            },
        }

    return (
        patch(
            "eden.closed_loop.autonomy_policy.resolve",
            AsyncMock(return_value=pol),
        ),
        patch(
            "eden.improvement.auto_merge._feature_kill_allows",
            AsyncMock(return_value=feature_ok),
        ),
        patch(
            "eden.improvement.auto_merge.count_auto_merges_this_week",
            AsyncMock(return_value=weekly_used),
        ),
        patch(
            "eden.patches.knowledge_graph.CodebaseKnowledgeGraph.same_file_history",
            new=AsyncMock(side_effect=_kg_history),
        ),
        patch(
            "eden.improvement.auto_merge._soft_cap",
            return_value=200,
        ),
    )


# ── Eligibility matrix ───────────────────────────────────────────────


class TestEligibilityMatrix:
    @pytest.mark.asyncio
    async def test_all_gates_pass(self) -> None:
        patches = await _pass_through_eligibility_deps()
        provider = _provider()
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            d = await evaluate_auto_merge_eligibility(
                "org-1", _plan(), provider=provider, base="main", repo_id="r1"
            )
        assert d.eligible is True
        assert d.blocked_by is None
        assert any(r.startswith("evidence_tier:replay") for r in d.reasons)

    @pytest.mark.asyncio
    async def test_fail_evidence_tier_static(self) -> None:
        patches = await _pass_through_eligibility_deps()
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            d = await evaluate_auto_merge_eligibility(
                "org-1",
                _plan(evidence={"evidence_tier": "static"}),
                provider=_provider(),
                base="main",
                skip_branch_protection=True,
            )
        assert d.eligible is False
        assert d.blocked_by == "evidence_tier"

    @pytest.mark.asyncio
    async def test_pass_evidence_tier_tested(self) -> None:
        patches = await _pass_through_eligibility_deps()
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            d = await evaluate_auto_merge_eligibility(
                "org-1",
                _plan(evidence={"evidence_tier": "tested"}),
                provider=_provider(),
                base="main",
                skip_branch_protection=True,
            )
        assert d.eligible is True

    @pytest.mark.asyncio
    async def test_fail_soft_cap(self) -> None:
        # Build a diff with >200 changed lines.
        lines = ["--- a/big.py\n+++ b/big.py\n@@ -1 +1 @@\n"]
        for i in range(201):
            lines.append(f"+line{i}\n")
        big = "".join(lines)
        patches = await _pass_through_eligibility_deps()
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            d = await evaluate_auto_merge_eligibility(
                "org-1",
                _plan(diff_unified=big, files_changed=["big.py"]),
                provider=_provider(),
                base="main",
                skip_branch_protection=True,
            )
        assert d.eligible is False
        assert d.blocked_by == "soft_cap"

    @pytest.mark.asyncio
    async def test_fail_kg_revert_history(self) -> None:
        patches = await _pass_through_eligibility_deps(kg_reverted=2)
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            d = await evaluate_auto_merge_eligibility(
                "org-1",
                _plan(),
                provider=_provider(),
                base="main",
                skip_branch_protection=True,
            )
        assert d.eligible is False
        assert d.blocked_by == "kg_revert_history"

    @pytest.mark.asyncio
    async def test_fail_n22_t4_opt_in(self) -> None:
        patches = await _pass_through_eligibility_deps(
            policy=_policy(auto_code_patch_merge=False)
        )
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            d = await evaluate_auto_merge_eligibility(
                "org-1",
                _plan(),
                skip_branch_protection=True,
            )
        assert d.eligible is False
        assert d.blocked_by == "n22_t4"

    @pytest.mark.asyncio
    async def test_fail_compliance_hipaa(self) -> None:
        patches = await _pass_through_eligibility_deps(
            policy=_policy(compliance_profile="hipaa")
        )
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            d = await evaluate_auto_merge_eligibility(
                "org-1", _plan(), skip_branch_protection=True
            )
        assert d.eligible is False
        assert d.blocked_by == "compliance"

    @pytest.mark.asyncio
    async def test_fail_compliance_soc2_strict(self) -> None:
        patches = await _pass_through_eligibility_deps(
            policy=_policy(compliance_profile="soc2_strict")
        )
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            d = await evaluate_auto_merge_eligibility(
                "org-1", _plan(), skip_branch_protection=True
            )
        assert d.eligible is False
        assert d.blocked_by == "compliance"

    @pytest.mark.asyncio
    async def test_fail_feature_kill(self) -> None:
        patches = await _pass_through_eligibility_deps(feature_ok=False)
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            d = await evaluate_auto_merge_eligibility(
                "org-1", _plan(), skip_branch_protection=True
            )
        assert d.eligible is False
        assert d.blocked_by == "feature_kill"

    @pytest.mark.asyncio
    async def test_force_canary_revert_bypasses_gates(self) -> None:
        # Even with T4 off / kill on, force path is eligible.
        d = await evaluate_auto_merge_eligibility(
            "org-1",
            _plan(
                evidence={
                    "auto_merge": {"force_canary_revert": True},
                }
            ),
        )
        assert d.eligible is True
        assert d.reasons == ["canary_auto_revert"]


# ── Weekly cap ───────────────────────────────────────────────────────


class TestWeeklyCap:
    @pytest.mark.asyncio
    async def test_weekly_cap_blocks(self) -> None:
        patches = await _pass_through_eligibility_deps(weekly_used=2)
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            d = await evaluate_auto_merge_eligibility(
                "org-1", _plan(), skip_branch_protection=True
            )
        assert d.eligible is False
        assert d.blocked_by == "weekly_cap"

    @pytest.mark.asyncio
    async def test_weekly_cap_org_override(self) -> None:
        patches = await _pass_through_eligibility_deps(
            policy=_policy(auto_merge_max_per_week=5),
            weekly_used=2,
        )
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            d = await evaluate_auto_merge_eligibility(
                "org-1", _plan(), skip_branch_protection=True
            )
        assert d.eligible is True
        assert d.details.get("weekly_cap") == 5

    @pytest.mark.asyncio
    async def test_claim_slot_serializes_cap(self) -> None:
        """Second claim while first holds slot_claimed must fail at cap=1."""
        from eden.improvement.auto_merge import claim_auto_merge_slot

        plan_a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        plan_b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
        claimed: set[str] = set()

        class _Conn:
            async def execute(self, query: str, *args: Any) -> str:
                if "pg_advisory_xact_lock" in query:
                    return "SELECT 1"
                if "UPDATE improvement_plans" in query:
                    claimed.add(str(args[0]))
                    return "UPDATE 1"
                return "OK"

            async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
                if "COUNT(*)" in query:
                    return {"n": len(claimed)}
                # self_row for this plan_id
                pid = str(args[0])
                return {
                    "claimed": pid in claimed,
                    "merged": False,
                }

        class _Txn:
            async def __aenter__(self) -> _Conn:
                return _Conn()

            async def __aexit__(self, *args: Any) -> None:
                return None

        client = MagicMock()
        client.transaction = MagicMock(return_value=_Txn())

        with (
            patch(
                "eden.improvement.auto_merge.weekly_cap_for_org",
                AsyncMock(return_value=1),
            ),
            patch(
                "eden.storage.postgres.get_postgres_client",
                AsyncMock(return_value=client),
            ),
        ):
            ok1, d1 = await claim_auto_merge_slot("org-1", plan_a, cap=1)
            ok2, d2 = await claim_auto_merge_slot("org-1", plan_b, cap=1)

        assert ok1 is True
        assert ok2 is False
        assert "weekly_cap" in str(d2.get("reason", ""))
        assert plan_a in claimed
        assert plan_b not in claimed


# ── Branch protection fallback ───────────────────────────────────────


class TestBranchProtection:
    @pytest.mark.asyncio
    async def test_branch_protection_blocks(self) -> None:
        patches = await _pass_through_eligibility_deps()
        provider = _provider(allows_merge=False, reason="branch_protection:required_reviews")
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            d = await evaluate_auto_merge_eligibility(
                "org-1",
                _plan(),
                provider=provider,
                base="main",
            )
        assert d.eligible is False
        assert d.blocked_by == "branch_protection"
        assert any("auto_merge_blocked:branch_protection" in r for r in d.reasons)

    @pytest.mark.asyncio
    async def test_approve_falls_back_to_draft_on_bp_block(self) -> None:
        from eden.improvement.approve import approve_plan

        plan = {
            "id": "plan-1",
            "status": "draft",
            "plan_kind": "code_patch",
            "agent_id": "repo-a",
            "title": "Fix foo",
            "summary": "summary",
            "diff_unified": _SMALL_DIFF,
            "files_changed": ["foo.py"],
            "evidence": {"evidence_tier": "replay", "issue_id": "iss-1"},
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
        mock_provider.branch_allows_app_merge = AsyncMock(
            return_value=(False, "branch_protection:required_reviews")
        )
        mock_repo = MagicMock()
        mock_repo.read_file = AsyncMock(return_value="old\n")
        mock_repo.get_default_branch = AsyncMock(return_value="main")

        decision = AutoMergeDecision(
            eligible=False,
            reasons=["auto_merge_blocked:branch_protection"],
            blocked_by="branch_protection",
        )

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
                AsyncMock(return_value={"default_branch": "main"}),
            ),
            patch(
                "eden.improvement.auto_merge.evaluate_auto_merge_eligibility",
                AsyncMock(return_value=decision),
            ),
            patch(
                "eden.improvement.approve._merge_plan_evidence",
                AsyncMock(return_value={**plan, "evidence": {"auto_merge": decision.to_evidence()}}),
            ),
            patch(
                "eden.improvement.approve.plans_repo.mark_pr_opened",
                AsyncMock(return_value={**plan, "status": "pr_opened"}),
            ),
            patch(
                "eden.improvement.approve._stamp_ci_ingestion_availability",
                AsyncMock(side_effect=lambda o, p, u: u),
            ),
            patch("eden.improvement.approve._audit_approve", AsyncMock()),
            patch("eden.improvement.approve._n06_ledger", AsyncMock()),
        ):
            result = await approve_plan(
                "org-1", "plan-1", approved_by="user-1", provider=mock_provider
            )

        assert result["status"] == "pr_opened"
        assert result["auto_merged"] is False
        req = mock_provider.create_pr.await_args.args[0]
        assert req.draft is True
        mock_provider.merge_pr.assert_not_called()


# ── Approve canary merge path ────────────────────────────────────────


class TestApproveCanaryMerge:
    @pytest.mark.asyncio
    async def test_eligible_opens_non_draft_and_merges(self) -> None:
        from eden.improvement.approve import approve_plan

        plan = {
            "id": "plan-1",
            "status": "draft",
            "plan_kind": "code_patch",
            "agent_id": "repo-a",
            "title": "Fix foo",
            "summary": "summary",
            "diff_unified": _SMALL_DIFF,
            "files_changed": ["foo.py"],
            "evidence": {"evidence_tier": "tested", "issue_id": "iss-1"},
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
        mock_provider.merge_pr = AsyncMock(
            return_value=PullRequestInfo(
                number=42,
                title="[Eden] Fix foo",
                body="summary",
                branch="eden/improve-plan-1",
                base="main",
                url="https://github.com/org/repo/pull/42",
                state="merged",
                created_at=datetime.now(UTC),
            )
        )
        mock_repo = MagicMock()
        mock_repo.read_file = AsyncMock(return_value="old\n")
        mock_repo.get_default_branch = AsyncMock(return_value="main")

        decision = AutoMergeDecision(
            eligible=True,
            reasons=["evidence_tier:tested"],
        )

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
                AsyncMock(return_value={"default_branch": "main"}),
            ),
            patch(
                "eden.improvement.auto_merge.evaluate_auto_merge_eligibility",
                AsyncMock(return_value=decision),
            ),
            patch(
                "eden.improvement.auto_merge.claim_auto_merge_slot",
                AsyncMock(return_value=(True, {"weekly_used": 0, "weekly_cap": 2})),
            ),
            patch(
                "eden.improvement.approve._merge_plan_evidence",
                AsyncMock(return_value=plan),
            ),
            patch(
                "eden.improvement.approve.plans_repo.mark_pr_opened",
                AsyncMock(return_value={**plan, "status": "pr_opened"}),
            ),
            patch(
                "eden.improvement.approve.plans_repo.mark_merged",
                AsyncMock(return_value={**plan, "status": "merged"}),
            ),
            patch(
                "eden.improvement.approve._queue_verify",
                AsyncMock(return_value="verify-am-1"),
            ) as queue_verify,
            patch(
                "eden.improvement.approve._stamp_ci_ingestion_availability",
                AsyncMock(side_effect=lambda o, p, u: u),
            ),
            patch("eden.improvement.approve._audit_approve", AsyncMock()),
            patch("eden.improvement.approve._n06_ledger", AsyncMock()),
        ):
            result = await approve_plan(
                "org-1", "plan-1", approved_by="user-1", provider=mock_provider
            )

        assert result["status"] == "merged"
        assert result["auto_merged"] is True
        req = mock_provider.create_pr.await_args.args[0]
        assert req.draft is False
        mock_provider.merge_pr.assert_awaited_once()
        queue_verify.assert_awaited_once()
        assert queue_verify.await_args.kwargs.get("auto_merge_canary") is True


# ── Guardian auto-revert ─────────────────────────────────────────────


class TestGuardianAutoRevert:
    @pytest.mark.asyncio
    async def test_canary_parent_auto_executes_revert(self) -> None:
        from eden.improvement import guardian

        parent = {
            "id": "plan-parent",
            "title": "Fix foo",
            "status": "merged",
            "agent_id": "agent-1",
            "pr_number": 99,
            "pr_url": "https://github.com/o/r/pull/99",
            "diff_unified": _SMALL_DIFF,
            "evidence": {
                "issue_id": "iss-1",
                "auto_merge": {"merged": True, "canary": True},
            },
        }
        revert_plan = {
            "id": "plan-revert",
            "plan_kind": "code_patch",
            "diff_unified": _SMALL_DIFF,
            "status": "draft",
        }

        with (
            patch.object(
                guardian,
                "_find_merged_plan_for_issue",
                AsyncMock(return_value=parent),
            ),
            patch.object(guardian, "_existing_follow_up", AsyncMock(return_value=False)),
            patch.object(guardian, "_decide_revert_allowed", AsyncMock(return_value=True)),
            patch.object(
                guardian,
                "_draft_revert",
                AsyncMock(return_value=(revert_plan, None)),
            ),
            patch(
                "eden.improvement.auto_merge.auto_revert_permitted",
                AsyncMock(return_value=True),
            ),
            patch(
                "eden.improvement.approve._merge_plan_evidence",
                AsyncMock(return_value=revert_plan),
            ),
            patch(
                "eden.improvement.approve.approve_plan",
                AsyncMock(
                    return_value={
                        "status": "merged",
                        "pr_url": "https://github.com/o/r/pull/100",
                        "pr_number": 100,
                        "auto_merged": True,
                    }
                ),
            ) as approve,
            patch(
                "eden.patches.knowledge_graph.record_plan_outcome",
                AsyncMock(),
            ),
            patch(
                "eden.services.slack_notify.notify_regression",
                AsyncMock(),
            ),
        ):
            result = await guardian.handle_regression(
                "org-1", "iss-1", severity="P0", agent_id="agent-1"
            )

        assert result["status"] == "auto_reverted"
        assert result["action"] == "auto_revert"
        approve.assert_awaited_once()
        assert approve.await_args.args[1] == "plan-revert"

    @pytest.mark.asyncio
    async def test_non_canary_parent_does_not_auto_execute(self) -> None:
        from eden.improvement import guardian

        parent = {
            "id": "plan-parent",
            "title": "Fix foo",
            "status": "merged",
            "agent_id": "agent-1",
            "pr_number": 99,
            "diff_unified": _SMALL_DIFF,
            "evidence": {"issue_id": "iss-1"},  # no auto_merge stamp
        }
        revert_plan = {"id": "plan-revert", "plan_kind": "code_patch"}

        with (
            patch.object(
                guardian,
                "_find_merged_plan_for_issue",
                AsyncMock(return_value=parent),
            ),
            patch.object(guardian, "_existing_follow_up", AsyncMock(return_value=False)),
            patch.object(guardian, "_decide_revert_allowed", AsyncMock(return_value=True)),
            patch.object(
                guardian,
                "_draft_revert",
                AsyncMock(return_value=(revert_plan, None)),
            ),
            patch(
                "eden.improvement.approve.approve_plan",
                AsyncMock(),
            ) as approve,
            patch(
                "eden.patches.knowledge_graph.record_plan_outcome",
                AsyncMock(),
            ),
            patch(
                "eden.services.slack_notify.notify_regression",
                AsyncMock(),
            ),
        ):
            result = await guardian.handle_regression(
                "org-1", "iss-1", severity="P0", agent_id="agent-1"
            )

        assert result["status"] == "drafted"
        assert result["action"] == "revert"
        approve.assert_not_awaited()

    def test_parent_is_canary_helper(self) -> None:
        assert parent_is_canary_auto_merged(
            {"evidence": {"auto_merge": {"merged": True, "canary": True}}}
        )
        assert not parent_is_canary_auto_merged({"evidence": {}})
        assert not parent_is_canary_auto_merged(
            {"evidence": {"auto_merge": {"merged": False}}}
        )
        # Missing canary key must NOT default to True.
        assert not parent_is_canary_auto_merged(
            {"evidence": {"auto_merge": {"merged": True}}}
        )


# ── Decision evidence shape ──────────────────────────────────────────


def test_decision_to_evidence_shape() -> None:
    d = AutoMergeDecision(
        eligible=False,
        reasons=["auto_merge_blocked:branch_protection"],
        blocked_by="branch_protection",
        details={"branch_protection": "required_reviews"},
    )
    ev = d.to_evidence()
    assert ev["eligible"] is False
    assert ev["blocked_by"] == "branch_protection"
    assert "decided_at" in ev
