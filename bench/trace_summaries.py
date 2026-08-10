"""Benchmark: list_traces read path — live GROUP BY vs materialized trace_summaries.

Proves the Wave 6 claim: the portal's most-hit read path re-aggregates the
entire ``telemetry_events`` table (GROUP BY + 2 correlated subqueries per
row) on every page load, while the finalized-trace pipeline already computes
near-identical per-trace aggregates and discards them. Materializing one row
per trace turns the page load into an indexed read.

Run against the local dev Postgres (docker compose). Synthetic data is
created in a throwaway org and deleted at the end.

Usage:
    uv run python -m bench.trace_summaries --org <org_id> [--traces 20000 --spans 6]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
import uuid
from datetime import UTC, datetime, timedelta

import asyncpg

ORG = f"org-trace-bench-{uuid.uuid4().hex[:10]}"
DB = "eden"
USER = "eden"
PASSWORD = "eden_dev_password"
HOST = "localhost"
PORT = 5432

# The exact page query shape list_traces runs (see api/routes/observability.py).
_LIST_SQL = """
WITH page AS (
    SELECT trace_id,
           min(timestamp) AS started_at,
           max(realm) AS realm,
           coalesce(max(agent_id), max(attributes->>'agent_id')) AS agent_id,
           coalesce(max(model), max(model_name),
                    max(attributes->>'model'),
                    max(attributes->>'openai.model'),
                    max(attributes->>'anthropic.model'),
                    max(attributes->>'bedrock.model_id'),
                    max(attributes->>'gen_ai.request.model')) AS model,
           coalesce(max(provider_name), max(attributes->>'provider')) AS provider,
           coalesce(max(session_id), max(attributes->>'session_id')) AS session_id,
           max(attributes->>'agent_session_id') AS attr_agent_session_id,
           max(outcome) AS outcome,
           max(error_type) AS error_type,
           max(attributes->>'error') AS attr_error,
           sum(coalesce((NULLIF(payload->>'input_tokens', ''))::numeric,
                        usage_prompt_tokens, 0)) AS input_tokens,
           sum(coalesce((NULLIF(payload->>'output_tokens', ''))::numeric,
                        usage_completion_tokens, 0)) AS output_tokens,
           sum(coalesce(NULLIF(metrics->>'cost_usd', '')::float,
                        NULLIF(payload->>'cost_usd', '')::float,
                        NULLIF(attributes->>'cost_usd', '')::float)) AS cost_usd,
           count(*) AS span_count,
           max(duration_ms) AS duration_ms
    FROM telemetry_events
    WHERE tenant_id = $1 AND timestamp >= $2
    GROUP BY trace_id
    ORDER BY started_at DESC
    LIMIT 50
)
SELECT p.trace_id, p.started_at, p.realm, p.agent_id, p.model, p.provider,
       p.session_id, p.outcome, p.error_type, p.attr_error,
       p.input_tokens, p.output_tokens, p.cost_usd, p.span_count, p.duration_ms,
       (SELECT array_agg(DISTINCT tag)
        FROM telemetry_events e2
        CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(e2.tags) = 'array' THEN e2.tags
                 ELSE '[]'::jsonb END) AS tag
        WHERE e2.tenant_id = $1 AND e2.trace_id = p.trace_id AND tag IS NOT NULL) AS tags
FROM page p
ORDER BY p.started_at DESC
"""

_LIST_COUNT_SQL = """
SELECT count(*) FROM (
    SELECT trace_id FROM telemetry_events
    WHERE tenant_id = $1 AND timestamp >= $2
    GROUP BY trace_id
) AS _traces
"""

# The materialized read — one row per trace, indexed.
_MAT_SQL = """
SELECT trace_id, started_at, realm, agent_id, model, provider, session_id,
       outcome, error_type, attr_error, input_tokens, output_tokens, cost_usd,
       span_count, duration_ms, tags
