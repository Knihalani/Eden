"""M3 (D3/D16) — heal cannot strand: a failed heal emits HEAL_FAILED
(fix_pending→triaged), escalates with the executor's ``failure_reason``,
and every failure envelope shape carries ``data.status="failed"`` plus a
machine-readable reason."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.closed_loop import orchestrator as orch_mod
from eden.closed_loop.events import EventType, LoopEvent
from eden.closed_loop.orchestrator import ClosedLoopOrchestrator

ORG = "org-heal-failed"
ISSUE = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
FP = "fp-heal-failed"

TRIAGE_ROLLBACK: dict[str, Any] = {
    "root_cause": "bad canary",
    "source": "statgate",
    "suggested_actions": [{"action_type": "rollback"}],
}


def _event() -> LoopEvent:
    return LoopEvent(
        type=EventType.TRIAGE_COMPLETED,
        org_id=ORG,
        issue_id=ISSUE,
        ref=FP,
        payload={"triage_result": TRIAGE_ROLLBACK},
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
        return "triaged"

    monkeypatch.setattr(orch_mod, "apply_transition", _capture)
    return calls


async def _drive_request_heal(healer_result: Any) -> ClosedLoopOrchestrator:
    import time

    orch = ClosedLoopOrchestrator()
    healer = MagicMock()
    if isinstance(healer_result, Exception):
        healer.heal_from_issue = AsyncMock(side_effect=healer_result)
    else:
        healer.heal_from_issue = AsyncMock(return_value=healer_result)
    with patch.object(
        ClosedLoopOrchestrator,
        "_decide_action_recorded",
        AsyncMock(return_value=("allow", "dec-heal-failed", time.time())),
    ), patch(
        "eden.llmops.feature_kills.is_autonomy_action_enabled",
        AsyncMock(return_value=True),
    ), patch(
        "eden.autonomous.investigation.SelfHealer", return_value=healer
    ):
        await orch._request_heal(_event(), dict(TRIAGE_ROLLBACK))
    return orch


@pytest.mark.asyncio
async def test_failed_envelope_emits_heal_failed_and_escalates(
    published, transitions
) -> None:
    envelope = {
        "status": "ok",
        "data": {"status": "failed", "failure_reason": "no_active_canary"},
    }
    await _drive_request_heal(envelope)

    assert not [e for e in published if e.type == EventType.HEAL_EXECUTED]
    failed = [e for e in published if e.type == EventType.HEAL_FAILED]
    assert failed and failed[0].payload["failure_reason"] == "no_active_canary"
    # fix_pending → triaged transition requested.
    assert any(
        t["event_type"] == EventType.HEAL_FAILED
        and t["detail"]["failure_reason"] == "no_active_canary"
        for t in transitions
    )
    escalated = [e for e in published if e.type == EventType.ESCALATED_HUMAN]
    assert escalated and escalated[0].payload["reason"] == "no_active_canary"


@pytest.mark.asyncio
async def test_status_only_failure_uses_status_as_reason(
    published, transitions
) -> None:
    envelope = {"status": "ok", "data": {"status": "not_found"}}
    await _drive_request_heal(envelope)

    failed = [e for e in published if e.type == EventType.HEAL_FAILED]
    assert failed and failed[0].payload["failure_reason"] == "not_found"


@pytest.mark.asyncio
async def test_exception_path_emits_heal_failed(published, transitions) -> None:
    await _drive_request_heal(RuntimeError("executor blew up"))

    failed = [e for e in published if e.type == EventType.HEAL_FAILED]
    assert failed and failed[0].payload["failure_reason"] == "heal_exception"
    assert "executor blew up" in failed[0].payload["heal"]["error"]
    escalated = [e for e in published if e.type == EventType.ESCALATED_HUMAN]
    assert escalated and escalated[0].payload["reason"] == "heal_exception"


@pytest.mark.asyncio
async def test_executed_envelope_still_emits_heal_executed(
    published, transitions
) -> None:
    envelope = {"status": "ok", "data": {"status": "executed"}}
    await _drive_request_heal(envelope)

    assert [e for e in published if e.type == EventType.HEAL_EXECUTED]
    assert not [e for e in published if e.type == EventType.HEAL_FAILED]
    assert not [e for e in published if e.type == EventType.ESCALATED_HUMAN]


# ── envelope shapes from the executor (D16) ─────────────────────────


@pytest.mark.asyncio
async def test_heal_from_issue_not_found_envelope_is_failed() -> None:
    from eden.autonomous.investigation import SelfHealer

    repo = MagicMock()
    repo.get_issue = AsyncMock(return_value=None)
    with patch("eden.issues.repo.IssuesRepo", return_value=repo):
        res = await SelfHealer().heal_from_issue(ORG, ISSUE)

    data = res["data"]
    assert data["status"] == "failed"
    assert data["failure_reason"] == "issue_not_found"


@pytest.mark.asyncio
async def test_heal_from_issue_unmapped_action_envelope_is_failed() -> None:
    from eden.autonomous.investigation import SelfHealer

    issue = SimpleNamespace(
        id=ISSUE,
        triage_result={"suggested_actions": [{"action_type": "email"}]},
    )
    repo = MagicMock()
    repo.get_issue = AsyncMock(return_value=issue)
    with patch("eden.issues.repo.IssuesRepo", return_value=repo):
        res = await SelfHealer().heal_from_issue(ORG, ISSUE)

    data = res["data"]
    assert data["status"] == "failed"
    assert data["failure_reason"] == "no_heal_action_mapped"


@pytest.mark.asyncio
async def test_execute_heal_action_not_found_envelope_is_failed() -> None:
    from eden.autonomous.investigation import SelfHealer

    with patch(
        "eden.autonomous.investigation._load_self_heal_action",
        AsyncMock(return_value=None),
    ):
        res = await SelfHealer().execute_heal(
            ORG, "missing-action", approved_by_user_id="tester"
        )

    data = res["data"]
    assert data["status"] == "failed"
    assert data["failure_reason"] == "action_not_found"


@pytest.mark.asyncio
async def test_execute_heal_unknown_action_type_carries_reason() -> None:
    from eden.autonomous.investigation import SelfHealer

    before_state = {"action_type": "teleport", "before_state": {}}
    with patch(
        "eden.autonomous.investigation._heal_precheck",
        AsyncMock(return_value=None),
    ), patch(
        "eden.autonomous.investigation._upsert_self_heal", AsyncMock()
    ), patch(
        "eden.autonomous.investigation._audit_heal", AsyncMock()
    ):
        res = await SelfHealer().execute_heal(
            ORG, "act-1", before_state, approved_by_user_id="tester"
        )

    data = res["data"]
    assert data["status"] == "failed"
    assert data["failure_reason"] == "unknown_action_type"


@pytest.mark.asyncio
async def test_execute_heal_precheck_block_carries_slug() -> None:
    from eden.autonomous.investigation import SelfHealer

    before_state = {"action_type": "rollback", "before_state": {}}
    with patch(
        "eden.autonomous.investigation._heal_precheck",
        AsyncMock(return_value="daily rollback cap (3) reached"),
    ), patch(
        "eden.autonomous.investigation._upsert_self_heal", AsyncMock()
    ), patch(
        "eden.autonomous.investigation._audit_heal", AsyncMock()
    ):
        res = await SelfHealer().execute_heal(
            ORG, "act-2", before_state, approved_by_user_id="tester"
        )

    data = res["data"]
    assert data["status"] == "failed"
    assert data["failure_reason"] == "rollback_cap_reached"


def test_precheck_failure_slugs() -> None:
    from eden.autonomous.investigation import _precheck_failure_slug

    assert (
        _precheck_failure_slug("kill switch disabled for action class 'x'")
        == "kill_switch_disabled"
    )
    assert (
        _precheck_failure_slug("kill switch check failed (fail-closed)")
        == "kill_switch_check_failed"
    )
    assert (
        _precheck_failure_slug("daily rollback cap (3) reached")
        == "rollback_cap_reached"
    )
    assert (
        _precheck_failure_slug("heal precheck failed (fail-closed)")
        == "precheck_failed"
    )
    assert _precheck_failure_slug("tier disabled by org policy") == "policy_deny"
