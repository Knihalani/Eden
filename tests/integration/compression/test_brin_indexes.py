"""Integration tests for migration 030 — BRIN indexes on time-series tables.

Verifies the BRIN indexes from migration 030 exist and that the planner can
use them for time-range queries. Skips when the test database is unreachable.
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest


# (table, timestamp_column, expected_index_name)
_BRIN_TARGETS = [
    ("usage_events", "created_at", "idx_brin_usage_events_created_at"),
    ("telemetry_events", "timestamp", "idx_brin_telemetry_events_timestamp"),
    ("judge_scores", "scored_at", "idx_brin_judge_scores_scored_at"),
    # retrieval_logs is optional — it's defined in raw SQL outside alembic.
    ("retrieval_logs", "created_at", "idx_brin_retrieval_logs_created_at"),
]


async def _try_get_pool():
    """Return an asyncpg connection pool, or None if Postgres is unreachable."""
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
        await asyncio.wait_for(client.initialize(), timeout=3.0)
    except Exception:
        return None
    return client


@pytest.fixture(scope="module")
def event_loop():
    """Override the function-scoped event loop fixture with a module-scoped
    one so the connection pool can be reused across all tests in this file.
    """
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="module")
async def pg_client():
    """Module-scoped PostgresClient. Skips the module if no DB is reachable."""
    client = await _try_get_pool()
    if client is None:
        pytest.skip("Postgres test database is not reachable")
    yield client
    await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("table,column,index_name", _BRIN_TARGETS)
async def test_brin_index_exists(
    pg_client: Any, table: str, column: str, index_name: str
) -> None:
    """Each BRIN index from migration 030 must exist in pg_indexes."""
    row = await pg_client.fetchrow(
        """
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = $1
           AND indexname = $2
        """,
        table,
        index_name,
    )
    if row is None:
        # Skip if the table itself is missing (retrieval_logs is raw-SQL).
        table_row = await pg_client.fetchrow(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema='public' AND table_name=$1",
            table,
        )
        if table_row is None:
            pytest.skip(f"Table {table!r} does not exist on this DB (raw-SQL not applied)")
        pytest.fail(f"BRIN index {index_name!r} missing on {table!r}")


@pytest.mark.asyncio
@pytest.mark.parametrize("table,column,index_name", _BRIN_TARGETS)
async def test_brin_index_uses_correct_columns(
    pg_client: Any, table: str, column: str, index_name: str
) -> None:
    """The BRIN index must be defined on the right timestamp column."""
    rows = await pg_client.fetch(
        """
        SELECT a.attname
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_attribute a ON a.attrelid = c.oid
         WHERE c.relname = $1
           AND i.indnatts = 1
        """,
        index_name,
    )
    if not rows:
        # Index missing — skip if the table itself is missing.
        table_row = await pg_client.fetchrow(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema='public' AND table_name=$1",
            table,
        )
        if table_row is None:
            pytest.skip(f"Table {table!r} does not exist on this DB")
        pytest.fail(f"BRIN index {index_name!r} missing")
    column_names = [r["attname"] for r in rows]
    assert column_names == [column], (
        f"BRIN index {index_name!r} on {table!r} has columns {column_names}, "
        f"expected [{column!r}]"
    )


@pytest.mark.asyncio
async def test_brin_index_size_is_small(pg_client: Any) -> None:
    """BRIN indexes must be < 1 MB on an empty/small test DB.

    This is the headline benefit: a 500M-row B-tree on a timestamp column is
    ~12 GB, the BRIN equivalent is ~2 MB. On a fresh test DB we just assert
    it's small (a few pages).
    """
    rows = await pg_client.fetch(
        """
        SELECT c.relname,
               pg_size_pretty(pg_relation_size(c.oid)) AS size,
               pg_relation_size(c.oid)                  AS bytes
          FROM pg_class c
         WHERE c.relname LIKE 'idx_brin_%'
        """
    )
    assert rows, "No BRIN indexes found — migration 030 may not have run"
    for row in rows:
        # 8 KB (one page) is the minimum; 1 MB is a generous ceiling.
        assert row["bytes"] < 1_048_576, (
            f"BRIN index {row['relname']!r} is {row['size']} (>1 MB); "
            "either physical correlation is poor or the index is broken"
        )


@pytest.mark.asyncio
async def test_brin_planner_uses_index(pg_client: Any) -> None:
    """EXPLAIN of a time-range query should mention the BRIN index."""
    # The query is against telemetry_events since it's the largest table and
    # most likely to trigger the planner to consider the BRIN index.
    plan = await pg_client.fetchval(
        """
        EXPLAIN SELECT 1 FROM telemetry_events
         WHERE "timestamp" > NOW() - INTERVAL '7 days'
        """
    )
    if plan is None:
        pytest.skip("telemetry_events has no rows; planner output empty")
    # The plan is a single string with newlines; check it contains the BRIN idx.
    assert "idx_brin_telemetry_events_timestamp" in str(plan), (
        f"BRIN index not in plan: {plan}"
    )
