"""M13 (§6.5) — shadow detector promote / delete thresholds."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.services.soft_issue_review import (
    SoftIssueReviewer,
    evaluate_shadow_precision,
    record_shadow_feedback,
)


def _row(
    *,
    confirms: int = 0,
    dismisses: int = 0,
    firings: int | None = None,
    match_count: int = 0,
) -> dict[str, Any]:
    labeled = confirms + dismisses
    return {
        "id": "sig-1",
        "org_id": "org-1",
        "description": "[auto:a] re-asks",
        "cluster_id": "auto:abc",
        "match_count": match_count,
        "rule": {
            "operator_confirms": confirms,
            "operator_dismisses": dismisses,
            "firings": firings if firings is not None else max(labeled, match_count),
        },
    }


def test_promote_when_precision_ge_0_8_and_firings_ge_20() -> None:
    # 18 confirm / 2 dismiss = 0.9 over 20
    d = evaluate_shadow_precision(
        _row(confirms=18, dismisses=2, firings=20),
        min_firings=20,
        promote_precision=0.8,
        delete_precision=0.3,
    )
    assert d["action"] == "promote"
    assert d["precision"] == pytest.approx(0.9)


def test_delete_when_precision_lt_0_3_and_firings_ge_20() -> None:
    # 4 confirm / 16 dismiss = 0.2
    d = evaluate_shadow_precision(
        _row(confirms=4, dismisses=16, firings=20),
        min_firings=20,
        promote_precision=0.8,
        delete_precision=0.3,
    )
    assert d["action"] == "delete"
    assert d["precision"] == pytest.approx(0.2)


def test_hold_below_min_firings() -> None:
    d = evaluate_shadow_precision(
        _row(confirms=9, dismisses=1, firings=10),
        min_firings=20,
    )
    assert d["action"] == "hold"


def test_hold_without_operator_labels() -> None:
    # match_count alone must not auto-promote
    d = evaluate_shadow_precision(
        _row(confirms=0, dismisses=0, match_count=100),
        min_firings=20,
    )
    assert d["action"] == "hold"
    assert d["precision"] is None


@pytest.mark.asyncio
async def test_promote_shadow_detectors_enables_and_deletes() -> None:
    promote_row = {
        "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "org_id": "org-1",
        "description": "[auto:a] good",
        "cluster_id": "auto:good",
        "match_count": 25,
        "rule": {
            "operator_confirms": 20,
            "operator_dismisses": 2,
            "firings": 25,
        },
    }
    delete_row = {
        "id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        "org_id": "org-1",
        "description": "[auto:a] bad",
        "cluster_id": "auto:bad",
        "match_count": 25,
        "rule": {
            "operator_confirms": 2,
            "operator_dismisses": 20,
            "firings": 25,
        },
    }
    pg = MagicMock()
    pg.fetch = AsyncMock(return_value=[promote_row, delete_row])
    pg.execute = AsyncMock()

    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=pg),
        ),
        patch(
            "eden.services.soft_issue_review._notify_shadow_promoted",
            AsyncMock(),
        ) as notify,
    ):
        result = await SoftIssueReviewer().promote_shadow_detectors()

    assert result["promoted"] == 1
    assert result["deleted"] == 1
    notify.assert_awaited_once()
    # One UPDATE (enable) + one DELETE
    assert pg.execute.await_count == 2
    enable_sql = pg.execute.await_args_list[0].args[0]
    delete_sql = pg.execute.await_args_list[1].args[0]
    assert "enabled = TRUE" in enable_sql
    assert "DELETE FROM nl_signals" in delete_sql


# ── FEAT-29 P0-C: dismiss made consequential without the weekly job ──────


@pytest.mark.asyncio
async def test_record_shadow_feedback_dismiss_auto_deletes_at_threshold() -> None:
    """A dismiss that pushes a shadow detector past the same delete
    threshold the weekly sweep uses (min_firings=20, precision<0.3) must
    remove it immediately, not wait for promote_shadow_detectors()."""
    updated_row = {
        "id": "sig-1",
        "org_id": "org-1",
        "description": "[auto:a] bad",
        "cluster_id": "auto:bad",
        "match_count": 20,
        "enabled": False,
        "rule": {
            "operator_confirms": 4,
            "operator_dismisses": 16,
            "firings": 20,
        },
    }
    pg = MagicMock()
    pg.fetchrow = AsyncMock(return_value=updated_row)
    pg.execute = AsyncMock()

    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=pg),
    ):
        ok = await record_shadow_feedback("org-1", "sig-1", dismiss=True)

    assert ok is True
    pg.execute.assert_awaited_once()
    delete_sql = pg.execute.await_args.args[0]
    assert "DELETE FROM nl_signals" in delete_sql
    assert pg.execute.await_args.args[1] == "sig-1"
    assert pg.execute.await_args.args[2] == "org-1"


@pytest.mark.asyncio
async def test_record_shadow_feedback_dismiss_below_threshold_no_delete() -> None:
    """Below min_firings, dismiss just bumps the counter — no auto-delete."""
    updated_row = {
        "id": "sig-2",
        "org_id": "org-1",
        "description": "[auto:a] undecided",
        "cluster_id": "auto:undecided",
        "match_count": 3,
        "enabled": False,
        "rule": {
            "operator_confirms": 0,
            "operator_dismisses": 3,
            "firings": 3,
        },
    }
    pg = MagicMock()
    pg.fetchrow = AsyncMock(return_value=updated_row)
    pg.execute = AsyncMock()

    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=pg),
    ):
        ok = await record_shadow_feedback("org-1", "sig-2", dismiss=True)

    assert ok is True
    pg.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_record_shadow_feedback_dismiss_already_promoted_no_delete() -> None:
    """A detector that was already promoted (enabled=True) is out of scope
    for the inline auto-disable — matches the weekly sweep's own
    `enabled = FALSE` scan filter, left to normal operator management."""
    updated_row = {
        "id": "sig-3",
        "org_id": "org-1",
        "description": "[auto:a] promoted-then-dismissed",
        "cluster_id": "auto:promoted",
        "match_count": 30,
        "enabled": True,
        "rule": {
            "operator_confirms": 2,
            "operator_dismisses": 28,
            "firings": 30,
        },
    }
    pg = MagicMock()
    pg.fetchrow = AsyncMock(return_value=updated_row)
    pg.execute = AsyncMock()

    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=pg),
    ):
        ok = await record_shadow_feedback("org-1", "sig-3", dismiss=True)

    assert ok is True
    pg.execute.assert_not_awaited()
