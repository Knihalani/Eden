"""M3 (D5) — truthful triage: an exception or budget deferral is NOT a
triage. No TRIAGE_COMPLETED; the failure is stamped, TRIAGE_FAILED is
emitted, one durable retry goes through the outbox, and the final
failure escalates to a human."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.closed_loop import orchestrator as orch_mod
from eden.closed_loop.events import EventType, LoopEvent
from eden.closed_loop.orchestrator import ClosedLoopOrchestrator

ORG = "org-truthful"
ISSUE = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
FP = "fp-truthful"


def _event(payload: dict[str, Any] | None = None, ref: str = FP) -> LoopEvent:
    return LoopEvent(
        type=EventType.ISSUE_CREATED,
        org_id=ORG,
        issue_id=ISSUE,
        ref=ref,
        payload=payload or {},
    )


@pytest.fixture
def published(monkeypatch: pytest.MonkeyPatch) -> list[LoopEvent]:
    events: list[LoopEvent] = []

    async def _capture(event: LoopEvent, redis: Any | None = None) -> bool:
        events.append(event)
        return True

    monkeypatch.setattr(orch_mod, "publish", _capture)
    return events


@pytest.fixture
def transitions(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    async def _capture(org_id: str, issue_id: str, **kwargs: Any) -> str:
        calls.append({"org_id": org_id, "issue_id": issue_id, **kwargs})
        return "open"

    monkeypatch.setattr(orch_mod, "apply_transition", _capture)
    return calls


@pytest.fixture
def repo() -> MagicMock:
    r = MagicMock()
    r.set_triage_result = AsyncMock(return_value=True)
    r.get_issue = AsyncMock(return_value=None)
    return r


def _seams(repo: MagicMock, triage: AsyncMock, retry: AsyncMock):
    ctrl = MagicMock()
    ctrl.should_run_triage = AsyncMock(return_value=(True, ""))
    agent = MagicMock()
    agent.triage = triage
    return (
        patch(
            "eden.closed_loop.efficiency.AgentEfficiencyController",
            return_value=ctrl,
        ),
        patch("eden.issues.triage_agent.TriageAgent", return_value=agent),
        patch("eden.issues.repo.IssuesRepo", return_value=repo),
        patch("eden.closed_loop.event_bus.schedule_retry", retry),
    )


@pytest.mark.asyncio
async def test_triage_exception_stamps_fails_and_schedules_retry(
    published, transitions, repo
) -> None:
    retry = AsyncMock(return_value=True)
    seams = _seams(repo, AsyncMock(side_effect=RuntimeError("llm down")), retry)
    with seams[0], seams[1], seams[2], seams[3]:
        await ClosedLoopOrchestrator().on_event(_event())

    # No TRIAGE_COMPLETED — the lie is dead.
    assert not [e for e in published if e.type == EventType.TRIAGE_COMPLETED]

    # Error stamped on the issue.
    repo.set_triage_result.assert_awaited_once()
    stamped = repo.set_triage_result.await_args.args[2]
    assert stamped["source"] == "error"
    assert "llm down" in stamped["error"]
    assert stamped["attempt"] == 1

    # TRIAGE_FAILED transition (open self-loop) + event.
    assert any(
        t["event_type"] == EventType.TRIAGE_FAILED for t in transitions
    )
    failed = [e for e in published if e.type == EventType.TRIAGE_FAILED]
    assert failed and failed[0].payload["attempt"] == 1

    # One durable retry via the outbox with attempt metadata.
    retry.assert_awaited_once()
    retry_event = retry.await_args.args[0]
    assert retry_event.type == EventType.ISSUE_CREATED
    assert retry_event.payload["triage_attempt"] == 2
    assert retry_event.ref.startswith(FP)
    assert retry_event.ref != FP  # idempotency key must not collide
    assert retry.await_args.kwargs["delay_seconds"] == 300

    # Not yet a human problem.
    assert not [e for e in published if e.type == EventType.ESCALATED_HUMAN]


@pytest.mark.asyncio
async def test_final_attempt_escalates_human(
    published, transitions, repo
) -> None:
    retry = AsyncMock(return_value=True)
    seams = _seams(repo, AsyncMock(side_effect=RuntimeError("still down")), retry)
    with seams[0], seams[1], seams[2], seams[3]:
        await ClosedLoopOrchestrator().on_event(
            _event(payload={"triage_attempt": 2})
        )

    assert not [e for e in published if e.type == EventType.TRIAGE_COMPLETED]
    retry.assert_not_awaited()
    escalated = [e for e in published if e.type == EventType.ESCALATED_HUMAN]
    assert escalated and escalated[0].payload["reason"] == "triage_failed"
    stamped = repo.set_triage_result.await_args.args[2]
    assert stamped["attempt"] == 2


@pytest.mark.asyncio
async def test_retry_enqueue_failure_escalates(
    published, transitions, repo
) -> None:
    retry = AsyncMock(return_value=False)  # outbox down too
    seams = _seams(repo, AsyncMock(side_effect=RuntimeError("boom")), retry)
    with seams[0], seams[1], seams[2], seams[3]:
        await ClosedLoopOrchestrator().on_event(_event())

    retry.assert_awaited_once()
    escalated = [e for e in published if e.type == EventType.ESCALATED_HUMAN]
    assert escalated and escalated[0].payload["reason"] == "triage_failed"


@pytest.mark.asyncio
async def test_retry_event_ref_normalized_on_success(
    published, transitions, repo
) -> None:
    """The outbox retry's suffixed ref is stripped before downstream use."""
    envelope = {
        "data": {"triage_result": {"source": "llm", "root_cause": "bug"}}
    }
    retry = AsyncMock(return_value=True)
    seams = _seams(repo, AsyncMock(return_value=envelope), retry)
    with seams[0], seams[1], seams[2], seams[3]:
        await ClosedLoopOrchestrator().on_event(
            _event(payload={"triage_attempt": 2}, ref=f"{FP}::triage-retry2")
        )

    completed = [e for e in published if e.type == EventType.TRIAGE_COMPLETED]
    assert completed and completed[0].ref == FP


@pytest.mark.asyncio
async def test_budget_exceeded_is_not_a_triage(
    published, transitions, repo
) -> None:
    envelope = {
        "status": "budget_exceeded",
        "data": {"triage_result": {"source": "budget_exceeded"}},
    }
    retry = AsyncMock(return_value=True)
    seams = _seams(repo, AsyncMock(return_value=envelope), retry)
    with seams[0], seams[1], seams[2], seams[3]:
        await ClosedLoopOrchestrator().on_event(_event())

    # Not triaged, not retried, not escalated — open + visible.
    assert not [e for e in published if e.type == EventType.TRIAGE_COMPLETED]
    retry.assert_not_awaited()
    assert not [e for e in published if e.type == EventType.ESCALATED_HUMAN]

    failed = [e for e in published if e.type == EventType.TRIAGE_FAILED]
    assert failed and failed[0].payload["reason"] == "budget"
    assert any(
        t["event_type"] == EventType.TRIAGE_FAILED
        and t["detail"]["source"] == "budget_exceeded"
        for t in transitions
    )
