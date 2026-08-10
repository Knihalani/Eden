"""Benchmark: dashboard summary — live telemetry_events aggregation vs trace_summaries.

Proves the Wave 7 claim: ``observability_summary`` fires 7 full-window
aggregations over ``telemetry_events`` per dashboard load (totals,
percentiles, failure modes, tools, hot paths, model cost). With
``trace_summaries`` materialized (one row per trace, Wave 6), the headline
metrics — total_traces, error count/rate, latency percentiles, total cost,
and the per-model cost/token breakdown — are computable from that indexed
table instead. The two panel queries that need raw events (failure modes,
tools) are excluded here because they genuinely need span-level data.

Run against the local dev Postgres. Synthetic data in a throwaway org,
deleted at the end.

Usage:
    uv run python -m bench.dashboard_summary [--traces 20000 --spans 6]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
import uuid
from datetime import UTC, datetime, timedelta

import asyncpg

ORG = f"org-dash-bench-{uuid.uuid4().hex[:10]}"
DB = "eden"
USER = "eden"
PASSWORD = "eden_dev_password"
HOST = "localhost"
PORT = 5432

# The live aggregation shapes observability_summary runs (see observability.py).
_TOTALS_SQL = """
SELECT count(*) AS total_events,
       count(DISTINCT trace_id) AS total_traces,
       sum(CASE WHEN error_type IS NOT NULL
                OR (attributes ? 'error') THEN 1 ELSE 0 END) AS errors
FROM telemetry_events WHERE tenant_id = $1 AND timestamp >= $2
"""
_PCT_SQL = """
SELECT percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms) AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99,
       coalesce(sum(coalesce(
         NULLIF(metrics->>'cost_usd','')::float,
         NULLIF(payload->>'cost_usd','')::float,
         NULLIF(attributes->>'cost_usd','')::float,
         0)), 0) AS cost
FROM telemetry_events WHERE tenant_id = $1 AND timestamp >= $2
"""
_MODEL_SQL = """
SELECT coalesce(model, model_name, attributes->>'model',
                attributes->>'openai.model', attributes->>'anthropic.model') AS model,
       count(*) AS calls,
       coalesce(sum(coalesce(
         NULLIF(metrics->>'cost_usd','')::float,
         NULLIF(payload->>'cost_usd','')::float,
         NULLIF(attributes->>'cost_usd','')::float,
         0)), 0) AS cost_usd
FROM telemetry_events WHERE tenant_id = $1 AND timestamp >= $2
  AND event_type = 'llm_call'
GROUP BY 1
"""
# Materialized equivalents over trace_summaries (one row per trace).
_MAT_TOTALS_SQL = """
SELECT count(*) AS total_traces,
       sum(CASE WHEN outcome != 'success' THEN 1 ELSE 0 END) AS errors
FROM trace_summaries WHERE org_id = $1 AND started_at >= $2
"""
_MAT_PCT_SQL = """
SELECT percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms) AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99,
       coalesce(sum(cost_usd), 0) AS cost
FROM trace_summaries WHERE org_id = $1 AND started_at >= $2
"""
_MAT_MODEL_SQL = """
SELECT model, count(*) AS traces, coalesce(sum(cost_usd), 0) AS cost_usd
FROM trace_summaries WHERE org_id = $1 AND started_at >= $2
  AND model IS NOT NULL