FROM trace_summaries_bench
WHERE org_id = $1 AND started_at >= $2
ORDER BY started_at DESC
LIMIT 50
"""

# Same aggregates as _LIST_SQL but WITHOUT the LIMIT — used to build the
# materialized table from the same data (this is what the indexer would
# write per finalized trace).
_MAT_BUILD_SQL = """
SELECT trace_id,
       min(timestamp) AS started_at,
       max(realm) AS realm,
       coalesce(max(agent_id), max(attributes->>'agent_id')) AS agent_id,
       coalesce(max(model), max(model_name),
                max(attributes->>'model'),
                max(attributes->>'openai.model'),
                max(attributes->>'anthropic.model'),
                max(attributes->>'bedrock.model_id'),
                max(attributes->>'gen_ai.request.model')) AS model,
       coalesce(max(provider_name), max(attributes->>'provider')) AS provider,
       coalesce(max(session_id), max(attributes->>'session_id')) AS session_id,
       max(attributes->>'agent_session_id') AS attr_agent_session_id,
       max(outcome) AS outcome,
       max(error_type) AS error_type,
       max(attributes->>'error') AS attr_error,
       sum(coalesce((NULLIF(payload->>'input_tokens', ''))::numeric,
                    usage_prompt_tokens, 0)) AS input_tokens,
       sum(coalesce((NULLIF(payload->>'output_tokens', ''))::numeric,
                    usage_completion_tokens, 0)) AS output_tokens,
       sum(coalesce(NULLIF(metrics->>'cost_usd', '')::float,
                    NULLIF(payload->>'cost_usd', '')::float,
                    NULLIF(attributes->>'cost_usd', '')::float)) AS cost_usd,
       count(*) AS span_count,
       max(duration_ms) AS duration_ms,
       (SELECT array_agg(DISTINCT tag)
        FROM telemetry_events e2
        CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(e2.tags) = 'array' THEN e2.tags
                 ELSE '[]'::jsonb END) AS tag
        WHERE e2.tenant_id = $1 AND e2.trace_id = telemetry_events.trace_id
          AND tag IS NOT NULL) AS tags
