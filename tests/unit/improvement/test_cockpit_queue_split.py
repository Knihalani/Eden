"""M13 (§6.2) — cockpit Fix now / Improve later queue split."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from eden.improvement.cockpit_aggregator import (
    COLUMN_FIX_NOW,
    COLUMN_IMPROVE_LATER,
    ImprovementCockpitAggregator,
    _plan_is_stale,
    _queue_column_for_plan,
    is_fix_now_item,
)


def test_queue_column_code_patch_with_evidence_is_fix_now() -> None:
    col = _queue_column_for_plan(
        "code_patch",
        {"issue_id": "i1", "evidence_tier": "static", "ev_score": 5.0},
    )
    assert col == COLUMN_FIX_NOW


def test_queue_column_advisory_is_improve_later() -> None:
    assert _queue_column_for_plan("advisory", {}) == COLUMN_IMPROVE_LATER
    assert _queue_column_for_plan("config_change", {}) == COLUMN_IMPROVE_LATER


def test_plan_is_stale_after_days() -> None:
    old = {
        "created_at": (datetime.now(UTC) - timedelta(days=20)).isoformat(),
    }
    fresh = {
        "created_at": (datetime.now(UTC) - timedelta(days=2)).isoformat(),
    }
    assert _plan_is_stale(old, 14) is True
    assert _plan_is_stale(fresh, 14) is False


@pytest.mark.asyncio
async def test_from_improvement_plans_splits_queues() -> None:
    rows: list[dict[str, Any]] = [
        {
            "id": "p1",
            "title": "Fix loop",
            "status": "draft",
            "plan_kind": "code_patch",
            "agent_id": "a1",
            "source_ref": "issue:1",
            "evidence": {"issue_id": "1", "evidence_tier": "static"},
            "created_at": datetime.now(UTC).isoformat(),
        },
        {
            "id": "p2",
            "title": "Cost digest",
            "status": "draft",
            "plan_kind": "advisory",
            "agent_id": "a1",
            "source_ref": "cost:1",
            "evidence": {},
            "created_at": datetime.now(UTC).isoformat(),
        },
        {
            "id": "p3",
            "title": "Stale draft",
            "status": "draft",
            "plan_kind": "prompt_update",
            "agent_id": "a1",
            "source_ref": "issue:3",
            "evidence": {"issue_id": "3"},
            "created_at": (datetime.now(UTC) - timedelta(days=20)).isoformat(),
        },
    ]
    with patch(
        "eden.improvement.plans_repo.list_plans",
        AsyncMock(return_value=rows),
    ):
        items = await ImprovementCockpitAggregator()._from_improvement_plans(
            "org", None
        )
    by_id = {i.payload["plan_id"]: i for i in items}
    assert by_id["p1"].column == COLUMN_FIX_NOW
    assert by_id["p2"].column == COLUMN_IMPROVE_LATER
    assert by_id["p3"].column == COLUMN_FIX_NOW
    assert by_id["p3"].payload.get("stale") is True
    assert is_fix_now_item(by_id["p1"]) is True
    assert is_fix_now_item(by_id["p2"]) is False


@pytest.mark.asyncio
async def test_slack_skips_improve_later_by_default() -> None:
    from eden.services.slack_notify import notify_needs_approval

    with patch(
        "eden.services.slack_notify._send", AsyncMock(return_value={"status": "ok"})
    ) as send:
        skipped = await notify_needs_approval(
            "org",
            plan_id="p-adv",
            title="Advisory",
            kind="advisory",
        )
        ok = await notify_needs_approval(
            "org",
            plan_id="p-code",
            title="Patch",
            kind="code_patch",
        )
    assert skipped["status"] == "skipped"
    assert ok["status"] == "ok" or send.await_count == 1
