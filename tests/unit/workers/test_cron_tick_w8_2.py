"""Wave 8.2 — cron_tick failure logging / isolation (not silent)."""

from __future__ import annotations

import sys
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.workers import cron_tick


def _fixed_now(*, hour: int = 0, minute: int = 0, weekday: int = 1) -> datetime:
    """Build a UTC datetime with a controllable weekday (Mon=0 … Sun=6)."""
    # 2026-07-20 is a Monday.
    return datetime(2026, 7, 20, hour, minute, tzinfo=UTC) + timedelta(days=weekday)


@pytest.mark.asyncio
async def test_eql_alert_failure_recorded_not_raised():
    """Alert watchdog exceptions become ``errors`` in the tick result."""
    with (
        patch.object(
            cron_tick,
            "_run_eql_alert_watchdog",
            AsyncMock(side_effect=RuntimeError("alert boom")),
        ),
        patch.object(
            cron_tick,
            "_run_improvement_sweeps",
            AsyncMock(return_value={"orgs": []}),
        ),
        patch.object(cron_tick, "datetime") as mock_dt,
    ):
        mock_dt.now.return_value = _fixed_now(hour=1, minute=30)
        out = await cron_tick._tick(dry_run=False)

    assert "errors" in out["eql_alert_watchdog"]
    assert "alert boom" in out["eql_alert_watchdog"]["errors"][0]
    assert out["improvement_sweeps"] == {"orgs": []}


@pytest.mark.asyncio
async def test_compaction_failure_recorded_in_hourly_window():
    with (
        patch.object(
            cron_tick,
            "_run_eql_alert_watchdog",
            AsyncMock(return_value={"fired": 0}),
        ),
        patch.object(
            cron_tick,
            "_run_columnar_compaction",
            AsyncMock(side_effect=RuntimeError("compact boom")),
        ),
        patch.object(
            cron_tick,
            "_run_improvement_sweeps",
            AsyncMock(return_value={"orgs": []}),
        ),
        patch.object(
            cron_tick,
            "_run_artifact_demotion",
            AsyncMock(return_value={"ok": True}),
        ),
        patch.object(
            cron_tick,
            "_run_shadow_outcome_join",
            AsyncMock(return_value={"ok": True}),
        ),
        patch.object(cron_tick, "datetime") as mock_dt,
    ):
        mock_dt.now.return_value = _fixed_now(hour=5, minute=5)
        out = await cron_tick._tick(dry_run=False)

    assert "errors" in out["columnar_compaction"]
    assert "compact boom" in out["columnar_compaction"]["errors"][0]


@pytest.mark.asyncio
async def test_retention_daily_isolates_failures():
    """Daily retention + typesense each record their own errors."""

    async def _bad_retention(*, dry_run: bool):
        raise RuntimeError("retention boom")

    async def _bad_typesense(*, dry_run: bool):
        raise RuntimeError("typesense boom")

    with (
        patch(
            "eden.data_platform.retention_cron.run",
            side_effect=_bad_retention,
        ),
        patch.object(
            cron_tick,
            "_run_typesense_ttl_cleanup",
            side_effect=_bad_typesense,
        ),
    ):
        out = await cron_tick._run_daily(
            _fixed_now(hour=3, minute=0), dry_run=False
        )

    assert "retention boom" in out["retention_cron"]["errors"][0]
    assert "typesense boom" in out["typesense_ttl_cleanup"]["errors"][0]


@pytest.mark.asyncio
async def test_improvement_sweeps_failure_recorded():
    with (
        patch.object(
            cron_tick,
            "_run_eql_alert_watchdog",
            AsyncMock(return_value={"skipped": True}),
        ),
        patch.object(
            cron_tick,
            "_run_improvement_sweeps",
            AsyncMock(side_effect=RuntimeError("sweep boom")),
        ),
        patch.object(cron_tick, "datetime") as mock_dt,
    ):
        mock_dt.now.return_value = _fixed_now(hour=1, minute=30)
        out = await cron_tick._tick(dry_run=True)

    assert "sweep boom" in out["improvement_sweeps"]["errors"][0]


