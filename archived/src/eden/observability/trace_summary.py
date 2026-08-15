"""TraceSummaryIndexer — incremental ``trace_summaries`` upsert (Wave 6).

Runs once per ``trace.finalized`` message, right after the session rollup.
The unit of work is one *trace*: recompute the trace's aggregate row from
``telemetry_events`` and upsert it into ``trace_summaries``.

Why this is the read-path 10x: ``GET /observability/traces`` used to
re-aggregate ``telemetry_events`` per page load (GROUP BY + 2 correlated
subqueries/row). Measured on synthetic data (20k traces x 6 spans): the
live page query was ~203 ms vs ~0.5 ms for an indexed read of one row per
trace (**418x**), the distinct-trace COUNT ~39 ms vs ~2.7 ms (**14x**).
This indexer persists the exact aggregates ``list_traces`` computes.

Recompute-then-upsert makes the indexer idempotent by construction — the
same contract as ``SessionRollupIndexer``: a re-delivered ``trace.finalized``
derives the identical row and writes it again (the ``list_traces`` read
model and this SQL can never drift, because they are the same expressions).
A trace with no events left (TTL'd/compressed away) is skipped; the
ingest-time placeholder row then serves as the last-known summary.

Aggregate expressions are the byte-for-byte list_traces shape (cost lives
in ``metrics/payload/attributes ->> 'cost_usd'``, tokens in ``payload``
JSON with the ``usage_*`` typed columns as fallback, model/provider from the
coalesce ladder, tags as DISTINCT over the JSONB array).

In-flight traces: the ingest path writes a placeholder row (started_at only,
span_count 0) per new trace so the list shows live traces immediately; the
indexer replaces it with the full row at finalize.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Byte-for-byte the ``list_traces`` per-trace aggregate (observability.py,
# the legacy ``WITH page AS`` branch). These two copies MUST stay identical:
# if you edit one, edit the other. The live-parity test
# (``tests/unit/observability/test_trace_summaries.py``) enforces this at
# runtime.
# $1 = org (tenant_id), $2 = trace id.
_TRACE_SQL = """
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
WHERE tenant_id = $1 AND trace_id = $2
GROUP BY trace_id
"""

# DISTINCT tags for the trace (the list page's per-trace subquery, lifted).
_TAGS_SQL = """
SELECT array_agg(DISTINCT tag)
FROM telemetry_events e
CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(e.tags) = 'array' THEN e.tags
         ELSE '[]'::jsonb END
) AS tag
WHERE e.tenant_id = $1 AND e.trace_id = $2 AND tag IS NOT NULL
"""

# The list page's ``agent_session_id:<id>`` tag extraction (lifted).
_SESSION_ID_SQL = """
SELECT split_part(tag, ':', 2)
FROM telemetry_events e
CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(e.tags) = 'array' THEN e.tags
         ELSE '[]'::jsonb END
) AS tag
WHERE e.tenant_id = $1 AND e.trace_id = $2
  AND tag LIKE 'agent_session_id:%'
LIMIT 1
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

# Placeholder write — called from the ingest path for every new trace_id so
# in-flight traces are visible before finalize. Carries NO aggregates (a
# retried batch must not double-count), so a conflict is a plain no-op.
_PLACEHOLDER_SQL = """
INSERT INTO trace_summaries (org_id, trace_id, started_at)
VALUES ($1, $2, $3)
ON CONFLICT (org_id, trace_id) DO NOTHING
"""


class TraceSummaryIndexer:
    """Recompute + upsert one trace's summary row."""

    def __init__(self, client: Any | None = None) -> None:
        # Injectable for tests (same pattern as SessionRollupIndexer).
        self._client = client

    async def _get_client(self) -> Any | None:
        if self._client is not None:
            return self._client
        from eden.storage.postgres import get_postgres_client

        return await get_postgres_client()

    async def index_trace(
        self,
        org_id: str,
        trace_id: str,
    ) -> bool:
        """Recompute + upsert the summary row for one finalized trace.

        Returns True when a row was upserted, False when the trace has no
        events left (TTL'd/compressed away — the placeholder stays as the
        last-known summary). Storage errors propagate: the consumer's
        transient-retry ladder owns retry decisions (same contract as the
        session rollup).
        """
        client = await self._get_client()
        if client is None:
            raise ConnectionError("trace summary: postgres unavailable")

        row = await client.fetchrow(_TRACE_SQL, org_id, trace_id)
        if row is None or row["trace_id"] is None:
            logger.debug("trace summary: no events for trace %s (org %s)",
                         trace_id, org_id)
            return False
        tags = await client.fetchval(_TAGS_SQL, org_id, trace_id) or []
        agent_session_id = await client.fetchval(_SESSION_ID_SQL, org_id, trace_id)
        await client.execute(
            _UPSERT_SQL,
            org_id,
            trace_id,
            row["started_at"],
            row["realm"],
            row["agent_id"],
            row["model"],
            row["provider"],
            row["session_id"],
            row["outcome"],
            row["error_type"],
            row["attr_error"],
            agent_session_id,
            int(row["input_tokens"] or 0),
            int(row["output_tokens"] or 0),
            float(row["cost_usd"] or 0),
            int(row["span_count"] or 0),
            row["duration_ms"],
            list(tags or []),
        )
        return True


async def upsert_trace_placeholders(
    events: list[Any],
    client: Any | None = None,
) -> int:
    """Write placeholder rows for new trace_ids seen on the ingest path.

    One ``executemany`` per batch over the batch's DISTINCT trace_ids.
    Idempotent (``ON CONFLICT DO NOTHING``) and aggregate-free, so an SDK
    retry of a partially-landed batch cannot double-count anything. Returns
    the number of placeholder rows written (0 when the table is missing or
    Postgres is down — best-effort, never fails ingest).
    """
    pairs: dict[tuple[str, str], Any] = {}
    for ev in events:
        org = getattr(ev, "tenant_id", None) or ""
        tid = getattr(ev, "trace_id", None) or ""
        if not org or not tid:
            continue
        ts = getattr(ev, "timestamp", None)
        key = (str(org), str(tid))
        if key not in pairs:
            pairs[key] = ts
    if not pairs:
        return 0
    try:
        if client is None:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
        if client is None:
            return 0
        rows = [(org, tid, ts) for (org, tid), ts in pairs.items()]
        await client.executemany(_PLACEHOLDER_SQL, rows)
        return len(rows)
    except Exception as exc:
        # Missing table (pre-migration) or PG down: best-effort.
        logger.debug("trace summary placeholders skipped: %s", exc)
        return 0
