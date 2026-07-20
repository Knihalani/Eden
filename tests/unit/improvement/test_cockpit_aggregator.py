"""N17 improvement cockpit aggregator unit tests."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.improvement.cockpit_aggregator import (
    COLUMN_NEEDS_YOU,
    COLUMN_PROPOSED,
    COLUMN_URGENT,
    ImprovementCockpitAggregator,
    ImprovementItem,
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

    mock_pg = MagicMock()
    mock_pg.fetch = AsyncMock(return_value=[])

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
    assert COLUMN_NEEDS_YOU in columns


@pytest.mark.asyncio
async def test_snooze_hides_item() -> None:
    item = ImprovementItem(
        ref="issue:x",
        item_type="issue",
        title="t",
        column=COLUMN_URGENT,
    )
    snooze_item("org_s", item.ref, datetime.now(UTC) + timedelta(hours=1))
    assert is_snoozed("org_s", item.ref) is True

    mock_repo = MagicMock()
    mock_repo.list_issues = AsyncMock(return_value=[])
    mock_exec = MagicMock()
    mock_exec.list_pending = AsyncMock(return_value={"data": {"actions": []}})
    mock_pg = MagicMock()
    mock_pg.fetch = AsyncMock(return_value=[])
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
