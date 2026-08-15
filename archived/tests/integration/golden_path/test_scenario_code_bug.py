"""Golden-path scenario 1 — code bug (plan M1, spec §2.2.1).

Seed a buggy repo file → issue with ≥5 same-fingerprint stumbles →
OPEN→TRIAGED transition → ``propose_plan_for_issue`` yields a plan with a
non-empty diff + evidence keys → ``approve_plan`` writes a local PR json
→ ``mark_merged`` + ``queue_verify_for_plan`` schedules verification →
verify pass resolves the issue.

Assertions that fail on today's code are xfail(strict) with their defect
id — flipping those markers is later milestones' acceptance.
"""

from __future__ import annotations

from contextlib import ExitStack
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.closed_loop.events import EventType, LoopEvent
from eden.closed_loop.orchestrator import ClosedLoopOrchestrator
from eden.closed_loop.verify import run_due_verifications
from eden.improvement.approve import approve_plan, queue_verify_for_plan
from eden.improvement.issue_patch_trigger import propose_plan_for_issue

from .conftest import AGENT, BUGGY_FILE, FINGERPRINT, ORG, SAMPLE_DIFF

ISSUE_ID = "11111111-1111-1111-1111-111111111111"

#: triage payload matching what a successful code-bug triage produces
#: (donor shape: tests/unit/improvement/test_w26_n20.py).
TRIAGE_CODE_BUG: dict[str, Any] = {
    "root_cause": "code_bug",
    "confidence": 0.8,
    "source": "llm",
    "recommended_action": "code_change",
    "candidate_files": [BUGGY_FILE],
    "linked_files": [BUGGY_FILE],
    "suggested_actions": [{"action_type": "propose_patch"}],
    "auto_escalate": False,
    "p0_checks": [],
    "fingerprint": FINGERPRINT,
}

_INVESTIGATION_ENVELOPE = {
    "status": "ok",
    "data": {
        "investigation_id": "inv-golden-1",
        "findings": [
            {"summary": "checkout divides by zero", "confidence": 0.8}
        ],
        "proposed_remediations": [
            {"action": "propose_patch", "summary": "fix the divide"}
        ],
        "llm_used": True,
    },
}

_GENERATE_ENVELOPE = {
    "data": {
        "status": "proposed",
        "diff": SAMPLE_DIFF,
        "description": "Fix checkout divide-by-zero",
        "explanation": "removes the /0",
        "cost_usd": 0.05,
        "files": [BUGGY_FILE],
        "patch_id": "patch-golden-1",
    }
}


def _issue_created_event() -> LoopEvent:
    return LoopEvent(
        type=EventType.ISSUE_CREATED,
        org_id=ORG,
        issue_id=ISSUE_ID,
        ref=FINGERPRINT,
        payload={"kind": "tool_error", "severity": "p1", "agent_id": AGENT},
    )


@pytest.mark.asyncio
async def test_issue_created_triage_transition(loop_db, bus, wait_until) -> None:
    """ISSUE_CREATED → real TriageAgent (faked LLM) → OPEN→TRIAGED."""
    loop_db.seed_issue(ISSUE_ID, status="open", triage_result=None)
    loop_db.seed_stumbles(6)
    loop_db.seed_policy()

    inv = MagicMock()
    inv.investigate = AsyncMock(return_value=_INVESTIGATION_ENVELOPE)
    with (
        patch("eden.autonomous.InvestigationAgent", return_value=inv),
        patch(
            "eden.issues.triage_agent.TriageAgent._budget_ok",
            AsyncMock(return_value=True),
        ),
        patch("eden.issues.triage_agent.TriageAgent._debit_budget", AsyncMock()),
    ):
        await ClosedLoopOrchestrator().on_event(_issue_created_event())

    issue = loop_db.issues[ISSUE_ID]
    assert issue["status"] == "triaged"
    assert issue["triage_result"], "triage payload must be stamped on the issue"
    assert issue["triage_result"].get("root_cause")
    wait_until(
        lambda: any(e.type == EventType.TRIAGE_COMPLETED for e in bus),
        message="TRIAGE_COMPLETED must be emitted",
    )
    assert any(
        t["event_type"] == EventType.TRIAGE_COMPLETED
        and t["from_status"] == "open"
        and t["to_status"] == "triaged"
        for t in loop_db.transitions
    )


