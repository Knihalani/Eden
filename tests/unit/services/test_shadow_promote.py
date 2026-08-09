"""M13 (§6.5) — shadow detector promote / delete thresholds."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.services.soft_issue_review import (
    _SHADOW_PROMOTE_BATCH_LIMIT,
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


@pytest.mark.asyncio
async def test_promote_shadow_detectors_uses_fair_per_org_sql_and_higher_limit() -> None:
    """OPT-26: weekly batch exceeds creation throughput and round-robins orgs."""
    pg = MagicMock()
    pg.fetch = AsyncMock(return_value=[])
    pg.execute = AsyncMock()

    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=pg),
    ):
        await SoftIssueReviewer().promote_shadow_detectors()

    sql = pg.fetch.await_args.args[0]
    assert "ROW_NUMBER() OVER" in sql
    assert "PARTITION BY org_id" in sql
    assert "ORDER BY rn ASC" in sql
    assert pg.fetch.await_args.args[1] == _SHADOW_PROMOTE_BATCH_LIMIT
    assert _SHADOW_PROMOTE_BATCH_LIMIT > 200


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


# ── OPT-37: stale hold-state shadow detectors expire ─────────────────


def test_stale_hold_below_min_firings_expires_to_delete() -> None:
    now = datetime(2026, 8, 7, tzinfo=UTC)
    stale_created = now - timedelta(days=100)
    row = {
        "match_count": 2,
        "rule": {},
        "created_at": stale_created,
        "updated_at": stale_created,
    }
    d = evaluate_shadow_precision(
        row,
        min_firings=20,
        hold_max_days=90,
        now=now,
    )
    assert d["action"] == "delete"
    assert d["hold_age_days"] == pytest.approx(100.0)


def test_recent_hold_below_min_firings_stays_hold() -> None:
    now = datetime(2026, 8, 7, tzinfo=UTC)
    recent = now - timedelta(days=10)
    row = {
        "match_count": 2,
        "rule": {},
        "created_at": recent,
        "updated_at": recent,
    }
    d = evaluate_shadow_precision(
        row,
        min_firings=20,
        hold_max_days=90,
        now=now,
    )
    assert d["action"] == "hold"


@pytest.mark.asyncio
async def test_promote_shadow_detectors_deletes_stale_hold_rows() -> None:
    now = datetime(2026, 8, 7, tzinfo=UTC)
    stale_row = {
        "id": "cccccccc-cccc-cccc-cccc-cccccccccccc",
        "org_id": "org-1",
        "description": "[auto:a] stale",
        "cluster_id": "auto:stale",
        "match_count": 1,
        "rule": {},
        "created_at": now - timedelta(days=120),
        "updated_at": now - timedelta(days=120),
    }
    pg = MagicMock()
    pg.fetch = AsyncMock(return_value=[stale_row])
    pg.execute = AsyncMock()

    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=pg),
        ),
        patch(
            "eden.services.soft_issue_review._notify_shadow_promoted",
            AsyncMock(),
        ),
    ):
        result = await SoftIssueReviewer().promote_shadow_detectors()

    assert result["deleted"] == 1
    assert result["promoted"] == 0
    delete_sql = pg.execute.await_args.args[0]
    assert "DELETE FROM nl_signals" in delete_sql


# ── FEAT-155: end-to-end-ish feedback → promote/delete behavior ─────


class _ShadowDetectorStore:
    """In-memory nl_signals stand-in — feedback persists, weekly sweep reads it."""

    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows: dict[str, dict[str, Any]] = {
            str(r["id"]): {**r, "rule": dict(r.get("rule") or {})} for r in rows
        }
        self.deleted: set[str] = set()
        self.promoted: set[str] = set()

    async def fetchrow(self, sql: str, *args: Any) -> dict[str, Any] | None:
        sig_id, org_id, bump_c, bump_d = args[0], args[1], args[2], args[3]
        row = self._rows.get(str(sig_id))
        if row is None or row.get("org_id") != org_id or sig_id in self.deleted:
            return None
        rule = dict(row.get("rule") or {})
        rule["operator_confirms"] = int(rule.get("operator_confirms", 0)) + int(
            bump_c
        )
        rule["operator_dismisses"] = int(rule.get("operator_dismisses", 0)) + int(
            bump_d
        )
        updated = {**row, "rule": rule}
        self._rows[str(sig_id)] = updated
        return updated

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        return [
            dict(r)
            for r in self._rows.values()
            if r["id"] not in self.deleted and not r.get("enabled")
        ]

    async def execute(self, sql: str, *args: Any) -> None:
        sig_id = str(args[0])
        if "DELETE FROM nl_signals" in sql:
            self.deleted.add(sig_id)
        elif "enabled = TRUE" in sql:
            self.promoted.add(sig_id)
            if sig_id in self._rows:
                self._rows[sig_id]["enabled"] = True


@pytest.mark.asyncio
async def test_confirm_feedback_then_weekly_promote_causal_chain() -> None:
    """Operator confirm persists → ``promote_shadow_detectors`` promotes on
    the next sweep (not just ``evaluate_shadow_precision`` in isolation)."""
    sig_id = "dddddddd-dddd-dddd-dddd-dddddddddddd"
    store = _ShadowDetectorStore(
        [
            {
                "id": sig_id,
                "org_id": "org-1",
                "description": "[auto:a] almost there",
                "cluster_id": "auto:almost",
                "match_count": 19,
                "enabled": False,
                "rule": {
                    "operator_confirms": 17,
                    "operator_dismisses": 2,
                    "firings": 19,
                },
            }
        ]
    )
    before = evaluate_shadow_precision(store._rows[sig_id])
    assert before["action"] == "hold"

    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=store),
    ):
        ok = await record_shadow_feedback("org-1", sig_id, confirm=True)
        assert ok is True
        with patch(
            "eden.services.soft_issue_review._notify_shadow_promoted",
            AsyncMock(),
        ):
            result = await SoftIssueReviewer().promote_shadow_detectors()

    after = evaluate_shadow_precision(store._rows[sig_id])
    assert after["action"] == "promote"
    assert result["promoted"] == 1
    assert sig_id in store.promoted


@pytest.mark.asyncio
async def test_dismiss_feedback_then_weekly_noop_after_inline_delete() -> None:
    """Inline dismiss delete removes the row — weekly sweep is a no-op."""
    sig_id = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"
    store = _ShadowDetectorStore(
        [
            {
                "id": sig_id,
                "org_id": "org-1",
                "description": "[auto:a] sliding bad",
                "cluster_id": "auto:slide",
                "match_count": 19,
                "enabled": False,
                "rule": {
                    "operator_confirms": 4,
                    "operator_dismisses": 15,
                    "firings": 19,
                },
            }
        ]
    )
    assert evaluate_shadow_precision(store._rows[sig_id])["action"] == "hold"

    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=store),
    ):
        ok = await record_shadow_feedback("org-1", sig_id, dismiss=True)
        assert ok is True
        assert sig_id in store.deleted
        result = await SoftIssueReviewer().promote_shadow_detectors()

    assert result["promoted"] == 0
    assert result["deleted"] == 0


@pytest.mark.asyncio
async def test_dismiss_feedback_accumulates_to_inline_delete_threshold() -> None:
    """Repeated dismiss feedback crosses delete precision inline — counters
    persist between calls (causal chain, not one-shot helper math)."""
    sig_id = "ffffffff-ffff-ffff-ffff-ffffffffffff"
    store = _ShadowDetectorStore(
        [
            {
                "id": sig_id,
                "org_id": "org-1",
                "description": "[auto:a] borderline",
                "cluster_id": "auto:border",
                "match_count": 19,
                "enabled": False,
                "rule": {
                    "operator_confirms": 6,
                    "operator_dismisses": 13,
                    "firings": 19,
                },
            }
        ]
    )
    assert evaluate_shadow_precision(store._rows[sig_id])["action"] == "hold"

    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=store),
    ):
        await record_shadow_feedback("org-1", sig_id, dismiss=True)
        assert sig_id not in store.deleted
        assert evaluate_shadow_precision(store._rows[sig_id])["action"] == "hold"

        await record_shadow_feedback("org-1", sig_id, dismiss=True)
        assert sig_id in store.deleted
