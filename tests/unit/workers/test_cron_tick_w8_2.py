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
async def test_tick_skips_eql_and_demotion():
    """Legacy cron entrypoint must not double-fire worker-owned loops."""
    with (
        patch.object(
            cron_tick, "_once_per_window", AsyncMock(return_value=True)
        ),
        patch.object(cron_tick, "datetime") as mock_dt,
    ):
        mock_dt.now.return_value = _fixed_now(hour=1, minute=30)
        out = await cron_tick._tick(dry_run=False)

    assert "eql_alert_watchdog" not in out
    assert "artifact_demotion" not in out
    assert out["improvement_sweeps"]["skipped"] is True


@pytest.mark.asyncio
async def test_compaction_failure_recorded_in_hourly_window():
    with (
        patch.object(
            cron_tick,
            "_run_columnar_compaction",
            AsyncMock(side_effect=RuntimeError("compact boom")),
        ),
        patch.object(
            cron_tick,
            "_run_shadow_outcome_join",
            AsyncMock(return_value={"ok": True}),
        ),
        patch.object(
            cron_tick, "_once_per_window", AsyncMock(return_value=True)
        ),
        patch.object(
            cron_tick, "_release_window", AsyncMock()
        ) as release,
        patch.object(cron_tick, "datetime") as mock_dt,
    ):
        mock_dt.now.return_value = _fixed_now(hour=5, minute=5)
        out = await cron_tick._tick(dry_run=False)

    assert "errors" in out["columnar_compaction"]
    assert "compact boom" in out["columnar_compaction"]["errors"][0]
    release.assert_awaited()


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
async def test_improvement_sweeps_skipped_issue_driven_only():
    """Sweeps stay off — drafts come from identified issues only."""
    with (
        patch.object(
            cron_tick, "_once_per_window", AsyncMock(return_value=True)
        ),
        patch.object(cron_tick, "datetime") as mock_dt,
    ):
        mock_dt.now.return_value = _fixed_now(hour=1, minute=30)
        out = await cron_tick._tick(dry_run=True)

    assert out["improvement_sweeps"]["skipped"] is True
    assert "issue_driven" in out["improvement_sweeps"]["reason"]


@pytest.mark.asyncio
async def test_shadow_failure_recorded_without_demotion():
    """Demotion is worker-owned; maintenance still records shadow errors."""
    with (
        patch.object(
            cron_tick,
            "_run_shadow_outcome_join",
            AsyncMock(side_effect=RuntimeError("shadow boom")),
        ),
        patch.object(
            cron_tick, "_run_mcp_rollup", AsyncMock(return_value={})
        ),
        patch.object(
            cron_tick, "_run_classifier_retrain", AsyncMock(return_value={})
        ),
        patch.object(
            cron_tick, "_run_signal_backfill", AsyncMock(return_value={})
        ),
        patch.object(
            cron_tick, "_run_signal_cluster_quiet", AsyncMock(return_value={})
        ),
        patch.object(
            cron_tick, "_once_per_window", AsyncMock(return_value=True)
        ),
        patch.object(cron_tick, "_release_window", AsyncMock()),
        patch.object(cron_tick, "datetime") as mock_dt,
    ):
        mock_dt.now.return_value = _fixed_now(hour=1, minute=30)
        out = await cron_tick._tick(dry_run=False)

    assert "artifact_demotion" not in out
    assert "shadow boom" in out["shadow_outcome_join"]["errors"][0]


@pytest.mark.asyncio
async def test_signal_worker_failures_recorded_separately():
    with (
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
        patch.object(
            cron_tick, "_once_per_window", AsyncMock(return_value=True)
        ),
        patch.object(cron_tick, "_release_window", AsyncMock()),
        patch.object(cron_tick, "datetime") as mock_dt,
    ):
        # minute % 10 < 5 → signal window
        mock_dt.now.return_value = _fixed_now(hour=1, minute=3)
        out = await cron_tick._tick(dry_run=False)

    assert "backfill boom" in out["signal_backfill"]["errors"][0]
    assert out["signal_cluster_quiet"] == {"resolved": 1}


@pytest.mark.asyncio
async def test_maintenance_skips_sibling_keys_when_slot_claimed():
    """Classifier + signal siblings share skip metadata with their slot."""
    with (
        patch.object(
            cron_tick, "_once_per_window", AsyncMock(return_value=False)
        ),
        patch.object(
            cron_tick,
            "_run_columnar_compaction",
            AsyncMock(return_value={"compacted": 1}),
        ) as compact,
        patch.object(
            cron_tick,
            "_run_shadow_outcome_join",
            AsyncMock(return_value={"joined": 1}),
        ) as shadow,
        patch.object(
            cron_tick, "_run_mcp_rollup", AsyncMock(return_value={})
        ) as mcp,
        patch.object(
            cron_tick, "_run_classifier_retrain", AsyncMock(return_value={})
        ) as clf,
        patch.object(
            cron_tick, "_run_signal_backfill", AsyncMock(return_value={})
        ) as backfill,
        patch.object(
            cron_tick, "_run_signal_cluster_quiet", AsyncMock(return_value={})
        ) as quiet,
    ):
        # minute=0 hits compact + mcp(15) + shadow + signal(10) windows.
        out = await cron_tick.run_maintenance_due(
            now=_fixed_now(hour=5, minute=0), dry_run=False
        )

    assert out["columnar_compaction"]["skipped"] is True
    assert out["shadow_outcome_join"]["skipped"] is True
    assert out["mcp_rollup"]["skipped"] is True
    assert out["classifier_retrain"]["skipped"] is True
    assert out["signal_backfill"]["skipped"] is True
    assert out["signal_cluster_quiet"]["skipped"] is True
    compact.assert_not_awaited()
    shadow.assert_not_awaited()
    mcp.assert_not_awaited()
    clf.assert_not_awaited()
    backfill.assert_not_awaited()
    quiet.assert_not_awaited()


