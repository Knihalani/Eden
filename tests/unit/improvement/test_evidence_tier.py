"""M7 (§4.1) — evidence tiers, replay gating, honest static_passed label."""

from __future__ import annotations

from contextlib import ExitStack
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.improvement.replay_verify import ReplayResult

ORG = "org_test"
ISSUE_ID = "iss-1"


def _issue():
    issue = MagicMock()
    issue.id = ISSUE_ID
    issue.title = "Checkout fails"
    issue.kind = "code_bug"
    issue.fingerprint = "fp1"
    issue.severity = "high"
    issue.stumble_count = 6
    issue.user_count = 2
    issue.agent_id = "agent-a"
    issue.triage_result = {
        "summary": "null deref",
        "confidence": 0.9,
        "recommended_action": "propose_patch",
        "candidate_files": ["agent/checkout.py"],
        "example_trace_id": "trc_prod_99",
    }
    return issue


_GENERATE = {
    "data": {
        "status": "proposed",
        "diff": "diff --git a/x b/x\n@@\n-a\n+b\n",
        "cost_usd": 0.01,
        "files": ["agent/checkout.py"],
        "description": "fix",
        "explanation": "why",
        "critic_verdict": {"passed": True},
    }
}


def _propose_patches(
    *,
    hermetic_status: str = "static_passed",
    replay: ReplayResult | None = None,
    create_plan: AsyncMock,
    generate: AsyncMock | None = None,
) -> list:
    issue = _issue()
    patches = [
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
                    "rca_summary": "rca text",
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
            AsyncMock(
                return_value=[
                    {"path": "agent/checkout.py", "content": "def checkout():\n    pass\n"}
                ]
            ),
        ),
        patch(
            "eden.improvement.evidence_plane.build_failure_pack",
            AsyncMock(
                return_value={
                    "status": "ok",
                    "example_trace_ids": ["trc_prod_99"],
                    "excerpt": "span=tool.error boom",
                    "format": "eden-failure-fixture-v1",
                    "failure_signature": {
                        "stumble_kind": "tool_error",
                        "error_substring": "boom",
                        "failing_span_name": "tool.error",
                        "judge_dimension": None,
                    },
                }
            ),
        ),
        patch(
            "eden.improvement.evidence_plane.run_hermetic_preverify",
            AsyncMock(return_value={"status": hermetic_status, "detail": {}}),
        ),
        patch(
            "eden.patches.patch_generator.PatchGenerator.generate",
            generate or AsyncMock(return_value=_GENERATE),
        ),
        patch("eden.improvement.plans_repo.create_plan", create_plan),
        patch(
            "eden.closed_loop.autonomy_policy.record_spend",
            AsyncMock(return_value=0.01),
        ),
    ]
    if replay is not None:
        patches.append(
            patch(
                "eden.improvement.replay_verify.run_replay_verify",
                AsyncMock(return_value=replay),
            )
        )
    return patches


async def _run_propose(patches) -> dict:
    from eden.improvement.issue_patch_trigger import propose_plan_for_issue

    with ExitStack() as stack:
        for patcher in patches:
            stack.enter_context(patcher)
        return await propose_plan_for_issue(ORG, ISSUE_ID)


@pytest.mark.asyncio
async def test_tier_static_when_replay_skipped() -> None:
    create_plan = AsyncMock(return_value={"id": "plan-1"})
    replay = ReplayResult(status="skipped", reason="no_checkpoints")
    result = await _run_propose(
        _propose_patches(replay=replay, create_plan=create_plan)
    )
    assert result["status"] == "proposed"
    assert result["replay"] == "skipped"
    assert result["evidence_tier"] == "static"
    evidence = create_plan.await_args.kwargs["evidence"]
    assert evidence["evidence_tier"] == "static"
    # Skipped is allowed through but the honest label is carried.
    assert evidence["replay"]["status"] == "skipped"
    assert evidence["replay"]["reason"] == "no_checkpoints"
    assert evidence["failure_signature"]["error_substring"] == "boom"


@pytest.mark.asyncio
async def test_tier_replay_when_replay_passed() -> None:
    create_plan = AsyncMock(return_value={"id": "plan-1"})
    replay = ReplayResult(
        status="passed",
        reason="signature_absent_in_replay",
        cost_usd=0.002,
        traces_checked=1,
    )
    result = await _run_propose(
        _propose_patches(replay=replay, create_plan=create_plan)
    )
    assert result["status"] == "proposed"
    assert result["evidence_tier"] == "replay"
    evidence = create_plan.await_args.kwargs["evidence"]
    assert evidence["evidence_tier"] == "replay"
    assert evidence["replay"]["status"] == "passed"
    assert evidence["replay"]["traces_checked"] == 1


