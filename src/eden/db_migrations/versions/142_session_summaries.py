"""142 — session_summaries rollup table (N12 session multi-turn timeline).

Revision ID: 142_session_summaries
Revises: 141_ci_eval_run_metadata
Create Date: 2026-08-04

N12 backend: one row per (org_id, session_id), incrementally upserted by
``eden.sessions.rollup.SessionRollupIndexer`` each time a trace in the
session finalizes (hooked into the ``trace.finalized`` consumer). The
portal session list / timeline endpoints read this table instead of
re-aggregating ``telemetry_events`` per request.

Schema notes (reconciled against what traces actually store — spec §5
asked for ``trace_ids UUID[]`` but ``telemetry_events.trace_id`` is
``VARCHAR(128)``, so ``TEXT[]`` here; ``org_id`` follows the
``VARCHAR(128)`` convention of ``agent_stumbles``/``agent_issues``, not
UUID):

  * ``trace_ids``            — ordered-by-start trace ids (turns).
  * ``stumble_turn_indices`` — 1-based indices into that order (card
                               "3/N" gets the badge, per spec §10).
  * ``linked_issue_id``      — operator-attached F29 issue (the
                               ``link-issue`` endpoint); never
                               overwritten by the rollup.
  * ``outcome``              — success | fail | partial | live. The
                               rollup writes the first three from event
                               outcomes; ``live`` is the column default
                               so a row created mid-session reads as
                               live until its first recompute.

Also adds the ``agent_stumbles (org_id, session_id)`` index the
timeline needs — 084 indexed fingerprint/trace/agent but not session.

RLS: same ``tenant_isolation_<table>`` policy naming as 097/098, but
ENABLE without FORCE and with the unset-GUC escape branch, exactly as
123_usage_events_rls_restore documents: the rollup runs in the
``trace.finalized`` consumer on a plain pool checkout that spans many
orgs, so ``app.current_org_id`` is unset there and a strict predicate
would make every upsert fail. GUC-carrying user-facing reads are still
confined to their own org; per-query ``WHERE org_id = $1`` remains the
primary defence (storage/postgres.py docstring).

Raw SQL ``IF NOT EXISTS`` / DO-block policy guard so a half-migrated DB
recovers with ``alembic upgrade head`` (same idempotency lesson as
077/133/135).
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "142_session_summaries"
down_revision: str | Sequence[str] | None = "141_ci_eval_run_metadata"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS session_summaries (
            org_id               VARCHAR(128) NOT NULL,
            session_id           VARCHAR(128) NOT NULL,
            agent_id             VARCHAR(256),
            user_id              VARCHAR(256),
            trace_ids            TEXT[] NOT NULL DEFAULT '{}',
            turn_count           INTEGER NOT NULL DEFAULT 0,
            total_cost_usd       DOUBLE PRECISION NOT NULL DEFAULT 0,
            total_input_tokens   BIGINT NOT NULL DEFAULT 0,
            total_output_tokens  BIGINT NOT NULL DEFAULT 0,
            total_latency_ms     DOUBLE PRECISION,
            session_start        TIMESTAMPTZ,
            session_end          TIMESTAMPTZ,
            had_stumble          BOOLEAN NOT NULL DEFAULT FALSE,
            stumble_count        INTEGER NOT NULL DEFAULT 0,
            stumble_turn_indices INTEGER[] NOT NULL DEFAULT '{}',
            issue_count          INTEGER NOT NULL DEFAULT 0,
            linked_issue_id      UUID,
            outcome              VARCHAR(16) NOT NULL DEFAULT 'live'
                                 CHECK (outcome IN
                                     ('success', 'fail', 'partial', 'live')),
            updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (org_id, session_id)
        )
        """
    )
    # List endpoint: filter by agent + order by recency (spec §5 index).
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_session_summaries_org_agent_start "
        "ON session_summaries (org_id, agent_id, session_start DESC)"
    )
    # Unfiltered list (no agent_id) orders by recency too.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_session_summaries_org_start "
        "ON session_summaries (org_id, session_start DESC)"
    )
    # 084 indexed agent_stumbles by fingerprint/trace/agent but never by
    # session; the timeline's badge query filters by session's traces and
    # the rollup counts per-session stumbles.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_stumbles_session "
        "ON agent_stumbles (org_id, session_id, detected_at DESC) "
        "WHERE session_id IS NOT NULL"
    )

    op.execute("ALTER TABLE session_summaries ENABLE ROW LEVEL SECURITY")
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_policies
                WHERE schemaname = 'public'
                  AND tablename = 'session_summaries'
                  AND policyname = 'tenant_isolation_session_summaries'
            ) THEN
                EXECUTE $policy$
                    CREATE POLICY tenant_isolation_session_summaries
                    ON session_summaries
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
    op.execute("ALTER TABLE session_summaries DISABLE ROW LEVEL SECURITY")
    op.execute(
        "DROP POLICY IF EXISTS tenant_isolation_session_summaries "
        "ON session_summaries"
    )
    op.execute("DROP INDEX IF EXISTS idx_agent_stumbles_session")
    op.execute("DROP INDEX IF EXISTS idx_session_summaries_org_start")
    op.execute("DROP INDEX IF EXISTS idx_session_summaries_org_agent_start")
    op.execute("DROP TABLE IF EXISTS session_summaries")