GROUP BY 1
"""


async def seed(conn: asyncpg.Connection, traces: int, spans: int) -> None:
    now = datetime.now(UTC)
    for t in range(traces):
        tid = f"dash-trace-{t:06d}"
        base = now - timedelta(seconds=t)
        for s in range(spans):
            await conn.execute(
                """
                INSERT INTO telemetry_events (
                    event_id, tenant_id, project_id, trace_id, realm,
                    event_type, timestamp, agent_id, model, duration_ms,
                    payload, metrics, attributes, tags, outcome,
                    source_format, model_name, provider_name
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
                """,
                f"evt-{t}-{s}", ORG, "proj", tid, "production",
                "llm.completion" if s == 0 else "tool_call",
                base + timedelta(seconds=s),
                f"agent-{t % 20}", "gpt-4o-mini", float(s + 1) * 100.0,
                json.dumps({"input_tokens": 120, "output_tokens": 60}),
                json.dumps({"cost_usd": 0.0012}),
                json.dumps({}),
                json.dumps([]),
                "success" if t % 20 else "error",
                "eden_native", "gpt-4o-mini", "openai",
            )
    # Materialize the summaries exactly as the Wave 6 indexer would.
    await conn.execute(
        """
        INSERT INTO trace_summaries (
            org_id, trace_id, started_at, realm, agent_id, model, provider,
            session_id, outcome, error_type, attr_error, agent_session_id,
            input_tokens, output_tokens, cost_usd, span_count, duration_ms, tags
        )
        SELECT tenant_id, trace_id, min(timestamp), max(realm),
               coalesce(max(agent_id), max(attributes->>'agent_id')),
               coalesce(max(model), max(model_name)),
               coalesce(max(provider_name), max(attributes->>'provider')),
               coalesce(max(session_id), max(attributes->>'session_id')),
               max(outcome), max(error_type), max(attributes->>'error'),
               NULL,
               sum(coalesce((NULLIF(payload->>'input_tokens',''))::numeric,
                            usage_prompt_tokens, 0)),
               sum(coalesce((NULLIF(payload->>'output_tokens',''))::numeric,
                            usage_completion_tokens, 0)),
               sum(coalesce(NULLIF(metrics->>'cost_usd','')::float,
                            NULLIF(payload->>'cost_usd','')::float,
                            NULLIF(attributes->>'cost_usd','')::float)),
               count(*), max(duration_ms), ARRAY[]::text[]
        FROM telemetry_events
        WHERE tenant_id = $1
        GROUP BY tenant_id, trace_id
        """,
        ORG,
    )


async def bench(conn: asyncpg.Connection, since: datetime) -> None:
    # Live path: 3 of the 7 queries (the ones trace_summaries can serve).
    live: dict[str, float] = {}
    for name, sql in (("totals", _TOTALS_SQL), ("pct", _PCT_SQL), ("model", _MODEL_SQL)):
        t0 = time.perf_counter()
        for _ in range(5):
            await conn.fetch(sql, ORG, since)
        live[name] = (time.perf_counter() - t0) / 5 * 1000

    mat: dict[str, float] = {}
    for name, sql in (("totals", _MAT_TOTALS_SQL), ("pct", _MAT_PCT_SQL), ("model", _MAT_MODEL_SQL)):
        t0 = time.perf_counter()
        for _ in range(5):
            await conn.fetch(sql, ORG, since)
        mat[name] = (time.perf_counter() - t0) / 5 * 1000

    live_total = sum(live.values())
    mat_total = sum(mat.values())
    print(f"=== dashboard summary: live aggregation vs trace_summaries ===")
    for name in ("totals", "pct", "model"):
        print(f"  {name:6s}  live: {live[name]:7.2f} ms   mat: {mat[name]:7.3f} ms   "
              f"speedup: {live[name] / mat[name]:6.1f}x")
    print(f"  TOTAL  live: {live_total:7.2f} ms   mat: {mat_total:7.3f} ms   "
          f"speedup: {live_total / mat_total:6.1f}x")


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--traces", type=int, default=20000)
    parser.add_argument("--spans", type=int, default=6)
    args = parser.parse_args()

    conn = await asyncpg.connect(
        host=HOST, port=PORT, user=USER, password=PASSWORD, database=DB
    )
    try:
        has = await conn.fetchval("SELECT to_regclass('trace_summaries') IS NOT NULL")
        if not has:
            print("trace_summaries missing — run `alembic upgrade head`")
            return
        print(f"seeding {args.traces} traces x {args.spans} spans for {ORG}...")
        t0 = time.perf_counter()
        await seed(conn, args.traces, args.spans)
        print(f"  seeded in {time.perf_counter() - t0:.1f}s")
        since = datetime.now(UTC) - timedelta(days=7)
        await bench(conn, since)
    finally:
        await conn.execute("DELETE FROM telemetry_events WHERE tenant_id = $1", ORG)
        await conn.execute("DELETE FROM trace_summaries WHERE org_id = $1", ORG)
        await conn.close()
        print("cleanup done")


if __name__ == "__main__":
    asyncio.run(main())