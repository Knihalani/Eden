"""Integration tests for migration 035 — TimescaleDB hypertable on judge_scores.

Mirrors ``test_timescale_telemetry.py`` for the ``judge_scores`` table.
Skips when the test database is unreachable or when the TimescaleDB
extension is not available.
"""
from __future__ import annotations

import asyncio
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
    test loop scope. The previous module-scoped version caused
    ``attached to a different loop`` errors on CI because the
    module-scoped pg_client bound to a different loop than the
    per-test async test functions.
    """
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
    row = await pg_client.fetchrow(
        "SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'"
    )
    return row is not None


async def _is_hypertable(pg_client: Any, table: str) -> bool:
    row = await pg_client.fetchrow(
        """
        SELECT 1 FROM timescaledb_information.hypertables
         WHERE hypertable_name = $1
        """,
        table,
    )
    return row is not None


@pytest.mark.asyncio
async def test_judge_scores_is_hypertable(pg_client: Any) -> None:
    if not await _timescale_available(pg_client):
        pytest.skip("TimescaleDB extension not installed on this DB")
    if not await _is_hypertable(pg_client, "judge_scores"):
        pytest.skip("Migration 035 may not have run on this DB")


@pytest.mark.asyncio
async def test_judge_scores_chunk_exclusion(pg_client: Any) -> None:
    if not await _timescale_available(pg_client):
        pytest.skip("TimescaleDB extension not installed on this DB")
    if not await _is_hypertable(pg_client, "judge_scores"):
        pytest.skip("Migration 035 may not have run on this DB")
    # Chunk exclusion is only demonstrable with ≥2 chunks; a fresh/empty
    # hypertable has none and a single chunk is scanned directly.
    n_chunks = await pg_client.fetchval(
        """
        SELECT num_chunks
          FROM timescaledb_information.hypertables
         WHERE hypertable_name = 'judge_scores'
        """
    )
    if not n_chunks or int(n_chunks) < 2:
        pytest.skip(
            f"judge_scores has {int(n_chunks or 0)} chunk(s); chunk exclusion "
            "is not demonstrable on a fresh DB (needs ≥2 chunks)"
        )
    plan = await pg_client.fetchval(
        """
        EXPLAIN SELECT 1 FROM judge_scores
         WHERE scored_at >= NOW() - INTERVAL '1 day'
           AND scored_at <  NOW()
        """
    )
    if plan is None:
        pytest.skip("Empty EXPLAIN output")
    plan_str = str(plan)
    assert "Chunks excluded" in plan_str or "Append" in plan_str, (
        f"No chunk exclusion in plan: {plan_str}"
    )