@pytest.mark.asyncio
async def test_maintenance_runs_due_steps_concurrently():
    """Independent due steps are gathered, not strictly serial."""
    with (
        patch.object(
            cron_tick, "_once_per_window", AsyncMock(return_value=True)
        ),
        patch.object(
            cron_tick,
            "_run_columnar_compaction",
            AsyncMock(return_value={"ok": True}),
        ),
        patch.object(
            cron_tick,
            "_run_shadow_outcome_join",
            AsyncMock(return_value={"joined": 2}),
        ),
        patch.object(
            cron_tick, "_run_mcp_rollup", AsyncMock(return_value={"rolled": 1})
        ),
        patch.object(
            cron_tick, "_run_classifier_retrain", AsyncMock(return_value={})
        ),
        patch.object(
            cron_tick, "_run_signal_backfill", AsyncMock(return_value={})
        ),
        patch.object(
            cron_tick,
            "_run_signal_cluster_quiet",
            AsyncMock(return_value={"resolved": 0}),
        ),
    ):
        out = await cron_tick.run_maintenance_due(
            now=_fixed_now(hour=5, minute=0), dry_run=False
        )

    assert out["columnar_compaction"] == {"ok": True}
    assert out["shadow_outcome_join"] == {"joined": 2}
    assert out["mcp_rollup"] == {"rolled": 1}
    assert out["improvement_sweeps"]["skipped"] is True



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


def test_orphaned_watchdog_and_sweep_helpers_removed():
    """EQL watchdog / improvement sweeps / artifact demotion are hosted on
    ``eden-worker`` now (see module docstring) and were never called from
    ``_tick`` / ``run_maintenance_due``. They were dead code and were
    removed; this guards against them silently creeping back in without
    also being wired up and tested.
    """
    for name in (
        "_run_eql_alert_watchdog",
        "_run_improvement_sweeps",
        "_run_artifact_demotion",
    ):
        assert not hasattr(cron_tick, name), (
            f"{name} reappeared in cron_tick but is not called by _tick() "
            "or run_maintenance_due() — wire it up or keep it deleted."
        )


# ── Redis write-discard fallback (2026-07-29) ────────────────────────


@pytest.mark.asyncio
async def test_once_per_window_fails_open_when_redis_drops_writes():
    """A refused SET NX with NOTHING holding the key means the write was
    silently discarded (Upstash past its plan limit serves reads and
    drops writes), not that another process claimed the window.

    Reading that as "already claimed" made every gated maintenance job --
    retention_cron, the Typesense TTL sweep, auto_curator, drift_baselines,
    mcp_rollup, classifier_retrain, shadow_outcome_join, signal_backfill --
    skip forever while the tick still reported success, which is the shape
    of the July 2026 silent outage.
    """
    fake_redis = MagicMock()
    fake_redis.set = AsyncMock(return_value=None)   # refused
    fake_redis.get = AsyncMock(return_value=None)   # ...but nobody holds it

    with patch(
        "eden.storage.redis.get_redis_client",
        AsyncMock(return_value=fake_redis),
    ):
        allowed = await cron_tick._once_per_window("retention_cron", ttl_seconds=3600)

    assert allowed is True, (
        "SET NX refused with no holder must fail OPEN -- the write was "
        "dropped, not contended"
    )
    fake_redis.get.assert_awaited_once()


@pytest.mark.asyncio
async def test_once_per_window_still_skips_on_genuine_contention():
    """The fail-open path must not defeat the actual de-duplication:
    when the key IS held, this process must stand down.
    """
    fake_redis = MagicMock()
    fake_redis.set = AsyncMock(return_value=None)   # refused
    fake_redis.get = AsyncMock(return_value="1")    # someone genuinely holds it

    with patch(
        "eden.storage.redis.get_redis_client",
        AsyncMock(return_value=fake_redis),
    ):
        allowed = await cron_tick._once_per_window("retention_cron", ttl_seconds=3600)

    assert allowed is False, (
        "a genuinely held window must still suppress the duplicate run"
    )


@pytest.mark.asyncio
async def test_once_per_window_claims_window_on_success():
    """The happy path must not pay for the extra GET."""
    fake_redis = MagicMock()
    fake_redis.set = AsyncMock(return_value=True)
    fake_redis.get = AsyncMock(return_value=None)

    with patch(
        "eden.storage.redis.get_redis_client",
        AsyncMock(return_value=fake_redis),
    ):
        allowed = await cron_tick._once_per_window("retention_cron", ttl_seconds=3600)

    assert allowed is True
    fake_redis.get.assert_not_awaited()
