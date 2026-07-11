"""F46 — closed-loop orchestrator (Wave 4).

Exercises the event model, the F46 state machine, the orchestrator's
event handlers, the G9 hook→loop bridge, event-bus idempotency, and the
G8 ``apply_approved`` dispatch — all against light in-memory fakes so the
wiring logic runs for real.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.closed_loop.events import EventType, LoopEvent
from eden.closed_loop.state_machine import (
    IssueStatus,
    apply_transition,
    next_status,
)
from eden.issues.models import Issue

# ── LoopEvent model ─────────────────────────────────────────────────


def test_loop_event_round_trips_through_redis_fields() -> None:
    ev = LoopEvent(
        type=EventType.ISSUE_CREATED,
        org_id="org_test",
        issue_id="iss-1",
        ref="fp-abc",
        payload={"severity": "p1", "n": 3},
    )
    fields = ev.to_fields()
    back = LoopEvent.from_fields(fields)
    assert back.type == EventType.ISSUE_CREATED
    assert back.org_id == "org_test"
    assert back.issue_id == "iss-1"
    assert back.ref == "fp-abc"
    assert back.payload == {"severity": "p1", "n": 3}
    assert back.event_id == ev.event_id


def test_idempotency_key_is_issue_type_ref() -> None:
    ev = LoopEvent(
        type=EventType.TRIAGE_COMPLETED,
        org_id="o",
        issue_id="iss-1",
        ref="r1",
    )
    assert ev.idempotency_key() == "iss-1:triage_completed:r1"


def test_from_fields_decodes_bytes() -> None:
    ev = LoopEvent(type=EventType.VERIFY_PASSED, org_id="o", issue_id="iss-9")
    raw = {k.encode(): v.encode() for k, v in ev.to_fields().items()}
    back = LoopEvent.from_fields(raw)
    assert back.type == EventType.VERIFY_PASSED
    assert back.issue_id == "iss-9"


# ── State machine ───────────────────────────────────────────────────


def test_next_status_transitions() -> None:
    assert (
        next_status(IssueStatus.OPEN, EventType.TRIAGE_COMPLETED)
        == IssueStatus.TRIAGED
    )
    assert (
        next_status(IssueStatus.TRIAGED, EventType.HEAL_EXECUTED)
        == IssueStatus.VERIFYING
    )
    assert (
        next_status(IssueStatus.VERIFYING, EventType.VERIFY_PASSED)
        == IssueStatus.RESOLVED
    )
    assert (
        next_status(IssueStatus.VERIFYING, EventType.VERIFY_FAILED)
        == IssueStatus.REGRESSED
    )
    # Invalid transition → None (no-op).
    assert next_status(IssueStatus.RESOLVED, EventType.TRIAGE_COMPLETED) is None
    assert next_status(IssueStatus.OPEN, EventType.VERIFY_PASSED) is None


def _issue(status: str = "open") -> Issue:
    return Issue(
        id="iss-1",
        org_id="org_test",
        fingerprint="fp",
        kind="tool_error",
        title="t",
        status=status,
        severity="p1",
    )


@pytest.mark.asyncio
async def test_apply_transition_advances_and_records() -> None:
    repo = MagicMock()
    repo.get_issue = AsyncMock(return_value=_issue("open"))
    repo.set_status = AsyncMock(return_value=True)
    pg = MagicMock()
    pg.execute = AsyncMock(return_value="INSERT 0 1")

    with patch("eden.issues.repo.IssuesRepo", return_value=repo), patch(
        "eden.storage.postgres.get_postgres_client", return_value=pg
    ):
        new_status = await apply_transition(
            "org_test",
            "iss-1",
            event_type=EventType.TRIAGE_COMPLETED,
            reason="test",
        )

    assert new_status == IssueStatus.TRIAGED
    repo.set_status.assert_awaited_once()
    # audit row appended
    pg.execute.assert_awaited_once()
    args = pg.execute.await_args.args
    assert "issue_state_transitions" in args[0]


@pytest.mark.asyncio
async def test_apply_transition_noop_on_invalid() -> None:
    repo = MagicMock()
    repo.get_issue = AsyncMock(return_value=_issue("resolved"))
    repo.set_status = AsyncMock(return_value=True)
    with patch("eden.issues.repo.IssuesRepo", return_value=repo):
        result = await apply_transition(
            "org_test",
            "iss-1",
            event_type=EventType.TRIAGE_COMPLETED,
        )
    assert result is None
    repo.set_status.assert_not_awaited()


@pytest.mark.asyncio
async def test_apply_transition_sets_resolved_at_on_resolve() -> None:
    repo = MagicMock()
    repo.get_issue = AsyncMock(return_value=_issue("verifying"))
    repo.set_status = AsyncMock(return_value=True)
    pg = MagicMock()
    pg.execute = AsyncMock(return_value="INSERT 0 1")
    with patch("eden.issues.repo.IssuesRepo", return_value=repo), patch(
        "eden.storage.postgres.get_postgres_client", return_value=pg
    ):
        new_status = await apply_transition(
            "org_test", "iss-1", event_type=EventType.VERIFY_PASSED
        )
    assert new_status == IssueStatus.RESOLVED
    _args, kwargs = repo.set_status.await_args
    assert kwargs.get("set_resolved_at") is True


# ── Orchestrator handlers ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_issue_created_triages_and_emits() -> None:
    from eden.closed_loop.orchestrator import ClosedLoopOrchestrator

    orch = ClosedLoopOrchestrator()
    emitted: list[LoopEvent] = []
    orch.emit = AsyncMock(side_effect=lambda e: emitted.append(e))  # type: ignore[method-assign]

    triage = MagicMock()
    triage.triage = AsyncMock(
        return_value={"data": {"triage_result": {"source": "statgate"}}}
    )

    with patch(
        "eden.issues.triage_agent.TriageAgent", return_value=triage
    ), patch(
        "eden.closed_loop.orchestrator.apply_transition", new=AsyncMock()
    ) as at, patch.object(
        ClosedLoopOrchestrator, "_maybe_alert", new=AsyncMock()
    ):
        await orch.on_event(
            LoopEvent(
                type=EventType.ISSUE_CREATED,
                org_id="org_test",
                issue_id="iss-1",
                ref="fp",
            )
        )

    triage.triage.assert_awaited_once_with("org_test", "iss-1")
    at.assert_awaited_once()
    assert len(emitted) == 1
    assert emitted[0].type == EventType.TRIAGE_COMPLETED
    assert emitted[0].payload["triage_result"] == {"source": "statgate"}


@pytest.mark.asyncio
async def test_triage_completed_p0_escalates_human() -> None:
    from eden.closed_loop.orchestrator import ClosedLoopOrchestrator

    orch = ClosedLoopOrchestrator()
    emitted: list[LoopEvent] = []
    orch.emit = AsyncMock(side_effect=lambda e: emitted.append(e))  # type: ignore[method-assign]

    triage_result = {"p0_checks": ["etec_loop"], "auto_escalate": True}

    with patch.object(
        ClosedLoopOrchestrator, "_gate", new=AsyncMock(return_value="assisted")
    ), patch.object(ClosedLoopOrchestrator, "_maybe_alert", new=AsyncMock()):
        await orch.on_event(
            LoopEvent(
                type=EventType.TRIAGE_COMPLETED,
                org_id="org_test",
                issue_id="iss-1",
                ref="fp",
                payload={"triage_result": triage_result},
            )
        )

    assert any(e.type == EventType.ESCALATED_HUMAN for e in emitted)


@pytest.mark.asyncio
async def test_triage_completed_autonomous_heals() -> None:
    from eden.closed_loop.orchestrator import ClosedLoopOrchestrator

    orch = ClosedLoopOrchestrator()
    orch.emit = AsyncMock()  # type: ignore[method-assign]

    triage_result = {
        "suggested_actions": [{"action_type": "cache_bust"}],
    }
    healer = MagicMock()
    healer.heal_from_issue = AsyncMock(
        return_value={"data": {"status": "executed"}}
    )

    with patch.object(
        ClosedLoopOrchestrator, "_gate", new=AsyncMock(return_value="autonomous")
    ), patch(
        "eden.closed_loop.orchestrator.apply_transition", new=AsyncMock()
    ), patch(
        "eden.autonomous.investigation.SelfHealer", return_value=healer
    ):
        await orch.on_event(
            LoopEvent(
                type=EventType.TRIAGE_COMPLETED,
                org_id="org_test",
                issue_id="iss-1",
                ref="fp",
                payload={"triage_result": triage_result},
            )
        )

    healer.heal_from_issue.assert_awaited_once_with("org_test", "iss-1")
    # heal executed → emits HEAL_EXECUTED
    assert any(
        c.args[0].type == EventType.HEAL_EXECUTED
        for c in orch.emit.await_args_list
    )


@pytest.mark.asyncio
async def test_observe_mode_stays_advisory() -> None:
    from eden.closed_loop.orchestrator import ClosedLoopOrchestrator

    orch = ClosedLoopOrchestrator()
    orch.emit = AsyncMock()  # type: ignore[method-assign]

    with patch.object(
        ClosedLoopOrchestrator, "_gate", new=AsyncMock(return_value="observe")
    ):
        await orch._on_triage_completed(
            LoopEvent(
                type=EventType.TRIAGE_COMPLETED,
                org_id="org_test",
                issue_id="iss-1",
                payload={"triage_result": {"suggested_actions": [
                    {"action_type": "rollback"}
                ]}},
            )
        )
    # observe → recommend → no heal/patch/human emitted
    orch.emit.assert_not_awaited()


# ── G9: hook → loop bridge ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_subscribe_bridges_hook_to_loop_event() -> None:
    from eden.closed_loop.orchestrator import ClosedLoopOrchestrator
    from eden.llmops.promotion_hooks import IssueHook

    hook = IssueHook()
    hook.on_issue_created = AsyncMock(return_value="action-42")  # type: ignore[method-assign]

    orch = ClosedLoopOrchestrator()
    emitted: list[LoopEvent] = []
    orch.emit = AsyncMock(side_effect=lambda e: emitted.append(e))  # type: ignore[method-assign]

    with patch(
        "eden.llmops.promotion_hooks.get_issue_hook", return_value=hook
    ):
        orch.subscribe()
        # second subscribe is a no-op (idempotent)
        orch.subscribe()
        action_id = await hook.on_issue_created(
            "org_test",
            issue_id="iss-1",
            fingerprint="fp",
            kind="tool_error",
            severity="p1",
            title="boom",
            regressed=False,
        )

    assert action_id == "action-42"
    assert len(emitted) == 1
    ev = emitted[0]
    assert ev.type == EventType.ISSUE_CREATED
    assert ev.issue_id == "iss-1"
    assert ev.ref == "fp"
    assert ev.payload["action_id"] == "action-42"


# ── Event-bus idempotency ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_consumer_dedups_on_idempotency_key() -> None:
    from eden.closed_loop.event_bus import ClosedLoopConsumer

    orch = MagicMock()
    orch.on_event = AsyncMock()
    consumer = ClosedLoopConsumer(orchestrator=orch)

    ev = LoopEvent(
        type=EventType.ISSUE_CREATED,
        org_id="o",
        issue_id="iss-1",
        ref="fp",
    )
    fields = ev.to_fields()

    redis = MagicMock()
    # first call: SET NX succeeds (returns truthy); second: already set → None
    redis.set = AsyncMock(side_effect=[True, None])
    redis.xack = AsyncMock()

    await consumer._handle(redis, "1-0", fields)
    await consumer._handle(redis, "1-1", fields)

    # processed only once despite two deliveries of the same key
    orch.on_event.assert_awaited_once()
    assert redis.xack.await_count == 2  # both acked either way


# ── G8: apply_approved dispatch ─────────────────────────────────────


@pytest.mark.asyncio
async def test_apply_approved_dispatches_cache_bust() -> None:
    from eden.llmops.closed_loop_executor import ClosedLoopExecutor

    action = {
        "id": "act-1",
        "org_id": "org_test",
        "action_kind": "cache_bust",
        "payload": {},
        "target": None,
        "status": "approved",
    }

    with patch(
        "eden.llmops.closed_loop_executor._fetch_action_by_id",
        new=AsyncMock(return_value=action),
    ), patch(
        "eden.llmops.closed_loop_executor._update_status",
        new=AsyncMock(return_value=True),
    ), patch(
        "eden.autonomous.investigation._execute_cache_bust",
        new=AsyncMock(return_value={"flushed": 10}),
    ):
        res = await ClosedLoopExecutor().apply_approved(
            "org_test", action_id="act-1", applied_by="u1"
        )

    assert res["status"] == "ok"
    assert res["data"]["status"] == "applied"
    assert res["data"]["side_effect"] == "cache_bust"
    assert res["data"]["side_effect_detail"] == {"flushed": 10}


@pytest.mark.asyncio
async def test_apply_approved_investigate_triages_issue() -> None:
    from eden.llmops.closed_loop_executor import ClosedLoopExecutor

    action = {
        "id": "act-2",
        "org_id": "org_test",
        "action_kind": "investigate",
        "payload": {"issue_id": "iss-7"},
        "target": None,
        "status": "approved",
    }
    triage = MagicMock()
    triage.triage = AsyncMock(return_value={"data": {}})

    with patch(
        "eden.llmops.closed_loop_executor._fetch_action_by_id",
        new=AsyncMock(return_value=action),
    ), patch(
        "eden.llmops.closed_loop_executor._update_status",
        new=AsyncMock(return_value=True),
    ), patch("eden.issues.triage_agent.TriageAgent", return_value=triage):
        res = await ClosedLoopExecutor().apply_approved(
            "org_test", action_id="act-2"
        )

    triage.triage.assert_awaited_once_with("org_test", "iss-7")
    assert res["data"]["side_effect"] == "triage"


@pytest.mark.asyncio
async def test_apply_approved_missing_action_returns_not_implemented() -> None:
    from eden.llmops.closed_loop_executor import ClosedLoopExecutor

    with patch(
        "eden.llmops.closed_loop_executor._fetch_action_by_id",
        new=AsyncMock(return_value=None),
    ):
        res = await ClosedLoopExecutor().apply_approved(
            "org_test", action_id="missing"
        )
    assert res["status"] != "ok"


@pytest.mark.asyncio
async def test_apply_approved_denied_action_blocked() -> None:
    from eden.llmops.closed_loop_executor import ClosedLoopExecutor

    action = {
        "id": "act-3",
        "org_id": "org_test",
        "action_kind": "rollback",
        "payload": {},
        "status": "denied",
    }
    with patch(
        "eden.llmops.closed_loop_executor._fetch_action_by_id",
        new=AsyncMock(return_value=action),
    ):
        res = await ClosedLoopExecutor().apply_approved(
            "org_test", action_id="act-3"
        )
    assert res["status"] != "ok"