@pytest.mark.asyncio
async def test_patch_decision_transitions_to_fix_pending(loop_db, bus) -> None:
    """TRIAGE_COMPLETED with a code-bug triage → decision patch →
    TRIAGED→FIX_PENDING + sweep requested for the issue."""
    loop_db.seed_issue(ISSUE_ID, status="triaged", triage_result=TRIAGE_CODE_BUG)
    loop_db.seed_policy()
    event = LoopEvent(
        type=EventType.TRIAGE_COMPLETED,
        org_id=ORG,
        issue_id=ISSUE_ID,
        ref=FINGERPRINT,
        payload={"triage_result": TRIAGE_CODE_BUG, "agent_id": AGENT},
    )
    request_sweep = AsyncMock()
    with patch("eden.improvement.agent.request_sweep", request_sweep):
        await ClosedLoopOrchestrator().on_event(event)

    assert loop_db.issues[ISSUE_ID]["status"] == "fix_pending"
    request_sweep.assert_awaited_once()
    assert request_sweep.await_args.kwargs.get("issue_id") == ISSUE_ID


def _propose_patches() -> list:
    """The LLM/evidence seams every propose test fakes identically."""
    return [
        patch(
            "eden.patches.patch_generator.PatchGenerator.generate",
            AsyncMock(return_value=_GENERATE_ENVELOPE),
        ),
        patch(
            "eden.improvement.evidence_plane.build_failure_pack",
            AsyncMock(
                return_value={
                    "status": "ok",
                    "example_trace_ids": ["trace-1", "trace-2"],
                    "excerpt": "ZeroDivisionError",
                    "format": "eden-failure-fixture-v1",
                }
            ),
        ),
        patch(
            "eden.improvement.evidence_plane.run_hermetic_preverify",
            AsyncMock(return_value={"status": "passed", "detail": {}}),
        ),
    ]


@pytest.mark.asyncio
async def test_propose_plan_yields_diff_and_evidence(
    loop_db, local_providers
) -> None:
    """propose_plan_for_issue produces a draft plan with a non-empty
    diff and the evidence keys the spec requires."""
    loop_db.seed_issue(ISSUE_ID, status="triaged", triage_result=TRIAGE_CODE_BUG)
    loop_db.seed_stumbles(6)
    loop_db.seed_policy()
    loop_db.seed_repo_connection(str(local_providers))

    with ExitStack() as stack:
        for patcher in _propose_patches():
            stack.enter_context(patcher)
        result = await propose_plan_for_issue(ORG, ISSUE_ID)

    assert result["status"] == "proposed", result
    plan = result["plan"]
    assert (plan["diff_unified"] or "").strip(), "plan must carry a real diff"
    evidence = plan["evidence"]
    for key in (
        "issue_id",
        "severity",
        "confidence",
        "stumble_count",
        "example_trace_ids",
        "failure_pack_status",
        "hermetic_preverify",
    ):
        assert key in evidence, f"evidence missing {key!r}: {evidence}"
    assert evidence["issue_id"] == ISSUE_ID
    assert loop_db.plans, "plan row must be persisted"


@pytest.mark.asyncio
async def test_propose_persists_through_real_create_plan(
    loop_db, local_providers
) -> None:
    """D28 (fixed in M3): the real create_plan accepts the persist call —
    the payload no longer carries a duplicate org_id."""
    loop_db.seed_issue(ISSUE_ID, status="triaged", triage_result=TRIAGE_CODE_BUG)
    loop_db.seed_stumbles(6)
    loop_db.seed_policy()
    loop_db.seed_repo_connection(str(local_providers))

    with ExitStack() as stack:
        for patcher in _propose_patches():
            stack.enter_context(patcher)
        result = await propose_plan_for_issue(ORG, ISSUE_ID)
    assert result["status"] == "proposed", result


