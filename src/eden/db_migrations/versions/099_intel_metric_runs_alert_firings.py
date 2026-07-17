"""099_intel_metric_runs_alert_firings — Cat 18/19/21 runtime tables.

Revision ID: 099
Revises: 099a
Create Date: 2026-07-13

Renumbered down_revision from a duplicate "098" (see
096_debugger_llm_cache.py for the chain-repair note) — this file
keeps the "099" id (100_artifacts_ledger.py already depends on
it) but now continues from "099a".

Closes the remaining Cat 21 + Cat 19 persistence gaps:

* ``custom_metric_runs.id`` was declared ``UUID`` in migration
  021, but RubricSynthesiser / JudgeFactory write string ids
  (``rubric_…``, ``score_…``). Widen the column to
  ``VARCHAR(64)`` so runtime judge execution can persist.
* ``eql_alert_firings`` — append-only log of every alert-as-
  code evaluation that produced a firing (or an empty-result
  miss). The AlertAsCode watchdog + on-demand evaluate
  endpoint write here.

Idempotent: uses ``IF NOT EXISTS`` / guarded ``ALTER`` so
re-runs on partially-migrated databases are no-ops.
"""

from __future__ import annotations

from alembic import op

revision = "099"
down_revision = "099a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ─── Cat 21 — ensure custom_metric_runs exists + string ids ─
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS custom_metric_runs (
            id                      VARCHAR(64) PRIMARY KEY,
            org_id                  VARCHAR(128) NOT NULL,
            metric_id               VARCHAR(128),
            metric_name             VARCHAR(128),
            judge_name              VARCHAR(128),
            score                   DOUBLE PRECISION,
            threshold               DOUBLE PRECISION,
            passed                  BOOLEAN,
            synthesised_rubric      TEXT,
            rubric_tokens           INTEGER,
            domain                  VARCHAR(64),
            trace_id                VARCHAR(128),
            examples_json           TEXT,
            result_json             TEXT,
            status                  VARCHAR(16) NOT NULL DEFAULT 'synthesised',
            approval_status         VARCHAR(16) NOT NULL DEFAULT 'pending',
            approved_by             VARCHAR(128),
            approved_at             TIMESTAMPTZ,
            rejection_reason        TEXT,
            created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_custom_metric_runs_org "
        "ON custom_metric_runs (org_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_custom_metric_runs_trace "
        "ON custom_metric_runs (org_id, trace_id)"
    )
    # Widen legacy UUID PK → VARCHAR so string run ids persist.
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'custom_metric_runs'
                  AND column_name = 'id'
                  AND data_type = 'uuid'
            ) THEN
                ALTER TABLE custom_metric_runs
                    ALTER COLUMN id TYPE VARCHAR(64)
                    USING id::text;
            END IF;
        END $$;
        """
    )

    # ─── Cat 19 — alert firings audit log ───────────────────────
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS eql_alert_firings (
            id                  VARCHAR(64) PRIMARY KEY,
            org_id              VARCHAR(128) NOT NULL,
            alert_id            VARCHAR(128) NOT NULL,
            severity            VARCHAR(16) NOT NULL,
            fired_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            n_rows              BIGINT NOT NULL DEFAULT 0,
            sample_rows_json    TEXT,
            clickhouse_sql      TEXT,
            data_source         VARCHAR(32) NOT NULL DEFAULT 'postgres',
            status              VARCHAR(16) NOT NULL DEFAULT 'fired',
            error               TEXT,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_eql_alert_firings_org "
        "ON eql_alert_firings (org_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_eql_alert_firings_alert "
        "ON eql_alert_firings (org_id, alert_id, fired_at DESC)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_eql_alert_firings_alert")
    op.execute("DROP INDEX IF EXISTS idx_eql_alert_firings_org")
    op.execute("DROP TABLE IF EXISTS eql_alert_firings")
    # Do not reverse the VARCHAR widen — UUID→VARCHAR is
    # lossy to reverse if non-UUID ids were already written.
