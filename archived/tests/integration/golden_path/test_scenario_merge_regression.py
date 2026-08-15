"""Golden-path scenario 3 — post-merge regression (plan M1, spec §2.2.3).

A merged Eden fix PR regresses: same-fingerprint stumbles reappear inside
the post-merge quiet window → VERIFY_FAILED → the guardian drafts an
*actionable* plan (M5, D9): a real follow-up diff via the generation
seam (or an ``advisory`` when generation fails) — never an approvable
empty ``code_patch``.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from eden.closed_loop.events import EventType, LoopEvent
from eden.closed_loop.orchestrator import ClosedLoopOrchestrator
from eden.closed_loop.verify import run_due_verifications
from eden.improvement.approve import approve_plan, queue_verify_for_plan
from eden.improvement.guardian import handle_regression

from .conftest import BUGGY_FILE, ORG, SAMPLE_DIFF

# The guardian's follow-up path runs the real PatchGenerator pipeline
# (M5); fake the LLM at the same seam scenario 1 uses so the drafted
# follow-up carries a real, applicable diff.
_FOLLOW_UP_ENVELOPE = {
    "data": {
        "status": "proposed",
        "diff": SAMPLE_DIFF,
        "description": "Follow-up: fix checkout regression",
        "explanation": "restores the checkout fix",
        "cost_usd": 0.05,
        "files": [BUGGY_FILE],
        "patch_id": "patch-golden-3",
    }
}


@pytest.fixture(autouse=True)
def fake_generation(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "eden.patches.patch_generator.PatchGenerator.generate",
        AsyncMock(return_value=_FOLLOW_UP_ENVELOPE),
    )

ISSUE_ID = "44444444-4444-4444-4444-444444444444"
PLAN_ID = "55555555-5555-5555-5555-555555555555"
FINGERPRINT_REG = "fp-golden-regression"


def _seed(loop_db) -> None:
    loop_db.seed_issue(
        ISSUE_ID,
        status="verifying",
        fingerprint=FINGERPRINT_REG,
        triage_result={"root_cause": "code_bug", "confidence": 0.8},
    )
    loop_db.seed_plan(
        PLAN_ID, status="merged", issue_id=ISSUE_ID, pr_number=7
    )
    loop_db.seed_policy()
    # Same-fingerprint stumbles recur inside the quiet window. The verify
    # row's fingerprint is the schedule ref (branch/source_ref), so the
    # wildcard count models "new stumbles present" regardless of key.
    loop_db.seed_stumbles(3, fingerprint=FINGERPRINT_REG)
    loop_db.recent_stumbles_any = 3


async def _run_verify_until_failed() -> dict[str, int]:
    """verify_max_attempts=3 → two retried passes, then the failure."""
    summary: dict[str, int] = {}
    for _ in range(3):
        summary = await run_due_verifications()
        if summary.get("failed"):
            break
    return summary


@pytest.mark.asyncio
async def test_recurring_stumbles_fail_post_merge_verify(loop_db, bus) -> None:
    """Quiet-window stumbles → VERIFY_FAILED emitted for the issue."""
    _seed(loop_db)
    merged = dict(loop_db.plans[PLAN_ID])
    merged["evidence"] = {"issue_id": ISSUE_ID}
    verify_id = await queue_verify_for_plan(ORG, merged)
    assert verify_id

    summary = await _run_verify_until_failed()
    assert summary.get("failed") == 1, summary
    failed = [e for e in bus if e.type == EventType.VERIFY_FAILED]
    assert failed and failed[0].issue_id == ISSUE_ID
    assert "stumbles" in (failed[0].payload.get("verify") or {}).get("reason", "")


@pytest.mark.asyncio
async def test_verify_failed_event_drives_guardian_and_escalation(
    loop_db, bus
) -> None:
    """VERIFY_FAILED → issue regressed + guardian drafts a linked
    follow-up plan + human escalation event."""
    _seed(loop_db)
    event = LoopEvent(
        type=EventType.VERIFY_FAILED,
        org_id=ORG,
        issue_id=ISSUE_ID,
        ref=FINGERPRINT_REG,
        payload={"verify": {"reason": "new stumbles within quiet window"}},
    )
    await ClosedLoopOrchestrator().on_event(event)

    assert loop_db.issues[ISSUE_ID]["status"] == "regressed"
    follow_ups = [
        p for p in loop_db.plans.values()
        if str(p.get("parent_plan_id") or "") == PLAN_ID
    ]
    assert follow_ups, "guardian must draft a follow-up plan for the merged PR"
    assert any(e.type == EventType.ESCALATED_HUMAN for e in bus)


@pytest.mark.asyncio
async def test_guardian_drafts_linked_follow_up(loop_db) -> None:
    """handle_regression returns drafted + links the child to the parent."""
    _seed(loop_db)
    result = await handle_regression(ORG, ISSUE_ID, severity="")

    assert result["status"] == "drafted", result
    assert result["plan_id"] == PLAN_ID
    follow_up_id = result["follow_up_plan_id"]
    assert follow_up_id, "follow-up plan row must be created"
    follow_up = loop_db.plans[str(follow_up_id)]
    assert str(follow_up["parent_plan_id"]) == PLAN_ID
    assert follow_up["plan_kind"] == "code_patch"


@pytest.mark.asyncio
async def test_guardian_plan_has_nonempty_diff(loop_db) -> None:
    """An approvable guardian code_patch must never be an empty shell."""
    _seed(loop_db)
    result = await handle_regression(ORG, ISSUE_ID, severity="")
    follow_up = loop_db.plans[str(result["follow_up_plan_id"])]
    assert (follow_up.get("diff_unified") or "").strip(), (
        "guardian code_patch drafted with empty diff"
    )


@pytest.mark.asyncio
async def test_approve_guardian_plan_never_returns_empty_diff(
    loop_db, local_providers
) -> None:
    _seed(loop_db)
    loop_db.seed_repo_connection(str(local_providers))
    result = await handle_regression(ORG, ISSUE_ID, severity="")
    follow_up_id = str(result["follow_up_plan_id"])

    approve_result = await approve_plan(ORG, follow_up_id, approved_by="golden-user")
    assert approve_result.get("error") != "empty_diff", approve_result
