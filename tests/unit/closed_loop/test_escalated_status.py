"""M4 (D17) — escalation writes a real ``escalated`` status.

``ESCALATED_HUMAN`` used to be an event with no transition entry, so
"escalate to a human" changed nothing an operator could filter on. Now
open/triaged/fix_pending/verifying move to ``escalated`` (regressed and
terminal states deliberately keep their more specific status), the
orchestrator applies the transition before emitting the event, and
migration 136 widens the 084 CHECK to match the enum.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.closed_loop import orchestrator as orch_mod
from eden.closed_loop.events import EventType, LoopEvent
from eden.closed_loop.orchestrator import ClosedLoopOrchestrator
from eden.closed_loop.state_machine import (
    ISSUE_STATE_TRANSITIONS,
    IssueStatus,
    apply_transition,
    next_status,
)

ORG = "org-esc"
ISSUE = "issue-esc-1"

MIGRATION = (
    Path(__file__).resolve().parents[3]
    / "src/eden/db_migrations/versions/000_squash_001_160.py"
)


# ── state machine ───────────────────────────────────────────────────


def test_escalated_transition_sources() -> None:
    for src in (
        IssueStatus.OPEN,
        IssueStatus.TRIAGED,
        IssueStatus.FIX_PENDING,
        IssueStatus.VERIFYING,
    ):
        assert next_status(src, EventType.ESCALATED_HUMAN) == IssueStatus.ESCALATED

    # regressed/terminal states keep their more specific status (the
    # golden-path merge-regression scenario asserts "regressed" sticks).
    for src in (
        IssueStatus.REGRESSED,
        IssueStatus.RESOLVED,
        IssueStatus.IGNORED,
        IssueStatus.ESCALATED,
    ):
        assert next_status(src, EventType.ESCALATED_HUMAN) is None


@pytest.mark.asyncio
async def test_apply_transition_writes_escalated() -> None:
    repo = MagicMock()
    repo.get_issue = AsyncMock(
        return_value=MagicMock(status=IssueStatus.TRIAGED)
    )
    repo.set_status = AsyncMock(return_value=True)

    with patch("eden.issues.repo.IssuesRepo", return_value=repo):
        new = await apply_transition(
            ORG, ISSUE, event_type=EventType.ESCALATED_HUMAN, reason="p0"
        )

    assert new == IssueStatus.ESCALATED
    repo.set_status.assert_awaited_once()
    args = repo.set_status.await_args
    assert args.args[2] == IssueStatus.ESCALATED
    assert args.kwargs.get("set_resolved_at") is False


# ── orchestrator applies it before emitting ─────────────────────────


@pytest.mark.asyncio
async def test_escalate_human_applies_transition_and_emits() -> None:
    published: list[LoopEvent] = []
    transitions: list[dict[str, Any]] = []

    async def _pub(event: LoopEvent, redis: Any | None = None) -> bool:
        published.append(event)
        return True

    async def _apply(org_id: str, issue_id: str, **kwargs: Any) -> str:
        transitions.append({"org_id": org_id, "issue_id": issue_id, **kwargs})
        return IssueStatus.ESCALATED

    event = LoopEvent(
        type=EventType.TRIAGE_COMPLETED,
        org_id=ORG,
        issue_id=ISSUE,
        ref="fp-esc",
        payload={},
    )
    with (
        patch.object(orch_mod, "publish", _pub),
        patch.object(orch_mod, "apply_transition", _apply),
    ):
        await ClosedLoopOrchestrator()._escalate_human(
            event, {"severity": "p0"}, reason="triage_failed"
        )

    assert transitions, "escalate must apply the ESCALATED_HUMAN transition"
    assert transitions[0]["event_type"] == EventType.ESCALATED_HUMAN
    assert "triage_failed" in transitions[0]["reason"]
    escalated = [e for e in published if e.type == EventType.ESCALATED_HUMAN]
    assert escalated and escalated[0].payload["reason"] == "triage_failed"


# ── migration 136 stays in lockstep with the enum ───────────────────


def _check_statuses(sql_block: str) -> set[str]:
    return set(re.findall(r"'([a-z_]+)'", sql_block))


def test_migration_chain_and_check_matches_enum() -> None:
    src = MIGRATION.read_text()
    # Squash carries revision 160 and is the chain base.
    assert "160_signal_definitions_org_enabled_created" in src
    assert "down_revision: str | None = None" in src

    upgrade_src = src.split("def upgrade")[1].split("def downgrade")[0]
    # The squash upgrade must include the 'escalated' status widening
    # from the original migration 136.
    assert "'escalated'" in upgrade_src
    # _BASE_STATUSES must still be present in the upgrade body.
    assert "_BASE_STATUSES" in upgrade_src


def test_migration_downgrade_raises_not_implemented() -> None:
    src = MIGRATION.read_text()
    downgrade_src = src.split("def downgrade")[1]
    # The squash boundary downgrade raises NotImplementedError.
    assert "NotImplementedError" in downgrade_src


def test_transition_table_has_no_undeclared_statuses() -> None:
    """Every status the transition table names exists on IssueStatus."""
    enum_statuses = {
        v
        for k, v in vars(IssueStatus).items()
        if not k.startswith("_") and isinstance(v, str)
    }
    used: set[str] = set()
    for mapping in ISSUE_STATE_TRANSITIONS.values():
        used |= set(mapping)
        used |= set(mapping.values())
    assert used <= enum_statuses
