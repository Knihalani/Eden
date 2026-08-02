"""Wave 26 — DELETE F22 + N20 issue→plan→PR (zero fix chat)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.improvement.approve import ApproveBlockedError, approve_plan
from eden.improvement.issue_patch_trigger import (
    _min_fingerprint_count,
    propose_plan_for_issue,
)
from eden.issues.models import Issue
from eden.providers import PullRequestInfo

_SAMPLE_DIFF = """--- a/foo.py
+++ b/foo.py
@@ -1 +1 @@
-old
+new
"""


def _issue(**kw: Any) -> Issue:
    base: dict[str, Any] = {
        "id": "iss-1",
        "org_id": "org_test",
        "fingerprint": "fp-checkout",
        "kind": "tool_error",
        "title": "checkout loop",
        "status": "triaged",
        "severity": "p1",
        "agent_id": "repo-a",
        "stumble_count": 5,
        "user_count": 2,
        "triage_result": {
            "root_cause": "code_bug",
            "confidence": 0.8,
            "recommended_action": "code_change",
            "candidate_files": ["agent/checkout.py"],
        },
    }
    base.update(kw)
    return Issue(**base)


def test_min_fingerprint_floor_is_at_least_five() -> None:
    assert _min_fingerprint_count() >= 5


@pytest.mark.asyncio
async def test_propose_suppressed_below_fingerprint_threshold() -> None:
    issue = _issue(stumble_count=2)
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
                    "agent_id": "repo-a",
                    "kind": issue.kind,
                    "fingerprint": issue.fingerprint,
                    "triage": issue.triage_result,
                    "rca_summary": "rca",
                }
            ),
        ),
    ):
        result = await propose_plan_for_issue("org_test", "iss-1")
    assert result["status"] == "suppressed"
    assert result["reason"] == "fingerprint_below_threshold"
    assert result["min_required"] >= 5


@pytest.mark.asyncio
async def test_propose_denied_by_n22() -> None:
    issue = _issue(stumble_count=8)
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
                    "agent_id": "repo-a",
                    "kind": issue.kind,
                    "fingerprint": issue.fingerprint,
                    "triage": issue.triage_result,
                    "rca_summary": "rca",
                }
            ),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._n22_may_propose",
            AsyncMock(return_value=(False, "maintenance_mode=observe")),
        ),
    ):
        result = await propose_plan_for_issue("org_test", "iss-1")
    assert result["status"] == "denied"
    assert "observe" in result["reason"]


@pytest.mark.asyncio
async def test_propose_creates_improvement_plan_no_f22() -> None:
    issue = _issue(stumble_count=6)
    plan = {"id": "plan-99", "status": "draft", "diff_unified": _SAMPLE_DIFF}
    generate = AsyncMock(
        return_value={
            "data": {
                "status": "proposed",
                "diff": _SAMPLE_DIFF,
                "description": "Fix checkout",
                "explanation": "loop",
                "cost_usd": 0.12,
                "files": ["agent/checkout.py"],
            }
        }
    )
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
                    "agent_id": "repo-a",
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
            AsyncMock(return_value="repo-conn-1"),
        ),
        patch(
            "eden.improvement.issue_patch_trigger._linked_files",
            AsyncMock(return_value=[{"path": "agent/checkout.py", "content": ""}]),
        ),
        patch(
            "eden.improvement.evidence_plane.build_failure_pack",
            AsyncMock(
                return_value={
                    "status": "ok",
                    "example_trace_ids": [],
                    "excerpt": "",
                    "format": "eden-failure-fixture-v1",
                }
            ),
        ),
        patch(
            "eden.improvement.evidence_plane.run_hermetic_preverify",
            AsyncMock(return_value={"status": "passed", "detail": {}}),
        ),
        patch(
            "eden.patches.patch_generator.PatchGenerator.generate",
            generate,
        ),
        patch(
            "eden.improvement.plans_repo.create_plan",
            AsyncMock(return_value=plan),
        ),
        patch(
            "eden.closed_loop.autonomy_policy.record_spend",
            AsyncMock(return_value=0.12),
        ) as spend,
    ):
        result = await propose_plan_for_issue("org_test", "iss-1")

    assert result["status"] == "proposed"
    assert result["plan_id"] == "plan-99"
    assert "issue_fix" not in str(result).lower()
    spend.assert_awaited()
    generate.assert_awaited_once()
    assert generate.await_args.kwargs["repo_id"] == "repo-conn-1"
    assert generate.await_args.kwargs["repo_id"] != "repo-a"


@pytest.mark.asyncio
async def test_propose_repo_not_connected_when_no_connection() -> None:
    issue = _issue(stumble_count=6)
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
                    "agent_id": "agent-not-a-repo",
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
            AsyncMock(return_value=None),
        ),
    ):
        result = await propose_plan_for_issue("org_test", "iss-1")

    assert result["status"] == "error"
    assert result["reason"] == "repo_not_connected"
    # Copy is not pinned verbatim — the invariant is that the error tells
    # the user, imperatively, to connect a GitHub repo.
    _msg = result.get("message") or ""
    assert "GitHub" in _msg and _msg.lower().startswith("connect"), _msg


@pytest.mark.asyncio
async def test_approve_opens_pr_with_n01_merge_advice() -> None:
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
    mock_repo = MagicMock()
    mock_repo.read_file = AsyncMock(return_value="old\n")
    mock_repo.get_default_branch = AsyncMock(return_value="develop")

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
        ) as queue_verify,
        patch("eden.improvement.approve._audit_approve", AsyncMock()),
        patch("eden.improvement.approve._n06_ledger", AsyncMock()) as n06,
    ):
        result = await approve_plan(
            "org-1", "plan-1", approved_by="user-1", provider=mock_provider
        )

    assert result["status"] == "pr_opened"
    # Phase 8: verify moved to post-merge (GitHub webhook); PR-open no
    # longer schedules it, so the old do-not-merge gate is gone.
    assert result["merge_advice"]["verify_timing"] == "post_merge"
    assert "verify_job_id" not in result
    queue_verify.assert_not_awaited()
    n06.assert_awaited()
    mock_provider.create_pr.assert_awaited_once()
    req = mock_provider.create_pr.await_args.args[0]
    assert req.files[0].content == "new\n"
    assert req.base == "develop"
    assert req.draft is True


@pytest.mark.asyncio
async def test_approve_n22_still_blocks() -> None:
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
        with pytest.raises(ApproveBlockedError):
            await approve_plan("org-1", "plan-1")


def test_f22_modules_deleted() -> None:
    import importlib.util
    from pathlib import Path

    root = Path(__file__).resolve().parents[3] / "src" / "eden"
    assert not (root / "patches" / "issue_fix_chat.py").exists()
    assert not (root / "code_change" / "issue_fix_chat.py").exists()
    assert importlib.util.find_spec("eden.patches.issue_fix_chat") is None
