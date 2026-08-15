"""Wave 6 trace_summaries — live-Postgres tests.

Same opt-in pattern as ``tests/unit/sessions/test_session_rollup.py``:
``Settings()`` is read directly (bypassing the autouse ``patch_settings``
redirect) and the whole module skips when Postgres is unreachable or the
table is missing. Every test works inside its own throwaway org id and
deletes its rows afterwards.

Covers:

* ``TraceSummaryIndexer.index_trace`` — recompute-then-upsert, idempotent
  (re-running derives the identical row), and the aggregate values match
  what ``list_traces`` computes from the same events.
* ``upsert_trace_placeholders`` — aggregate-free ON CONFLICT DO NOTHING
  (a re-run is a no-op; no double-count).
* The read shape — the materialized page query returns the same trace_id /
  cost / tokens as the legacy GROUP BY for the same events.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
from datetime import UTC, datetime, timedelta

import asyncpg
import pytest

from eden.observability.trace_summary import (
    TraceSummaryIndexer,
    upsert_trace_placeholders,
)

BASE_TS = datetime.now(UTC) - timedelta(hours=2)


async def _try_connect() -> asyncpg.Connection | None:
    from eden.config import Settings

    s = Settings()
    try:
        return await asyncio.wait_for(
            asyncpg.connect(
                host=s.postgres_host,
                port=s.postgres_port,
                user=s.postgres_user,
                password=s.postgres_password,
                database=s.postgres_db,
            ),
            timeout=5.0,
        )
    except Exception:
        return None


@pytest.fixture
async def pg_conn():
    conn = await _try_connect()
    if conn is None:
        pytest.skip("Postgres test database is not reachable")
    has_table = await conn.fetchval(
        "SELECT to_regclass('trace_summaries') IS NOT NULL"
    )
    if not has_table:
        pytest.skip("trace_summaries missing — run `alembic upgrade head`")
    yield conn
    await conn.close()


@pytest.fixture
async def org(pg_conn: asyncpg.Connection):
    org_id = f"org-ts-test-{uuid.uuid4().hex[:12]}"
    yield org_id
    for sql in (
        "DELETE FROM trace_summaries WHERE org_id = $1",
        "DELETE FROM telemetry_events WHERE tenant_id = $1",
    ):
        with contextlib.suppress(Exception):
            await pg_conn.execute(sql, org_id)


async def _seed_trace(
    conn: asyncpg.Connection,
    org_id: str,
    trace_id: str,
    n_spans: int = 3,
    *,
    outcome: str = "success",
    cost_usd: float = 0.0012,
    input_tokens: int = 120,
    output_tokens: int = 60,
    tags: list[str] | None = None,
) -> None:
    rows = []
    for s in range(n_spans):
        rows.append(
            (
                f"evt-{trace_id}-{s:02d}", org_id, "proj-1", trace_id,
                "production", "llm.completion",
                BASE_TS + timedelta(seconds=s), "agent-42",
                "gpt-4o-mini", float(s + 1) * 100.0,
                json.dumps({"input_tokens": input_tokens,
                            "output_tokens": output_tokens}),
                json.dumps({"cost_usd": cost_usd, "input_tokens": input_tokens}),
                json.dumps({"session_id": f"sess-{trace_id}"}),
                json.dumps(tags or []),
                outcome, "eden_native", "gpt-4o-mini", "unknown",
            )
        )
    await conn.copy_records_to_table(
        "telemetry_events",
        records=rows,
        columns=[
            "event_id", "tenant_id", "project_id", "trace_id", "realm",
            "event_type", "timestamp", "agent_id", "model", "duration_ms",
            "payload", "metrics", "attributes", "tags", "outcome",
            "source_format", "model_name", "provider_name",
        ],
    )


class TestIndexTrace:
    @pytest.mark.asyncio
    async def test_index_trace_materializes_aggregates(self, pg_conn, org):
        trace_id = f"t-{uuid.uuid4().hex[:10]}"
        await _seed_trace(pg_conn, org, trace_id, n_spans=3)

        indexer = TraceSummaryIndexer(client=pg_conn)
        ok = await indexer.index_trace(org, trace_id)
        assert ok is True

        row = await pg_conn.fetchrow(
            "SELECT * FROM trace_summaries WHERE org_id = $1 AND trace_id = $2",
            org, trace_id,
        )
        assert row is not None
        assert int(row["span_count"]) == 3
        assert int(row["input_tokens"]) == 120 * 3
        assert int(row["output_tokens"]) == 60 * 3
        assert abs(float(row["cost_usd"]) - 0.0012 * 3) < 1e-9
        assert row["outcome"] == "success"
        assert row["model"] == "gpt-4o-mini"
        assert row["session_id"] == f"sess-{trace_id}"
        assert row["started_at"] is not None
        assert row["duration_ms"] == 300.0  # max duration

    @pytest.mark.asyncio
    async def test_index_trace_is_idempotent(self, pg_conn, org):
        """A re-delivered finalize derives the identical row (no drift)."""
        trace_id = f"t-{uuid.uuid4().hex[:10]}"
        await _seed_trace(pg_conn, org, trace_id, n_spans=2)

        indexer = TraceSummaryIndexer(client=pg_conn)
        await indexer.index_trace(org, trace_id)
        await indexer.index_trace(org, trace_id)

        row = await pg_conn.fetchrow(
            "SELECT * FROM trace_summaries WHERE org_id = $1 AND trace_id = $2",
            org, trace_id,
        )
        assert int(row["span_count"]) == 2
        assert int(row["input_tokens"]) == 240
        assert abs(float(row["cost_usd"]) - 0.0024) < 1e-9

    @pytest.mark.asyncio
    async def test_index_trace_no_events_returns_false(self, pg_conn, org):
        indexer = TraceSummaryIndexer(client=pg_conn)
        ok = await indexer.index_trace(org, f"ghost-{uuid.uuid4().hex[:10]}")
        assert ok is False

    @pytest.mark.asyncio
    async def test_index_trace_agent_session_id_from_tag(self, pg_conn, org):
        trace_id = f"t-{uuid.uuid4().hex[:10]}"
        await _seed_trace(
            pg_conn, org, trace_id, n_spans=1,
            tags=["agent_session_id:asid-123", "cache_read"],
        )
        indexer = TraceSummaryIndexer(client=pg_conn)
        await indexer.index_trace(org, trace_id)
        row = await pg_conn.fetchrow(
            "SELECT agent_session_id, tags FROM trace_summaries "
            "WHERE org_id = $1 AND trace_id = $2",
            org, trace_id,
        )
        assert row["agent_session_id"] == "asid-123"
        assert "cache_read" in row["tags"]


class TestPlaceholders:
    @pytest.mark.asyncio
    async def test_placeholder_writes_and_is_noop_on_rerun(self, pg_conn, org):
        trace_id = f"t-{uuid.uuid4().hex[:10]}"
        await _seed_trace(pg_conn, org, trace_id, n_spans=1)

        class _Ev:
            def __init__(self, org_id, trace_id, ts):
                self.tenant_id = org_id
                self.trace_id = trace_id
                self.timestamp = ts

        ev = _Ev(org, trace_id, BASE_TS)
        n = await upsert_trace_placeholders([ev], client=pg_conn)
        assert n == 1

        row = await pg_conn.fetchrow(
            "SELECT * FROM trace_summaries WHERE org_id = $1 AND trace_id = $2",
            org, trace_id,
        )
        # Placeholder: no aggregates (so retried batches can't double-count).
        assert int(row["span_count"]) == 0
        assert float(row["cost_usd"]) == 0.0
        assert row["started_at"] is not None

        # Re-run is a no-op.
        n2 = await upsert_trace_placeholders([ev], client=pg_conn)
        assert n2 == 1  # executemany processed the row; conflict did nothing
        row2 = await pg_conn.fetchrow(
            "SELECT span_count FROM trace_summaries WHERE org_id = $1 AND trace_id = $2",
            org, trace_id,
        )
        assert int(row2["span_count"]) == 0

    @pytest.mark.asyncio
    async def test_placeholder_then_index_full_row(self, pg_conn, org):
        """The indexer replaces the placeholder with the full aggregates."""
        trace_id = f"t-{uuid.uuid4().hex[:10]}"
        await _seed_trace(pg_conn, org, trace_id, n_spans=3)

        class _Ev:
            def __init__(self, org_id, trace_id, ts):
                self.tenant_id = org_id
                self.trace_id = trace_id
                self.timestamp = ts

        await upsert_trace_placeholders([_Ev(org, trace_id, BASE_TS)], client=pg_conn)
        await TraceSummaryIndexer(client=pg_conn).index_trace(org, trace_id)

        row = await pg_conn.fetchrow(
            "SELECT * FROM trace_summaries WHERE org_id = $1 AND trace_id = $2",
            org, trace_id,
        )
        assert int(row["span_count"]) == 3
        assert int(row["input_tokens"]) == 360


class TestReadShape:
    @pytest.mark.asyncio
    async def test_summaries_match_legacy_aggregation(self, pg_conn, org):
        """Materialized row == what the list page's GROUP BY would produce."""
        trace_id = f"t-{uuid.uuid4().hex[:10]}"
        await _seed_trace(
            pg_conn, org, trace_id, n_spans=2,
            cost_usd=0.0005, input_tokens=50, output_tokens=25,
        )
        await TraceSummaryIndexer(client=pg_conn).index_trace(org, trace_id)

        legacy = await pg_conn.fetchrow(
            """
            SELECT count(*) AS span_count,
                   sum(coalesce(
                       NULLIF(metrics->>'cost_usd', '')::float,
                       NULLIF(payload->>'cost_usd', '')::float,
                       NULLIF(attributes->>'cost_usd', '')::float
                   )) AS cost_usd,
                   sum(coalesce((NULLIF(payload->>'input_tokens', ''))::numeric,
                                usage_prompt_tokens, 0)) AS input_tokens,
                   max(duration_ms) AS duration_ms
            FROM telemetry_events
            WHERE tenant_id = $1 AND trace_id = $2
            """,
            org, trace_id,
        )
        mat = await pg_conn.fetchrow(
            "SELECT * FROM trace_summaries WHERE org_id = $1 AND trace_id = $2",
            org, trace_id,
        )
        assert int(legacy["span_count"]) == int(mat["span_count"])
        assert abs(float(legacy["cost_usd"]) - float(mat["cost_usd"])) < 1e-9
        assert int(legacy["input_tokens"]) == int(mat["input_tokens"])
        assert float(legacy["duration_ms"]) == float(mat["duration_ms"])

    @pytest.mark.asyncio
    async def test_list_page_query_orders_by_started_at_desc(self, pg_conn, org):
        t1 = f"t-{uuid.uuid4().hex[:10]}"
        t2 = f"t-{uuid.uuid4().hex[:10]}"
        # t2 started earlier; t1 later → t1 should sort first.
        await _seed_trace(pg_conn, org, t2, n_spans=1)
        await _seed_trace(pg_conn, org, t1, n_spans=1)
        indexer = TraceSummaryIndexer(client=pg_conn)
        await indexer.index_trace(org, t1)
        await indexer.index_trace(org, t2)

        rows = await pg_conn.fetch(
            "SELECT trace_id FROM trace_summaries "
            "WHERE org_id = $1 ORDER BY started_at DESC LIMIT 10",
            org,
        )
        assert [r["trace_id"] for r in rows] == [t1, t2]
