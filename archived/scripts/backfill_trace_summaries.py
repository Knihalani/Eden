"""Backfill ``trace_summaries`` from existing ``telemetry_events`` (Wave 6).

Populates the materialized per-trace summary rows for all historical traces
so the ``list_traces`` read path can serve from the table the moment
``trace_summaries_read_v1`` is enabled. Idempotent: upserts (ON CONFLICT
DO UPDATE) so re-runs converge.

Usage:
    # Dry run — count traces that would be materialized, write nothing.
    uv run python scripts/backfill_trace_summaries.py --dry-run

    # Backfill the last 7 days for one org.
    uv run python scripts/backfill_trace_summaries.py --days 7 --org <org_id>

    # Full backfill (90 days, all orgs).
    uv run python scripts/backfill_trace_summaries.py --days 90

The per-trace aggregation is the byte-for-byte ``list_traces`` read model
(the same expressions ``TraceSummaryIndexer`` uses at finalize), so rows
produced here equal rows the indexer would produce.

Run once after migration 167, before enabling
``trace_summaries_read_v1`` in settings.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from datetime import UTC, datetime, timedelta

logger = logging.getLogger("backfill_trace_summaries")

# Same aggregate shape as TraceSummaryIndexer._TRACE_SQL / list_traces.
# $1 = since, $2 = optional org (or None for all orgs).
_AGG_SQL = """
SELECT tenant_id AS org_id,
       trace_id,
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
       max(outcome) AS outcome,
       max(error_type) AS error_type,
       max(attributes->>'error') AS attr_error,
       (SELECT split_part(tag, ':', 2)
        FROM telemetry_events e3
        CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(e3.tags) = 'array' THEN e3.tags
                 ELSE '[]'::jsonb END
        ) AS tag
        WHERE e3.tenant_id = telemetry_events.tenant_id
          AND e3.trace_id = telemetry_events.trace_id
          AND tag LIKE 'agent_session_id:%'
        LIMIT 1) AS agent_session_id,
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
                 ELSE '[]'::jsonb END
        ) AS tag
        WHERE e2.tenant_id = telemetry_events.tenant_id
          AND e2.trace_id = telemetry_events.trace_id
          AND tag IS NOT NULL) AS tags
FROM telemetry_events
WHERE timestamp >= $1
  AND ($2::text IS NULL OR tenant_id = $2)
GROUP BY tenant_id, trace_id
ORDER BY min(timestamp)
"""

_UPSERT_SQL = """
INSERT INTO trace_summaries (
    org_id, trace_id, started_at, realm, agent_id, model, provider,
    session_id, outcome, error_type, attr_error, agent_session_id,
    input_tokens, output_tokens, cost_usd, span_count, duration_ms, tags,
    updated_at
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
    $17, $18, NOW()
)
ON CONFLICT (org_id, trace_id) DO UPDATE SET
    started_at       = EXCLUDED.started_at,
    realm            = EXCLUDED.realm,
    agent_id         = EXCLUDED.agent_id,
    model            = EXCLUDED.model,
    provider         = EXCLUDED.provider,
    session_id       = EXCLUDED.session_id,
    outcome          = EXCLUDED.outcome,
    error_type       = EXCLUDED.error_type,
    attr_error       = EXCLUDED.attr_error,
    agent_session_id = EXCLUDED.agent_session_id,
    input_tokens     = EXCLUDED.input_tokens,
    output_tokens    = EXCLUDED.output_tokens,
    cost_usd         = EXCLUDED.cost_usd,
    span_count       = EXCLUDED.span_count,
    duration_ms      = EXCLUDED.duration_ms,
    tags             = EXCLUDED.tags,
    updated_at       = NOW()
"""


async def _get_client():
    from eden.storage.postgres import get_postgres_client

    return await get_postgres_client()


async def run(days: int, org: str | None, dry_run: bool) -> int:
    since = datetime.now(UTC) - timedelta(days=days)
    client = await _get_client()
    if client is None:
        logger.error("postgres unavailable")
        return 1

    has_table = await client.fetchval(
        "SELECT to_regclass('trace_summaries') IS NOT NULL"
    )
    if not has_table:
        logger.error("trace_summaries missing — run `alembic upgrade head` first")
        return 1

    if dry_run:
        n = await client.fetchval(
            "SELECT count(*) FROM ("
            " SELECT trace_id FROM telemetry_events "
            " WHERE timestamp >= $1 AND ($2::text IS NULL OR tenant_id = $2)"
            " GROUP BY tenant_id, trace_id"
            ") AS _traces",
            since, org,
        )
        logger.info("would materialize %d traces since %s (org=%s)",
                    int(n or 0), since.date().isoformat(), org or "ALL")
        return 0

    # Stream the page of aggregated rows in batches. The aggregation query
    # is one pass over the window (grouped per trace); batches are only
    # for the executemany upsert size, not for re-scanning.
    batch_size = 200
    done = 0
    page: list = []
    async for batch in _iter_batches(client, _AGG_SQL, [since, org], batch_size):
        page = batch
        if not page:
            continue
        await client.executemany(
            _UPSERT_SQL,
            [
                (
                    r["org_id"], r["trace_id"], r["started_at"], r["realm"],
                    r["agent_id"], r["model"], r["provider"], r["session_id"],
                    r["outcome"], r["error_type"], r["attr_error"],
                    r["agent_session_id"],
                    int(r["input_tokens"] or 0), int(r["output_tokens"] or 0),
                    float(r["cost_usd"] or 0), int(r["span_count"] or 0),
                    r["duration_ms"], list(r["tags"] or []),
                )
                for r in page
            ],
        )
        done += len(page)
        if done % 2000 == 0:
            logger.info("  %d written so far", done)
    logger.info("done: %d trace summaries written", done)
    return 0


async def _iter_batches(client, sql: str, args: list, size: int):
    """Yield rows from ``sql`` in chunks (asyncpg fetch keeps it simple;
    the window is bounded by ``days`` so a single fetch is acceptable)."""
    rows = await client.fetch(sql, *args)
    for i in range(0, len(rows), size):
        yield rows[i:i + size]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--org", default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    return asyncio.run(run(args.days, args.org, args.dry_run))


if __name__ == "__main__":
    sys.exit(main())