@pytest.mark.asyncio
async def test_replay_failed_suppresses_with_stamped_reason() -> None:
    create_plan = AsyncMock(return_value={"id": "plan-1"})
    stamp = AsyncMock()
    replay = ReplayResult(
        status="failed", reason="signature_still_present", traces_checked=2
    )
    patches = _propose_patches(replay=replay, create_plan=create_plan)
    patches.append(
        patch("eden.improvement.issue_patch_trigger._stamp_patch_blocked", stamp)
    )
    result = await _run_propose(patches)
    assert result["status"] == "suppressed"
    assert result["reason"] == "replay_failed"
    assert result["replay"]["status"] == "failed"
    create_plan.assert_not_awaited()
    stamp.assert_awaited_once()
    assert stamp.await_args.kwargs["reason"] == "replay_failed"


@pytest.mark.asyncio
async def test_hermetic_static_passed_label_in_evidence() -> None:
    create_plan = AsyncMock(return_value={"id": "plan-1"})
    replay = ReplayResult(status="skipped", reason="not_replayable")
    result = await _run_propose(
        _propose_patches(
            hermetic_status="static_passed", replay=replay, create_plan=create_plan
        )
    )
    assert result["status"] == "proposed"
    assert result["hermetic_preverify"] == "static_passed"
    evidence = create_plan.await_args.kwargs["evidence"]
    assert evidence["hermetic_preverify"]["status"] == "static_passed"


@pytest.mark.asyncio
async def test_legacy_passed_label_still_accepted() -> None:
    """Backward compat: legacy "passed" evidence neither gates nor breaks."""
    create_plan = AsyncMock(return_value={"id": "plan-1"})
    replay = ReplayResult(status="skipped", reason="disabled")
    result = await _run_propose(
        _propose_patches(
            hermetic_status="passed", replay=replay, create_plan=create_plan
        )
    )
    assert result["status"] == "proposed"
    assert result["hermetic_preverify"] == "passed"


@pytest.mark.asyncio
async def test_run_hermetic_preverify_returns_static_passed() -> None:
    """The real preverify never claims a bare "passed" any more."""
    from eden.improvement.evidence_plane import run_hermetic_preverify

    base = "def checkout():\n    return 1\n"
    diff = (
        "diff --git a/agent/checkout.py b/agent/checkout.py\n"
        "--- a/agent/checkout.py\n"
        "+++ b/agent/checkout.py\n"
        "@@ -1,2 +1,2 @@\n"
        " def checkout():\n"
        "-    return 1\n"
        "+    return 2\n"
    )
    with patch(
        "eden.improvement.evidence_plane._persist_preverify", AsyncMock()
    ):
        result = await run_hermetic_preverify(
            ORG,
            ISSUE_ID,
            example_trace_ids=[],
            fingerprint="fp1",
            diff_unified=diff,
            linked_files=[{"path": "agent/checkout.py", "content": base}],
        )
    assert result["status"] == "static_passed"
    assert result["detail"]["reason"] == "diff_ok_no_example_traces"


@pytest.mark.asyncio
async def test_persist_preverify_maps_static_passed_to_db_passed() -> None:
    from eden.improvement.evidence_plane import _persist_preverify

    executed: list[tuple] = []

    class _Client:
        async def execute(self, sql, *args):
            executed.append(args)

    async def _pg():
        return _Client()

    with patch("eden.storage.postgres.get_postgres_client", _pg):
        await _persist_preverify(
            ORG, ISSUE_ID, "fp1", {"status": "static_passed", "detail": {}}
        )
    assert executed
    # arg 5 ($5) is the DB status — must stay inside the CHECK constraint.
    assert executed[0][4] == "passed"


@pytest.mark.asyncio
async def test_build_failure_pack_embeds_signature() -> None:
    from eden.improvement.evidence_plane import build_failure_pack

    fixture = {
        "format": "eden-failure-fixture-v1",
        "traces": [
            {
                "trace_id": "trc-1",
                "detail": {"kind": "tool_error", "error": "boom went the tool 42"},
                "spans": [
                    {"name": "tool.boom", "attributes": {"error": "boom went the tool 42"}}
                ],
            }
        ],
    }
    with patch(
        "eden.issues.fixture_export.export_issue_fixture",
        AsyncMock(return_value={"status": "ok", "fixture": fixture}),
    ):
        pack = await build_failure_pack(ORG, ISSUE_ID)
    sig = pack["failure_signature"]
    assert sig is not None
    assert sig["stumble_kind"] == "tool_error"
    assert sig["error_substring"] == "boom went the tool <n>"
    assert sig["failing_span_name"] == "tool.boom"