FROM telemetry_events
WHERE tenant_id = $1 AND timestamp >= $2
GROUP BY trace_id
"""

_MAT_COUNT_SQL = "SELECT count(*) FROM trace_summaries_bench WHERE org_id = $1 AND started_at >= $2"


def _fmt(seconds: float) -> str:
    if seconds < 0.001:
        return f"{seconds * 1e6:.0f} µs"
    if seconds < 1:
        return f"{seconds * 1e3:.1f} ms"
    return f"{seconds:.2f} s"


async def main(org_id: str, n_traces: int, spans_per_trace: int) -> None:
    conn = await asyncpg.connect(host=HOST, port=PORT, user=USER,
                                 password=PASSWORD, database=DB)
    since = datetime.now(UTC) - timedelta(days=7)

    # Clean up a prior run, create synthetic events, and ANALYZE so the
    # planner has real stats (same shape a production tenant has).
    await conn.execute("DELETE FROM telemetry_events WHERE tenant_id = $1", org_id)
    await conn.execute("DROP TABLE IF EXISTS trace_summaries_bench")

    print(f"seeding {n_traces:,} traces x {spans_per_trace} spans for org {org_id}...")
    t0 = time.perf_counter()
    rows = []
    batch = 2000
    for i in range(n_traces):
        tid = f"trace-{i:07d}"
        ts = since + timedelta(seconds=i * 7)
        model = ["gpt-4o-mini", "gpt-4o", "claude-sonnet-4", "claude-haiku"][i % 4]
        outcome = ["success", "success", "success", "error", "success"][i % 5]
        for s in range(spans_per_trace):
            rows.append((
                f"evt-{i:07d}-{s:02d}", org_id, "proj-1", tid, "production",
                "llm.completion", ts + timedelta(seconds=s),
                "agent-42", "gpt-4o-mini" if i % 3 else model,
                s,  # duration_ms
                json.dumps({"input_tokens": 100 + s, "output_tokens": 50 + s,
                            "model": model}),
                json.dumps({"cost_usd": round(0.0002 * (1 + s * 0.1), 6),
                            "input_tokens": 100 + s}),
                json.dumps({"session_id": f"sess-{i % 200:04d}"}),
                json.dumps(["cache_read"]),
                outcome, "eden_native",
                model, "unknown",
            ))
        if len(rows) >= batch:
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
            rows = []
    if rows:
        await conn.copy_records_to_table(
            "telemetry_events", records=rows,
            columns=[
                "event_id", "tenant_id", "project_id", "trace_id", "realm",
                "event_type", "timestamp", "agent_id", "model", "duration_ms",
                "payload", "metrics", "attributes", "tags", "outcome",
                "source_format", "model_name", "provider_name",
            ],
        )
    await conn.execute("ANALYZE telemetry_events")
    print(f"  seeded in {_fmt(time.perf_counter() - t0)}")

    # Build the materialized table from the same data (what a future
    # trace_summaries write would contain), then ANALYZE.
    await conn.execute(
        """
        CREATE TABLE trace_summaries_bench (
            org_id VARCHAR(128) NOT NULL,
            trace_id VARCHAR(128) NOT NULL,
            started_at TIMESTAMPTZ,
            realm VARCHAR(32),
            agent_id VARCHAR(128),
            model VARCHAR(128),
            provider VARCHAR(64),
            session_id VARCHAR(128),
            outcome VARCHAR(32),
            error_type VARCHAR(128),
            attr_error TEXT,
            input_tokens BIGINT,
            output_tokens BIGINT,
            cost_usd DOUBLE PRECISION,
            span_count BIGINT,
            duration_ms DOUBLE PRECISION,
            tags TEXT[],
            PRIMARY KEY (org_id, trace_id)
        )
        """
    )
    await conn.execute(
        "CREATE INDEX idx_trace_summaries_bench_org_start "
        "ON trace_summaries_bench (org_id, started_at DESC)"
    )
    mat_rows = await conn.fetch(_MAT_BUILD_SQL, org_id, since)
    await conn.copy_records_to_table(
        "trace_summaries_bench",
        records=[(org_id, r["trace_id"], r["started_at"], r["realm"], r["agent_id"],
                  r["model"], r["provider"], r["session_id"], r["outcome"],
                  r["error_type"], r["attr_error"], int(r["input_tokens"] or 0),
                  int(r["output_tokens"] or 0), float(r["cost_usd"] or 0),
                  int(r["span_count"] or 0), r["duration_ms"], r["tags"] or [])
                 for r in mat_rows],
        columns=["org_id", "trace_id", "started_at", "realm", "agent_id", "model",
                 "provider", "session_id", "outcome", "error_type", "attr_error",
                 "input_tokens", "output_tokens", "cost_usd", "span_count",
                 "duration_ms", "tags"],
    )
    await conn.execute("ANALYZE trace_summaries_bench")
    print(f"  materialized {len(mat_rows):,} trace rows")

    # ── Timings (each query 3x, cold-ish; report best) ─────────────────────
    async def best(coro_factory):
        ts = []
        for _ in range(3):
            s = time.perf_counter()
            await coro_factory()
            ts.append(time.perf_counter() - s)
        return min(ts)

    live_page = await best(lambda: conn.execute(_LIST_SQL, org_id, since))
    live_count = await best(lambda: conn.fetchval(_LIST_COUNT_SQL, org_id, since))
    mat_page = await best(lambda: conn.execute(_MAT_SQL, org_id, since))
    mat_count = await best(lambda: conn.fetchval(_MAT_COUNT_SQL, org_id, since))

    print(f"\n=== list_traces read path: live aggregation vs materialized ===")
    print(f"  live  page:  {_fmt(live_page)}   count: {_fmt(live_count)}")
    print(f"  mat   page:  {_fmt(mat_page)}   count: {_fmt(mat_count)}")
    print(f"  page speedup:   {live_page / mat_page:.1f}x")
    print(f"  count speedup:  {live_count / mat_count:.1f}x")

    # Cleanup.
    await conn.execute("DELETE FROM telemetry_events WHERE tenant_id = $1", org_id)
    await conn.execute("DROP TABLE IF EXISTS trace_summaries_bench")
    await conn.close()
    print("\ncleanup done")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--org", default=ORG)
    p.add_argument("--traces", type=int, default=20000)
    p.add_argument("--spans", type=int, default=6)
    args = p.parse_args()
    asyncio.run(main(args.org, args.traces, args.spans))