@pytest.mark.asyncio
async def test_approve_plan_writes_local_pr_json(loop_db, local_providers) -> None:
    """approve_plan → LocalPRProvider → .eden/prs/<n>.json + pr_opened."""
    loop_db.seed_issue(ISSUE_ID, status="fix_pending", triage_result=TRIAGE_CODE_BUG)
    loop_db.seed_policy()
    loop_db.seed_repo_connection(str(local_providers))
    plan_id = loop_db.seed_plan(issue_id=ISSUE_ID)

    result = await approve_plan(ORG, plan_id, approved_by="golden-user")

    assert result["status"] == "pr_opened", result
    pr_files = sorted((local_providers / ".eden" / "prs").glob("*.json"))
    assert pr_files, "LocalPRProvider must write .eden/prs/<n>.json"
    assert loop_db.plans[plan_id]["status"] == "pr_opened"
    # The PR branch carries the patched (materialized) content, not hunks.
    import subprocess

    content = subprocess.run(
        ["/usr/bin/git", "show", f"eden/improve-{plan_id[:12]}:{BUGGY_FILE}"],
        cwd=local_providers,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert "return total" in content
    assert "/ 0" not in content


@pytest.mark.asyncio
async def test_mark_merged_and_queue_verify_schedules_verification(
    loop_db, local_providers
) -> None:
    """mark_merged + queue_verify_for_plan → pending issue_verifications row."""
    from eden.improvement import plans_repo

    loop_db.seed_issue(ISSUE_ID, status="fix_pending", triage_result=TRIAGE_CODE_BUG)
    plan_id = loop_db.seed_plan(issue_id=ISSUE_ID, status="pr_opened")

    merged = await plans_repo.mark_merged(ORG, plan_id)
    assert merged is not None and merged["status"] == "merged"

    verify_id = await queue_verify_for_plan(ORG, merged)
    assert verify_id, "verification must be scheduled"
    row = loop_db.verifications.get(ISSUE_ID)
    assert row is not None and row["status"] == "pending"


@pytest.mark.asyncio
async def test_quiet_window_verify_emits_pass(loop_db, bus) -> None:
    """No new stumbles in the quiet window → VERIFY_PASSED emitted."""
    loop_db.seed_issue(ISSUE_ID, status="fix_pending", triage_result=TRIAGE_CODE_BUG)
    plan_id = loop_db.seed_plan(issue_id=ISSUE_ID, status="merged")
    merged = dict(loop_db.plans[plan_id])
    merged["evidence"] = {"issue_id": ISSUE_ID}
    await queue_verify_for_plan(ORG, merged)
    loop_db.recent_stumbles_any = 0

    summary = await run_due_verifications()

    assert summary["passed"] == 1, summary
    passed = [e for e in bus if e.type == EventType.VERIFY_PASSED]
    assert passed and passed[0].issue_id == ISSUE_ID


@pytest.mark.asyncio
async def test_verify_pass_resolves_issue(loop_db, bus) -> None:
    """End of scenario 1: the passing verify must resolve the issue."""
    loop_db.seed_issue(ISSUE_ID, status="fix_pending", triage_result=TRIAGE_CODE_BUG)
    plan_id = loop_db.seed_plan(issue_id=ISSUE_ID, status="merged")
    merged = dict(loop_db.plans[plan_id])
    merged["evidence"] = {"issue_id": ISSUE_ID}
    await queue_verify_for_plan(ORG, merged)
    loop_db.recent_stumbles_any = 0

    await run_due_verifications()
    orch = ClosedLoopOrchestrator()
    for event in list(bus):
        if event.type == EventType.VERIFY_PASSED:
            await orch.on_event(event)

    assert loop_db.issues[ISSUE_ID]["status"] == "resolved"