@pytest.mark.asyncio
async def test_artifact_and_shadow_failures_isolated():
    """One evolution worker failure must not silence the other."""
    with (
        patch.object(
            cron_tick,
            "_run_eql_alert_watchdog",
            AsyncMock(return_value={"fired": 0}),
        ),
        patch.object(
            cron_tick,
            "_run_improvement_sweeps",
            AsyncMock(return_value={"orgs": []}),
        ),
        patch.object(
            cron_tick,
            "_run_artifact_demotion",
            AsyncMock(side_effect=RuntimeError("demote boom")),
        ),
        patch.object(
            cron_tick,
            "_run_shadow_outcome_join",
            AsyncMock(return_value={"joined": 3}),
        ),
        patch.object(cron_tick, "datetime") as mock_dt,
    ):
        mock_dt.now.return_value = _fixed_now(hour=1, minute=30)
        out = await cron_tick._tick(dry_run=False)

    assert "demote boom" in out["artifact_demotion"]["errors"][0]
    assert out["shadow_outcome_join"] == {"joined": 3}


@pytest.mark.asyncio
async def test_signal_worker_failures_recorded_separately():
    with (
        patch.object(
            cron_tick,
            "_run_eql_alert_watchdog",
            AsyncMock(return_value={"fired": 0}),
        ),
        patch.object(
            cron_tick,
            "_run_improvement_sweeps",
            AsyncMock(return_value={"orgs": []}),
        ),
        patch.object(
            cron_tick,
            "_run_artifact_demotion",
            AsyncMock(return_value={}),
        ),
        patch.object(
            cron_tick,
            "_run_shadow_outcome_join",
            AsyncMock(return_value={}),
        ),
        patch.object(
            cron_tick,
            "_run_signal_backfill",
            AsyncMock(side_effect=RuntimeError("backfill boom")),
        ),
        patch.object(
            cron_tick,
            "_run_signal_cluster_quiet",
            AsyncMock(return_value={"resolved": 1}),
        ),
        patch.object(cron_tick, "datetime") as mock_dt,
    ):
        # minute % 10 < 5 → signal window
        mock_dt.now.return_value = _fixed_now(hour=1, minute=3)
        out = await cron_tick._tick(dry_run=False)

    assert "backfill boom" in out["signal_backfill"]["errors"][0]
    assert out["signal_cluster_quiet"] == {"resolved": 1}


@pytest.mark.asyncio
async def test_auto_curator_queries_org_id_column():
    """organizations PK is ``id`` — wrong column made curator always fail."""
    pg = MagicMock()
    pg.fetch = AsyncMock(return_value=[])

    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=pg),
        ),
        patch(
            "eden.evaluation.auto_curator.AutoCurator",
            return_value=MagicMock(),
        ),
    ):
        await cron_tick._run_auto_curator()

    sql = pg.fetch.await_args.args[0]
    assert "FROM organizations" in sql
    assert "id::text" in sql
    assert "org_id::text" not in sql


@pytest.mark.asyncio
async def test_auto_curator_isolates_per_org_failures():
    pg = MagicMock()
    pg.fetch = AsyncMock(
        return_value=[{"org_id": "a"}, {"org_id": "b"}, {"org_id": "c"}]
    )

    curator = MagicMock()

    async def _run(oid: str):
        if oid == "b":
            raise RuntimeError("curator boom")
        return {"org_id": oid, "ok": True}

    curator.run_for_org = AsyncMock(side_effect=_run)

    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=pg),
        ),
        patch(
            "eden.evaluation.auto_curator.AutoCurator",
            return_value=curator,
        ),
    ):
        out = await cron_tick._run_auto_curator()

    assert out["orgs"] == 3
    assert out["error_count"] == 1
    assert out["runs"][0] == {"org_id": "a", "ok": True}
    assert out["runs"][1] == {"org_id": "b", "errors": ["curator boom"]}
    assert out["runs"][2] == {"org_id": "c", "ok": True}


@pytest.mark.asyncio
async def test_safe_step_never_raises():
    async def _boom():
        raise ValueError("nope")

    result = await cron_tick._safe_step("x", _boom())
    assert result == {"errors": ["nope"]}


def test_main_once_returns_zero_when_tick_raises(monkeypatch):
    """Northflank must not flap: once-mode swallows tick exceptions, exit 0."""

    async def _boom(*, dry_run: bool):
        raise RuntimeError("tick boom")

    monkeypatch.setattr(cron_tick, "_tick", _boom)
    monkeypatch.setattr(sys, "argv", ["cron_tick", "--once", "--dry-run"])
    assert cron_tick.main() == 0


def test_main_once_returns_zero_on_success(monkeypatch):
    async def _ok(*, dry_run: bool):
        return {"ok": True}

    monkeypatch.setattr(cron_tick, "_tick", _ok)
    monkeypatch.setattr(sys, "argv", ["cron_tick", "--once", "--dry-run"])
    assert cron_tick.main() == 0
