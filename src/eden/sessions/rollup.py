"""SessionRollupIndexer — incremental ``session_summaries`` upsert (N12).

Runs once per ``trace.finalized`` message. The unit of work is one
*session*, not the whole table: the indexer resolves the finalized
trace's session, re-derives that session's turn set (previously known
``trace_ids`` ∪ traces indexed under the session ∪ the finalized trace),
re-aggregates those traces from ``telemetry_events`` and
``agent_stumbles``, and upserts the single summary row.

Recompute-then-upsert makes the indexer idempotent by construction: a
re-delivered ``trace.finalized`` for a trace that is already in
``trace_ids`` derives the identical turn set and writes the identical
row (turn 5 finalized twice is still 5 turns, not 6). No watermark
bookkeeping can drift, because there is none.

Cost per finalize is three index-backed queries + one upsert:

  * ``(tenant_id, session_id)``  — ``idx_telemetry_events_session``
  * ``(tenant_id, trace_id)``    — ``idx_telemetry_events_tenant_trace_ts``
  * ``(org_id, trace_id)``       — ``idx_agent_stumbles_trace``

Traces whose events carry ``session_id`` only inside ``attributes``
(older SDKs) still join the session: the stream payload's ``session_id``
comes from event attributes (``trace_finalized.maybe_emit``), the trace
is folded in by id at its own finalize, and membership then persists via
the stored ``trace_ids``. A deliberate ``attributes->>'session_id'``
predicate is avoided — it has no index and would turn the 5–20ms rollup
budget (spec §12) into a per-finalize tenant scan.

Aggregate expressions (cost, tokens) mirror the trace list read model in
``api/routes/observability.py`` — cost lives in ``metrics/payload/
attributes ->> 'cost_usd'``, tokens in ``payload`` JSON with the
``usage_*`` typed columns as fallback — so a session's totals always
equal the sum of what the trace list shows for its turns.

``linked_issue_id`` is operator state (the link-issue endpoint); the
rollup never writes it.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Turn aggregation over one session's traces. $1 = org (tenant_id),
# $2 = text[] trace ids. Shapes mirror observability.list_traces.
_TURNS_SQL = """
SELECT trace_id,
       min(timestamp) AS started_at,
       max(timestamp) AS last_event_at,
       max(duration_ms) AS duration_ms,
       coalesce(max(agent_id), max(attributes->>'agent_id')) AS agent_id,
       max(attributes->>'user_id') AS user_id,
       max(outcome) AS outcome,
       max(error_type) AS error_type,
       sum(
           coalesce(
               (NULLIF(payload->>'input_tokens', ''))::numeric,
               usage_prompt_tokens,
               0
           )
       ) AS input_tokens,
       sum(
           coalesce(
               (NULLIF(payload->>'output_tokens', ''))::numeric,
               usage_completion_tokens,
               0
           )
       ) AS output_tokens,
       sum(
           coalesce(
               NULLIF(metrics->>'cost_usd', '')::float,
               NULLIF(payload->>'cost_usd', '')::float,
               NULLIF(attributes->>'cost_usd', '')::float
           )
       ) AS cost_usd,
       (array_agg(name ORDER BY timestamp)
           FILTER (WHERE name IS NOT NULL AND name <> ''))[1] AS first_name
FROM telemetry_events
WHERE tenant_id = $1 AND trace_id = ANY($2::text[])
GROUP BY trace_id
ORDER BY min(timestamp)
"""

_STUMBLES_SQL = """
SELECT trace_id,
       count(*) AS n,
       array_agg(DISTINCT kind) AS kinds
FROM agent_stumbles
WHERE org_id = $1 AND trace_id = ANY($2::text[])
GROUP BY trace_id
"""

_ISSUE_COUNT_SQL = """
SELECT count(DISTINCT i.id)
FROM agent_issues i
JOIN agent_stumbles s
  ON s.org_id = i.org_id AND s.fingerprint = i.fingerprint
WHERE s.org_id = $1 AND s.trace_id = ANY($2::text[])
"""

_UPSERT_SQL = """
INSERT INTO session_summaries (
    org_id, session_id, agent_id, user_id, trace_ids, turn_count,
    total_cost_usd, total_input_tokens, total_output_tokens,
    total_latency_ms, session_start, session_end, had_stumble,
    stumble_count, stumble_turn_indices, issue_count, outcome, updated_at
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
    $16, $17, NOW()
)
ON CONFLICT (org_id, session_id) DO UPDATE SET
    agent_id             = coalesce(EXCLUDED.agent_id,
                                    session_summaries.agent_id),
    user_id              = coalesce(EXCLUDED.user_id,
                                    session_summaries.user_id),
    trace_ids            = EXCLUDED.trace_ids,
    turn_count           = EXCLUDED.turn_count,
    total_cost_usd       = EXCLUDED.total_cost_usd,
    total_input_tokens   = EXCLUDED.total_input_tokens,
    total_output_tokens  = EXCLUDED.total_output_tokens,
    total_latency_ms     = EXCLUDED.total_latency_ms,
    session_start        = EXCLUDED.session_start,
    session_end          = EXCLUDED.session_end,
    had_stumble          = EXCLUDED.had_stumble,
    stumble_count        = EXCLUDED.stumble_count,
    stumble_turn_indices = EXCLUDED.stumble_turn_indices,
    issue_count          = EXCLUDED.issue_count,
    outcome              = EXCLUDED.outcome,
    updated_at           = NOW()
