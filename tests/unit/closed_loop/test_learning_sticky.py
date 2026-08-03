"""M13 (§6.4) — LEARNING sticky when N01 case persist fails."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.closed_loop.events import EventType, LoopEvent
from eden.closed_loop.orchestrator import ClosedLoopOrchestrator


ORG = "org-learn"
ISSUE = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"


@pytest.mark.asyncio
async def test_learning_sticky_on_case_persist_failure() -> None:
    """VERIFY flywheel: resolved→learning; persist fail leaves learning + audit."""
    orch = ClosedLoopOrchestrator()
    transitions: list[str] = []

    async def _fake_transition(
        org_id: str,
        issue_id: str,
        *,
        event_type: str,
        **kwargs: Any,
    ) -> str | None:
        transitions.append(event_type)
        if event_type == EventType.LEARNING_STARTED:
            return "learning"
        if event_type == EventType.LEARNING_COMPLETED:
            return "resolved"
        return None

    audit = AsyncMock()
    issue = SimpleNamespace(
        id=ISSUE,
        agent_id="a1",
        title="t",
        kind="loop",
        stumble_count=2,
        triage_result={},
    )

    with (
        patch(
            "eden.closed_loop.state_machine.apply_transition",
            _fake_transition,
        ),
        patch(
            "eden.evaluation.regression_builder.on_issue_resolved",
            AsyncMock(side_effect=RuntimeError("db down")),
        ),
        patch("eden.closed_loop.autonomy_policy.audit", audit),
        patch(
            "eden.issues.repo.IssuesRepo",
            return_value=MagicMock(get_issue=AsyncMock(return_value=issue)),
        ),
        patch(
            "eden.kb.flywheel.coordinator.get_flywheel_coordinator",
            return_value=MagicMock(
                on_issue_resolved=AsyncMock(return_value=None)
            ),
        ),
    ):
        event = LoopEvent(
            type=EventType.VERIFY_PASSED,
            org_id=ORG,
            issue_id=ISSUE,
            payload={"agent_id": "a1"},
        )
        await orch._flywheel_on_resolved(event)

    assert EventType.LEARNING_STARTED in transitions
    assert EventType.LEARNING_COMPLETED not in transitions
    audit.assert_awaited_once()
    assert audit.await_args.kwargs["action"] == "learning_case_persist_failed"
    assert audit.await_args.kwargs["decision"] == "retryable"


@pytest.mark.asyncio
async def test_learning_completes_when_case_persists() -> None:
    orch = ClosedLoopOrchestrator()
    transitions: list[str] = []

    async def _fake_transition(
        org_id: str,
        issue_id: str,
        *,
        event_type: str,
        **kwargs: Any,
    ) -> str | None:
        transitions.append(event_type)
        if event_type == EventType.LEARNING_STARTED:
            return "learning"
        if event_type == EventType.LEARNING_COMPLETED:
            return "resolved"
        return None

    issue = SimpleNamespace(
        id=ISSUE,
        agent_id="a1",
        title="t",
        kind="loop",
        stumble_count=2,
        triage_result={},
    )

    with (
        patch(
            "eden.closed_loop.state_machine.apply_transition",
            _fake_transition,
        ),
        patch(
            "eden.evaluation.regression_builder.on_issue_resolved",
            AsyncMock(return_value=[{"id": "case-1"}]),
        ),
        patch(
            "eden.issues.repo.IssuesRepo",
            return_value=MagicMock(get_issue=AsyncMock(return_value=issue)),
        ),
        patch(
            "eden.kb.flywheel.coordinator.get_flywheel_coordinator",
            return_value=MagicMock(
                on_issue_resolved=AsyncMock(return_value=None)
            ),
        ),
    ):
        event = LoopEvent(
            type=EventType.VERIFY_PASSED,
            org_id=ORG,
            issue_id=ISSUE,
        )
        await orch._flywheel_on_resolved(event)

    assert transitions == [
        EventType.LEARNING_STARTED,
        EventType.LEARNING_COMPLETED,
    ]


def test_state_machine_learning_transitions() -> None:
    from eden.closed_loop.state_machine import ISSUE_STATE_TRANSITIONS, IssueStatus

    assert (
        ISSUE_STATE_TRANSITIONS[EventType.LEARNING_STARTED][IssueStatus.RESOLVED]
        == IssueStatus.LEARNING
    )
    assert (
        ISSUE_STATE_TRANSITIONS[EventType.LEARNING_COMPLETED][IssueStatus.LEARNING]
        == IssueStatus.RESOLVED
    )
