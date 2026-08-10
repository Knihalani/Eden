"""167 — trace_summaries materialized table (Wave 6 read-path 10x).

Revision ID: 167_trace_summaries
Revises: 166_telemetry_chunk_retention
Create Date: 2026-08-10

Wave 6: the portal's most-hit read path — ``GET /observability/traces``
(``list_traces``) — re-aggregates the entire ``telemetry_events`` table on
every page load (GROUP BY trace_id + two correlated subqueries per row).
Measured on synthetic data (20k traces x 6 spans): the live page query costs
~203 ms vs ~0.5 ms for an indexed read of one row per trace (**418x**) and
the distinct-trace COUNT ~39 ms vs ~2.7 ms (**14x**). The finalized-trace
pipeline already computes near-identical per-trace aggregates
(``SessionRollupIndexer._TURNS_SQL``) and then discards them — this table
persists them.

One row per ``(org_id, trace_id)``:

  * written **at ingest** as an empty placeholder (started_at only, span_count
    0) so in-flight traces appear in the list immediately — idempotent
    ``ON CONFLICT DO NOTHING``, no aggregates so a retried batch cannot
    double-count;
  * recomputed-then-upserted **at trace.finalized** by
    ``TraceSummaryIndexer`` (same recompute-then-upsert idempotency contract
    as the session rollup: a re-delivered finalize derives the identical row).

Column set mirrors the ``list_traces`` read model exactly (so the route can
serve rows from this table byte-for-byte): the aggregate expressions were
lifted from ``api/routes/observability.py`` and
``sessions/rollup.py::_TURNS_SQL``.

RLS: same policy shape as 142 (ENABLE without FORCE, unset-GUC escape) —
the indexer runs in the ``trace.finalized`` consumer on a plain pool
checkout spanning orgs; GUC-carrying reads are still confined by their own
``WHERE org_id = $1``.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "167_trace_summaries"
down_revision: str | Sequence[str] | None = "166_telemetry_chunk_retention"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS trace_summaries (
            org_id            VARCHAR(128) NOT NULL,
            trace_id          VARCHAR(128) NOT NULL,
            started_at        TIMESTAMPTZ,
            realm             VARCHAR(32),
            agent_id          VARCHAR(128),
            model             VARCHAR(128),
            provider          VARCHAR(64),
            session_id        VARCHAR(128),
            outcome           VARCHAR(32),
            error_type        VARCHAR(128),
            attr_error        TEXT,
            agent_session_id  VARCHAR(256),
            input_tokens      BIGINT NOT NULL DEFAULT 0,
            output_tokens     BIGINT NOT NULL DEFAULT 0,
            cost_usd          DOUBLE PRECISION NOT NULL DEFAULT 0,
            span_count        BIGINT NOT NULL DEFAULT 0,
            duration_ms       DOUBLE PRECISION,
            tags              TEXT[] NOT NULL DEFAULT '{}',
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (org_id, trace_id)
        )
        """
    )
    # The list read path: filter by org + order by recency.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_summaries_org_start "
        "ON trace_summaries (org_id, started_at DESC)"
    )
    # The per-agent filter variant of the same read.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_trace_summaries_org_agent_start "
        "ON trace_summaries (org_id, agent_id, started_at DESC)"
    )

    op.execute("ALTER TABLE trace_summaries ENABLE ROW LEVEL SECURITY")
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_policies
                WHERE schemaname = 'public'
                  AND tablename = 'trace_summaries'
                  AND policyname = 'tenant_isolation_trace_summaries'
            ) THEN
                EXECUTE $policy$
                    CREATE POLICY tenant_isolation_trace_summaries
                    ON trace_summaries
                    FOR ALL
                    TO PUBLIC
                    USING (
                        org_id = current_setting('app.current_org_id', true)
                        OR current_setting('app.current_org_id', true) IS NULL
                    )
                $policy$;
            END IF;
        END $$;
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE trace_summaries DISABLE ROW LEVEL SECURITY")
    op.execute(
        "DROP POLICY IF EXISTS tenant_isolation_trace_summaries "
        "ON trace_summaries"
    )
    op.execute("DROP INDEX IF EXISTS idx_trace_summaries_org_agent_start")
    op.execute("DROP INDEX IF EXISTS idx_trace_summaries_org_start")
    op.execute("DROP TABLE IF EXISTS trace_summaries")