"""

_ERROR_OUTCOMES = frozenset({"error", "failure", "failed", "fail"})


def _turn_errored(row: Any) -> bool:
    outcome = (row["outcome"] or "").strip().lower()
    return bool(row["error_type"]) or outcome in _ERROR_OUTCOMES


def derive_outcome(turn_rows: list[Any]) -> str:
    """success | fail | partial from per-turn outcomes.

    ``fail`` when the session's last turn errored (the conversation ended
    badly), ``partial`` when an earlier turn errored but the session
    recovered, else ``success``. ``live`` is not derived here — a
    finalized-trace rollup is by definition looking at settled turns; the
    read side overlays liveness from recency.
    """
    if not turn_rows:
        return "success"
    if _turn_errored(turn_rows[-1]):
        return "fail"
    if any(_turn_errored(r) for r in turn_rows):
        return "partial"
    return "success"


class SessionRollupIndexer:
    """Upsert one session's summary row from its finalized traces."""

    def __init__(self, client: Any | None = None) -> None:
        # Injectable for tests (live-PG tests connect outside the pooled
        # client because the autouse settings patch redirects the pool).
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
        *,
        session_id: str | None = None,
        agent_id: str | None = None,
        user_id: str | None = None,
    ) -> bool:
        """Recompute + upsert the summary row for ``trace_id``'s session.

        Returns ``True`` when a row was upserted, ``False`` when the
        trace has no session (spec §12 degradation: session-less traces
        are simply not on any timeline). Storage errors propagate — the
        consumer's transient-retry ladder owns that decision.
        """
        client = await self._get_client()
        if client is None:
            raise ConnectionError("session rollup: postgres unavailable")

        sid = (session_id or "").strip() or await self._resolve_session_id(
            client, org_id, trace_id
        )
        if not sid:
            logger.debug(
                "session rollup: trace %s has no session_id; skipped", trace_id
            )
            return False

        trace_ids = await self._session_trace_ids(client, org_id, sid, trace_id)
        turn_rows = await client.fetch(_TURNS_SQL, org_id, trace_ids)
        if not turn_rows:
            # Events already TTL'd/compressed away — nothing to aggregate.
            logger.debug(
                "session rollup: no events for session %s (org %s)", sid, org_id
            )
            return False

        ordered_ids = [r["trace_id"] for r in turn_rows]
        stumble_rows = await client.fetch(_STUMBLES_SQL, org_id, ordered_ids)
        by_trace = {r["trace_id"]: r for r in stumble_rows}
        stumble_count = sum(int(r["n"]) for r in stumble_rows)
        stumble_turn_indices = [
            i + 1 for i, tid in enumerate(ordered_ids) if tid in by_trace
        ]
        issue_count = int(
            await client.fetchval(_ISSUE_COUNT_SQL, org_id, ordered_ids) or 0
        )

        session_start = turn_rows[0]["started_at"]
        session_end = max(r["last_event_at"] for r in turn_rows)
        total_latency_ms = sum(
            float(r["duration_ms"]) for r in turn_rows if r["duration_ms"] is not None
        )
        await client.execute(
            _UPSERT_SQL,
            org_id,
            sid,
            agent_id or _first(turn_rows, "agent_id"),
            user_id or _first(turn_rows, "user_id"),
            ordered_ids,
            len(ordered_ids),
            float(sum(float(r["cost_usd"] or 0) for r in turn_rows)),
            int(sum(int(r["input_tokens"] or 0) for r in turn_rows)),
            int(sum(int(r["output_tokens"] or 0) for r in turn_rows)),
            total_latency_ms,
            session_start,
            session_end,
            bool(stumble_rows),
            stumble_count,
            stumble_turn_indices,
            issue_count,
            derive_outcome(turn_rows),
        )
        return True

    async def _resolve_session_id(
        self, client: Any, org_id: str, trace_id: str
    ) -> str | None:
        """Session id from the trace's own events (payload had none)."""
        value = await client.fetchval(
            """
            SELECT coalesce(max(session_id), max(attributes->>'session_id'))
            FROM telemetry_events
            WHERE tenant_id = $1 AND trace_id = $2
            """,
            org_id,
            trace_id,
        )
        return (value or "").strip() or None

    async def _session_trace_ids(
        self, client: Any, org_id: str, session_id: str, trace_id: str
    ) -> list[str]:
        """Known trace ids ∪ session-indexed trace ids ∪ this trace."""
        known = (
            await client.fetchval(
                "SELECT trace_ids FROM session_summaries "
                "WHERE org_id = $1 AND session_id = $2",
                org_id,
                session_id,
            )
            or []
        )
        indexed = await client.fetch(
            """
            SELECT DISTINCT trace_id
            FROM telemetry_events
            WHERE tenant_id = $1 AND session_id = $2
            """,
            org_id,
            session_id,
        )
        merged = dict.fromkeys(list(known) + [r["trace_id"] for r in indexed])
        merged[trace_id] = None
        return list(merged)


def _first(rows: list[Any], key: str) -> str | None:
    for row in rows:
        if row[key]:
            return row[key]
    return None
