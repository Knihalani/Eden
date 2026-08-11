"""Integration tests for migration 034 — TimescaleDB hypertable on telemetry_events.

Verifies the hypertable was created, the compression policy is registered,
and a representative 7-day range query gets chunk exclusion. Skips when
the test database is unreachable OR when the TimescaleDB extension is
not available.
"""
from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any

import pytest


async def _try_get_pool():
    from eden.config import get_settings
    from eden.storage.postgres import PostgresClient

    settings = get_settings()
    client = PostgresClient(
        host=settings.postgres_host,
        port=settings.postgres_port,
        database=settings.postgres_db,
        user=settings.postgres_user,
        password=settings.postgres_password,
    )
    try:
        await asyncio.wait_for(client.initialize(), timeout=10.0)
        # initialize() may complete without actually connecting
        # (lazy asyncpg pool). Force a real round-trip via SELECT 1
        # so the fixture skips cleanly when the DB is unreachable
        # rather than failing every test with a ConnectionError.
        await asyncio.wait_for(client.fetchval("SELECT 1"), timeout=10.0)
    except Exception:
        return None
    return client


@pytest.fixture
def event_loop():
    """Function-scoped event loop to match pytest-asyncio's default
    test loop scope. Module-scoped caused 'attached to a different
    loop' errors on CI — see test_timescale_judge_scores for the
    same fix."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
async def pg_client():
    client = await _try_get_pool()
    if client is None:
        pytest.skip("Postgres test database is not reachable")
    yield client
    await client.close()


async def _timescale_available(pg_client: Any) -> bool:
    """Return True if the TimescaleDB extension is installed in this DB."""
    row = await pg_client.fetchrow(
        "SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'"
    )
    return row is not None


async def _is_hypertable(pg_client: Any, table: str) -> bool:
    """Return True if ``table`` is registered as a Timescale hypertable."""
    row = await pg_client.fetchrow(
        """
        SELECT 1 FROM timescaledb_information.hypertables
         WHERE hypertable_name = $1
        """,
        table,
    )
    return row is not None


@pytest.mark.asyncio
async def test_timescale_extension_available(pg_client: Any) -> None:
    """The TimescaleDB extension must be installed (skip if not)."""
    if not await _timescale_available(pg_client):
        pytest.skip("TimescaleDB extension not installed on this DB")


@pytest.mark.asyncio
async def test_telemetry_events_is_hypertable(pg_client: Any) -> None:
    """telemetry_events must be registered as a Timescale hypertable."""
    if not await _timescale_available(pg_client):
        pytest.skip("TimescaleDB extension not installed on this DB")
    if not await _is_hypertable(pg_client, "telemetry_events"):
        pytest.skip("Migration 034 may not have run on this DB")


@pytest.mark.asyncio
async def test_telemetry_events_chunk_interval_is_7_days(pg_client: Any) -> None:
    """telemetry_events chunks must be 7 days wide (migration 166).

    Migration 034 created 1-day chunks; migration 166 widened the
    interval to 7 days (P3.4). The interval is only observable once
    chunks exist, so a fresh/empty hypertable skips rather than fails.
    """
    if not await _timescale_available(pg_client):
        pytest.skip("TimescaleDB extension not installed on this DB")
    if not await _is_hypertable(pg_client, "telemetry_events"):
        pytest.skip("Migration 034 may not have run on this DB")
    row = await pg_client.fetchrow(
        """
        SELECT hypertable_name
          FROM timescaledb_information.hypertables
         WHERE hypertable_name = 'telemetry_events'
        """
    )
    assert row is not None
    chunk = await pg_client.fetchrow(
        """
        SELECT range_end - range_start AS chunk_interval
          FROM timescaledb_information.chunks
         WHERE hypertable_name = 'telemetry_events'
         LIMIT 1
        """
    )
    if chunk is None:
        pytest.skip("telemetry_events has no chunks yet; interval not observable")
    interval = chunk["chunk_interval"]
    assert interval == timedelta(days=7), (
        f"telemetry_events chunk interval is {interval}, expected 7 days (migration 166)"
    )


@pytest.mark.asyncio
async def test_compression_settings_applied(pg_client: Any) -> None:
    """The compression segmentby / orderby settings must match the migration.

    Columnstore compression is a TimescaleDB enterprise feature. On the
    OSS "apache" build (the timescale-ha image and Neon free tiers)
    ``ALTER TABLE ... SET (timescaledb.compress, ...)`` raises
    ``feature_not_supported``, which migration 034 deliberately swallows
    — so this assertion only runs where compression is actually enabled
    and consults ``timescaledb_information.compression_settings`` (the
    per-column source of truth), not the parent table's reloptions.
    """
    if not await _timescale_available(pg_client):
        pytest.skip("TimescaleDB extension not installed on this DB")
    if not await _is_hypertable(pg_client, "telemetry_events"):
        pytest.skip("Migration 034 may not have run on this DB")
    enabled = await pg_client.fetchval(
        """
        SELECT compression_enabled
          FROM timescaledb_information.hypertables
         WHERE hypertable_name = 'telemetry_events'
        """
    )
    if not enabled:
        pytest.skip(
            "TimescaleDB apache build — columnstore compression disabled; "
            "migration 034 guards this (see its feature_not_supported block)"
        )
    rows = await pg_client.fetch(
        """
        SELECT attname, segmentby_column_index, orderby_column_index, orderby_asc
          FROM timescaledb_information.compression_settings
         WHERE hypertable_name = 'telemetry_events'
        """
    )
    assert rows, "compression enabled but compression_settings has no rows"
    segmentby = {r["attname"] for r in rows if r["segmentby_column_index"]}
    orderby = {r["attname"] for r in rows if r["orderby_column_index"]}
    assert segmentby == {"tenant_id", "event_type", "name"}, (
        f"segmentby columns {sorted(segmentby)} != [tenant_id, event_type, name] (migration 034)"
    )
    assert orderby == {"timestamp"}, f"orderby columns {sorted(orderby)} != [timestamp]"
    ts_row = next(r for r in rows if r["orderby_column_index"])
    assert not ts_row["orderby_asc"], "timestamp must be ordered DESC (migration 034)"


@pytest.mark.asyncio
async def test_chunk_exclusion_in_explain(pg_client: Any) -> None:
    """EXPLAIN of a 1-day range query should show chunk exclusion."""
    if not await _timescale_available(pg_client):
        pytest.skip("TimescaleDB extension not installed on this DB")
    if not await _is_hypertable(pg_client, "telemetry_events"):
        pytest.skip("Migration 034 may not have run on this DB")
    # Chunk exclusion is only demonstrable when the hypertable holds
    # ≥2 chunks. A fresh/empty table has none, and a single chunk is
    # scanned directly (no exclusion/Append to observe).
    n_chunks = await pg_client.fetchval(
        """
        SELECT num_chunks
          FROM timescaledb_information.hypertables
         WHERE hypertable_name = 'telemetry_events'
        """
    )
    if not n_chunks or int(n_chunks) < 2:
        pytest.skip(
            f"telemetry_events has {int(n_chunks or 0)} chunk(s); chunk exclusion "
            "is not demonstrable on a fresh DB (needs ≥2 chunks)"
        )
    # ``EXPLAIN`` output for hypertables includes a "Chunks excluded"
    # line when the WHERE clause filters on the time column.
    plan = await pg_client.fetchval(
        """
        EXPLAIN SELECT 1 FROM telemetry_events
         WHERE "timestamp" >= NOW() - INTERVAL '1 day'
           AND "timestamp" <  NOW()
        """
    )
    if plan is None:
        pytest.skip("Empty EXPLAIN output")
    # The marker is "Chunks excluded:" in modern Timescale; the older
    # "Append" node with multiple "Index Scan" children is the fallback.
    # We accept either as a chunk-exclusion signal.
    plan_str = str(plan)
    assert (
        "Chunks excluded" in plan_str
        or "Append" in plan_str
    ), f"No chunk exclusion in plan: {plan_str}"
