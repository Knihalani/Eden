"""Measure the 'unfinalized traces' fallback leg vs the materialized read.

Decides the read-path design for Wave 6 trace_summaries: if the page read
uses the materialized table, what does it cost to also surface traces that
have NO summary row yet (in-flight / never-finalized)? Options:

  A. Anti-join leg: full GROUP BY over telemetry_events in the window,
     restricted to trace_ids NOT IN trace_summaries. Correct, but costs a
     full window scan every page load.
  B. Placeholder rows written at ingest (INSERT ... ON CONFLICT DO NOTHING
     per distinct trace_id per batch) + full recompute at finalize. Then the
     read is 100% the materialized table and the supplement is zero.

Run: uv run python -m bench.trace_summaries_fallback
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from datetime import UTC, datetime, timedelta

import asyncpg

DB = "eden"
USER = "eden"
PASSWORD = "eden_dev_password"
HOST = "localhost"
PORT = 5432

_LEGACY = """
SELECT trace_id FROM telemetry_events
WHERE tenant_id = $1 AND timestamp >= $2
GROUP BY trace_id
"""

_LEGACY_ANTI_JOIN = """
SELECT e.trace_id FROM telemetry_events e
WHERE e.tenant_id = $1 AND e.timestamp >= $2
  AND NOT EXISTS (
      SELECT 1 FROM trace_summaries_fb ts
      WHERE ts.org_id = $1 AND ts.trace_id = e.trace_id
  )
GROUP BY e.trace_id
"""


async def best(conn, sql: str, *args) -> float:
    ts = []
    for _ in range(3):
        s = time.perf_counter()
        await conn.fetch(sql, *args)
        ts.append(time.perf_counter() - s)
    return min(ts)


async def main() -> None:
    conn = await asyncpg.connect(host=HOST, port=PORT, user=USER,
                                 password=PASSWORD, database=DB)
    org = f"org-tb-fb-{uuid.uuid4().hex[:10]}"
    since = datetime.now(UTC) - timedelta(days=7)
    n_traces, spans = 20000, 6

    rows = []
    batch = 2000
    cols = [
        "event_id", "tenant_id", "project_id", "trace_id", "realm",
        "event_type", "timestamp", "agent_id", "model", "duration_ms",
        "payload", "metrics", "attributes", "tags", "outcome",
        "source_format", "model_name", "provider_name",
    ]
    for i in range(n_traces):
        tid = f"trace-{i:07d}"
        ts = since + timedelta(seconds=i * 7)
        for s in range(spans):
            rows.append((
                f"evt-{i:07d}-{s:02d}", org, "proj-1", tid, "production",
                "llm.completion", ts + timedelta(seconds=s), "agent-42",
                "gpt-4o-mini", s,
                json.dumps({"input_tokens": 100 + s, "output_tokens": 50 + s}),
                json.dumps({"cost_usd": 0.0002}),
                json.dumps({"session_id": f"sess-{i % 200:04d}"}),
                json.dumps(["cache_read"]), "success", "eden_native",
                "gpt-4o-mini", "unknown",
            ))
        if len(rows) >= batch:
            await conn.copy_records_to_table("telemetry_events", records=rows,
                                             columns=cols)
            rows = []
    if rows:
        await conn.copy_records_to_table("telemetry_events", records=rows,
                                         columns=cols)
    await conn.execute("ANALYZE telemetry_events")
    print(f"seeded {n_traces:,} traces x {spans} spans")

    # Full coverage: every trace finalized → summary row exists.
    await conn.execute(
        """
        CREATE TABLE trace_summaries_fb (
            org_id TEXT NOT NULL,
            trace_id TEXT NOT NULL,
            started_at TIMESTAMPTZ,
            PRIMARY KEY (org_id, trace_id)
        )
        """
    )
    await conn.execute(
        "INSERT INTO trace_summaries_fb (org_id, trace_id, started_at) "
        "SELECT $1, trace_id, min(timestamp) FROM telemetry_events "
        "WHERE tenant_id = $1 GROUP BY trace_id",
        org,
    )
    await conn.execute("ANALYZE trace_summaries_fb")

    full_legacy = await best(conn, _LEGACY, org, since)
    anti_join = await best(conn, _LEGACY_ANTI_JOIN, org, since)
    print(f"  legacy GROUP BY (full window):  {full_legacy*1e3:.1f} ms")
    print(f"  anti-join leg (0 unfinalized):  {anti_join*1e3:.1f} ms")
    print(f"  anti-join still pays a full-window scan: {anti_join/full_legacy*100:.0f}% of legacy cost")

    # Sparse coverage: only 10% of traces have summary rows (cold start).
    await conn.execute("TRUNCATE trace_summaries_fb")
    await conn.execute(
        "INSERT INTO trace_summaries_fb (org_id, trace_id, started_at) "
        "SELECT $1, trace_id, min(timestamp) FROM telemetry_events "
        "WHERE tenant_id = $1 AND trace_id LIKE 'trace-0%' GROUP BY trace_id",
        org,
    )
    await conn.execute("ANALYZE trace_summaries_fb")
    anti_join_10 = await best(conn, _LEGACY_ANTI_JOIN, org, since)
    print(f"  anti-join leg (10% covered):    {anti_join_10*1e3:.1f} ms")

    # Placeholder write cost: the ingest-time INSERT ... ON CONFLICT DO
    # NOTHING per distinct trace_id in a batch of 200 events.
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS trace_summaries_fb_ph (
            org_id TEXT NOT NULL,
            trace_id TEXT NOT NULL,
            started_at TIMESTAMPTZ,
            span_count BIGINT NOT NULL DEFAULT 0,
            PRIMARY KEY (org_id, trace_id)
        )
        """
    )
    trace_ids = await conn.fetch(
        "SELECT trace_id, min(timestamp) AS ts FROM telemetry_events "
        "WHERE tenant_id = $1 AND trace_id LIKE 'trace-1%' "
        "GROUP BY trace_id ORDER BY trace_id LIMIT 200",
        org,
    )
    s = time.perf_counter()
    await conn.executemany(
        "INSERT INTO trace_summaries_fb_ph (org_id, trace_id, started_at) "
        "VALUES ($1, $2, $3) ON CONFLICT (org_id, trace_id) DO NOTHING",
        [(org, r["trace_id"], r["ts"]) for r in trace_ids],
    )
    ph_cost = time.perf_counter() - s
    print(f"  placeholder upsert, 200 traces:  {ph_cost*1e3:.2f} ms "
          f"({ph_cost/len(trace_ids)*1e6:.0f} µs/trace)")

    await conn.execute("DELETE FROM telemetry_events WHERE tenant_id = $1", org)
    await conn.execute("DROP TABLE IF EXISTS trace_summaries_fb")
    await conn.execute("DROP TABLE IF EXISTS trace_summaries_fb_ph")
    await conn.close()
    print("cleanup done")


if __name__ == "__main__":
    asyncio.run(main())
