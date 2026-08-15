"""N17 improvement cockpit aggregator unit tests."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.improvement import cockpit_aggregator as ca
from eden.improvement.cockpit_aggregator import (
    COLUMN_FIX_NOW,
    COLUMN_NEEDS_YOU,
    COLUMN_PROPOSED,
    COLUMN_URGENT,
    COLUMN_VERIFY,
    ImprovementCockpitAggregator,
    ImprovementItem,
    active_snooze_refs,
    is_snoozed,
    snooze_item,
)


class _Issue:
    def __init__(self, **kwargs: Any) -> None:
        self.id = kwargs.get("id", "i1")
        self.title = kwargs.get("title", "Loop detected")
        self.fingerprint = kwargs.get("fingerprint", "fp1")
        self.severity = kwargs.get("severity", "critical")
        self.status = kwargs.get("status", "open")
        self.agent_id = kwargs.get("agent_id", "agent_a")
        self.kind = kwargs.get("kind", "loop")
        self.stumble_count = kwargs.get("stumble_count", 3)


@pytest.fixture(autouse=True)
def _clear_snoozes() -> None:
    ca._SNOOZES.clear()
    yield
    ca._SNOOZES.clear()


@pytest.fixture(autouse=True)
def _quiet_loop_health(monkeypatch):
    """Stub the M2 loop-health source for this module.

    The unit-test environment has no Redis, so the real probe honestly
    reports the bus dead and injects an URGENT "Autonomy paused" banner —
    which would skew the pre-existing source-merge/snooze assertions.
    test_loop_health_route.py covers the probe itself.
    """

    async def _none(self, org_id):
        return []

    monkeypatch.setattr(
        ImprovementCockpitAggregator, "_from_loop_health", _none
    )


def _mock_pg(*, fetch_rows: list | None = None) -> MagicMock:
    mock_pg = MagicMock()
    mock_pg.fetch = AsyncMock(return_value=fetch_rows if fetch_rows is not None else [])
    mock_pg.fetchrow = AsyncMock(return_value=None)
    mock_pg.execute = AsyncMock(return_value="OK")
    return mock_pg


@pytest.mark.asyncio
async def test_list_queue_merges_sources() -> None:
    issue = _Issue()
    mock_repo = MagicMock()
    mock_repo.list_issues = AsyncMock(return_value=[issue])

    cl_envelope = {
        "data": {
            "actions": [
                {
                    "id": "act_1",
                    "action_kind": "on_judge_improvement",
                    "severity": "medium",
                    "title": "Bump canary",
                    "status": "pending_approval",
                }
            ]
        }
    }
    mock_exec = MagicMock()
    mock_exec.list_pending = AsyncMock(return_value=cl_envelope)

    mock_pg = _mock_pg()

    mock_plans = [
        {
            "id": "plan_1",
            "agent_id": "agent_a",
            "title": "Fix loop in handler",
            "status": "pending_review",
            "plan_kind": "code_patch",
            "source_ref": "issue:i1",
        }
    ]

    mock_gate = MagicMock()
    mock_gate.list_queue = AsyncMock(return_value=[])

    with (
        patch("eden.issues.repo.IssuesRepo", return_value=mock_repo),
        patch(
            "eden.llmops.closed_loop_executor.ClosedLoopExecutor",
            return_value=mock_exec,
        ),
        patch(
            "eden.improvement.plans_repo.list_plans",
            new=AsyncMock(return_value=mock_plans),
        ),
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=mock_pg),
        ),
        patch(
            "eden.promotion.evidence_gate.EvidenceGate",
            return_value=mock_gate,
        ),
    ):
        queue = await ImprovementCockpitAggregator().list_queue("org_1")

    assert len(queue.items) == 3
    types = {i.item_type for i in queue.items}
    assert "issue_p0" in types
    assert "improvement_plan" in types
    columns = {i.column for i in queue.items}
    assert COLUMN_URGENT in columns
    assert COLUMN_PROPOSED in columns
    # M13: pending_review code_patch plans land in fix_now (not needs_you).
    assert COLUMN_FIX_NOW in columns


@pytest.mark.asyncio
async def test_list_queue_includes_proposed_patches() -> None:
    mock_repo = MagicMock()
    mock_repo.list_issues = AsyncMock(return_value=[])
    mock_exec = MagicMock()
    mock_exec.list_pending = AsyncMock(return_value={"data": {"actions": []}})
    mock_gate = MagicMock()
    mock_gate.list_queue = AsyncMock(return_value=[])

    patch_row = {
        "id": "patch_abc",
        "repo_id": "agent_a",
        "trace_id": "tr_1",
        "rca_id": "rca_1",
        "description": "Fix flaky retry",
        "status": "proposed",
        "created_at": datetime.now(UTC),
    }

    async def _fetch(query: str, *args: Any) -> list:
        if "FROM proposed_patches" in query:
            return [patch_row]
        return []

    mock_pg = _mock_pg()
    mock_pg.fetch = AsyncMock(side_effect=_fetch)

    with (
        patch("eden.issues.repo.IssuesRepo", return_value=mock_repo),
        patch(
            "eden.llmops.closed_loop_executor.ClosedLoopExecutor",
            return_value=mock_exec,
        ),
        patch(
            "eden.improvement.plans_repo.list_plans",
            new=AsyncMock(return_value=[]),
        ),
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=mock_pg),
        ),
        patch(
            "eden.promotion.evidence_gate.EvidenceGate",
            return_value=mock_gate,
        ),
    ):
        queue = await ImprovementCockpitAggregator().list_queue("org_1")

    assert len(queue.items) == 1
    item = queue.items[0]
    assert item.item_type == "proposed_patch"
    assert item.ref == "proposed_patch:patch_abc"
    assert item.href == "/improve"
    assert item.column == COLUMN_NEEDS_YOU
    assert item.source == "proposed_patches"

    # Approved patches land in verify.
    patch_row["status"] = "approved"
    with (
        patch("eden.issues.repo.IssuesRepo", return_value=mock_repo),
        patch(
            "eden.llmops.closed_loop_executor.ClosedLoopExecutor",
            return_value=mock_exec,
        ),
        patch(
            "eden.improvement.plans_repo.list_plans",
            new=AsyncMock(return_value=[]),
        ),
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=mock_pg),
        ),
        patch(
            "eden.promotion.evidence_gate.EvidenceGate",
            return_value=mock_gate,
        ),
    ):
        queue2 = await ImprovementCockpitAggregator().list_queue("org_1")
    assert queue2.items[0].column == COLUMN_VERIFY


@pytest.mark.asyncio
async def test_snooze_hides_item() -> None:
    item = ImprovementItem(
        ref="issue:x",
        item_type="issue",
        title="t",
        column=COLUMN_URGENT,
    )
    mock_pg = _mock_pg()
    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=mock_pg),
    ):
        await snooze_item("org_s", item.ref, datetime.now(UTC) + timedelta(hours=1))
        assert await is_snoozed("org_s", item.ref) is True
        mock_pg.execute.assert_awaited()

    mock_repo = MagicMock()
    mock_repo.list_issues = AsyncMock(return_value=[])
    mock_exec = MagicMock()
    mock_exec.list_pending = AsyncMock(return_value={"data": {"actions": []}})
    mock_gate = MagicMock()
    mock_gate.list_queue = AsyncMock(return_value=[])

    with (
        patch("eden.issues.repo.IssuesRepo", return_value=mock_repo),
        patch(
            "eden.llmops.closed_loop_executor.ClosedLoopExecutor",
            return_value=mock_exec,
        ),
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=mock_pg),
        ),
        patch(
            "eden.promotion.evidence_gate.EvidenceGate",
            return_value=mock_gate,
        ),
    ):
        # Inject via direct filter check — aggregator filters snoozed refs
        # that appear in source lists; empty sources → empty queue.
        queue = await ImprovementCockpitAggregator().list_queue("org_s")
    assert queue.items == []


@pytest.mark.asyncio
async def test_snooze_persists_and_reloads_from_postgres() -> None:
    until = datetime.now(UTC) + timedelta(hours=2)
    mock_pg = _mock_pg()

    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=mock_pg),
    ):
        await snooze_item("org_p", "issue:persist", until)
        sql = mock_pg.execute.await_args.args[0]
        assert "improvement_item_snoozes" in sql
        assert "ON CONFLICT" in sql

    # Simulate a fresh process: clear the in-memory cache, answer from PG.
    ca._SNOOZES.clear()
    mock_pg.fetchrow = AsyncMock(
        return_value={"snoozed_until": until}
    )
    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=mock_pg),
    ):
        assert await is_snoozed("org_p", "issue:persist") is True
        # Cache warmed from PG.
        assert ("org_p", "issue:persist") in ca._SNOOZES

    ca._SNOOZES.clear()
    mock_pg.fetch = AsyncMock(
        return_value=[{"item_ref": "issue:persist", "snoozed_until": until}]
    )
    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=mock_pg),
    ):
        refs = await active_snooze_refs("org_p")
    assert refs == {"issue:persist"}


@pytest.mark.asyncio
async def test_list_queue_filters_pg_snoozes() -> None:
    issue = _Issue(id="hidden", title="Snoozed issue")
    mock_repo = MagicMock()
    mock_repo.list_issues = AsyncMock(return_value=[issue])
    mock_exec = MagicMock()
    mock_exec.list_pending = AsyncMock(return_value={"data": {"actions": []}})
    mock_gate = MagicMock()
    mock_gate.list_queue = AsyncMock(return_value=[])

    until = datetime.now(UTC) + timedelta(hours=1)

    async def _fetch(query: str, *args: Any) -> list:
        if "FROM improvement_item_snoozes" in query:
            return [{"item_ref": "issue:hidden", "snoozed_until": until}]
        return []

    mock_pg = _mock_pg()
    mock_pg.fetch = AsyncMock(side_effect=_fetch)

    with (
        patch("eden.issues.repo.IssuesRepo", return_value=mock_repo),
        patch(
            "eden.llmops.closed_loop_executor.ClosedLoopExecutor",
            return_value=mock_exec,
        ),
        patch(
            "eden.improvement.plans_repo.list_plans",
            new=AsyncMock(return_value=[]),
        ),
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=mock_pg),
        ),
        patch(
            "eden.promotion.evidence_gate.EvidenceGate",
            return_value=mock_gate,
        ),
    ):
        queue = await ImprovementCockpitAggregator().list_queue("org_1")

    assert queue.items == []


def test_item_to_dict() -> None:
    item = ImprovementItem(
        ref="issue:1",
        item_type="issue",
        title="Hello",
        column=COLUMN_URGENT,
        severity="high",
    )
    d = item.to_dict()
    assert d["ref"] == "issue:1"
    assert d["column"] == COLUMN_URGENT
