"""Phase 5.5 — Data Platform Silver Layer, Quality, Lineage, Retention.

Revision ID: 008
Revises: 007
Create Date: 2026-05-30

Tables added:
- silver_events          : cleaned, deduplicated, enriched events
- quarantine_events      : events that failed contract or quality validation
- data_quality_reports   : batch-level quality validation reports
- lineage_runs           : OpenLineage-compatible lineage records
- clickhouse_fallback    : rows that failed ClickHouse ingestion for retry
- data_retention_log     : audit log of retention policy executions
"""

from alembic import op
from alembic.runtime import migration

revision = "008"
down_revision = "007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── silver_events ──────────────────────────────────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS silver_events (
            silver_event_id        UUID PRIMARY KEY,
            bronze_event_id        UUID,
            org_id                 UUID NOT NULL,
            user_id                UUID,
            event_type             VARCHAR(64) NOT NULL,
            resource               VARCHAR(64),
            quantity               FLOAT,
            unit                   VARCHAR(32),
            model                  VARCHAR(128),
            model_family           VARCHAR(64),
            cost_usd               FLOAT,
            total_tokens           INTEGER,
            input_tokens           INTEGER,
            output_tokens          INTEGER,
            duration_ms            INTEGER,
            pipeline_stage         VARCHAR(64),
            agent_name             VARCHAR(128),
            job_id                 UUID,
            trace_id               UUID,
            benchmark_id           UUID,
            pii_detected           BOOLEAN DEFAULT FALSE,
            quarantined            BOOLEAN DEFAULT FALSE,
            metadata               JSONB DEFAULT '{}',
            correlation_id         VARCHAR(64),
            timestamp              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            silver_processed_at    TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_silver_events_org_timestamp
        ON silver_events (org_id, timestamp DESC)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_silver_events_event_type
        ON silver_events (event_type, timestamp DESC)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_silver_events_job_id
        ON silver_events (job_id)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_silver_events_trace_id
        ON silver_events (trace_id)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_silver_events_agent_name
        ON silver_events (agent_name, timestamp DESC)
    """)

    # ── quarantine_events ──────────────────────────────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS quarantine_events (
            quarantine_id          UUID PRIMARY KEY,
            bronze_event_id        UUID,
            org_id                 UUID,
            event_type             VARCHAR(64),
            quarantine_reason      JSONB DEFAULT '[]',
            raw_payload            JSONB DEFAULT '{}',
            quarantined_at         TIMESTAMPTZ DEFAULT NOW(),
            reviewed_at            TIMESTAMPTZ,
            reviewed_by            UUID,
            resolution             VARCHAR(32) DEFAULT 'pending'
            -- resolution values: pending, reprocessed, discarded, false_positive
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_quarantine_events_org
        ON quarantine_events (org_id, quarantined_at DESC)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_quarantine_events_resolution
        ON quarantine_events (resolution, quarantined_at DESC)
    """)

    # ── data_quality_reports ─────────────────────────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS data_quality_reports (
            report_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            table_name             VARCHAR(128) NOT NULL,
            batch_id               VARCHAR(64),
            timestamp              TIMESTAMPTZ DEFAULT NOW(),
            total_rows             INTEGER DEFAULT 0,
            passed_count           INTEGER DEFAULT 0,
            error_count            INTEGER DEFAULT 0,
            warning_count          INTEGER DEFAULT 0,
            quality_score          FLOAT,
            results_json             JSONB DEFAULT '{}',
            duration_ms            FLOAT
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_quality_reports_table
        ON data_quality_reports (table_name, timestamp DESC)
    """)

    # ── lineage_runs ───────────────────────────────────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS lineage_runs (
            run_id                 UUID PRIMARY KEY,
            job_name               VARCHAR(256) NOT NULL,
            job_namespace          VARCHAR(128) DEFAULT 'eden',
            event_type             VARCHAR(32) DEFAULT 'COMPLETE',
            inputs_json            JSONB DEFAULT '[]',
            outputs_json           JSONB DEFAULT '[]',
            facets_json            JSONB DEFAULT '{}',
            column_lineage_json    JSONB DEFAULT '[]',
            started_at             TIMESTAMPTZ,
            ended_at               TIMESTAMPTZ,
            recorded_at            TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_lineage_runs_job_name
        ON lineage_runs (job_name, started_at DESC)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_lineage_runs_recorded_at
        ON lineage_runs (recorded_at DESC)
    """)

    # ── clickhouse_fallback ────────────────────────────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS clickhouse_fallback (
            id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            target_table           VARCHAR(128) NOT NULL,
            payload                JSONB NOT NULL,
            failed_at              TIMESTAMPTZ DEFAULT NOW(),
            retry_count            INTEGER DEFAULT 0,
            last_retry_at          TIMESTAMPTZ,
            resolved_at            TIMESTAMPTZ,
            error_message          TEXT
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_clickhouse_fallback_table
        ON clickhouse_fallback (target_table, failed_at DESC)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_clickhouse_fallback_unresolved
        ON clickhouse_fallback (resolved_at)
        WHERE resolved_at IS NULL
    """)

    # ── data_retention_log ─────────────────────────────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS data_retention_log (
            log_id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            policy_name            VARCHAR(128) NOT NULL,
            data_type              VARCHAR(128) NOT NULL,
            pii_redacted_rows      INTEGER DEFAULT 0,
            archived_rows          INTEGER DEFAULT 0,
            deleted_rows           INTEGER DEFAULT 0,
            deleted_s3_objects     INTEGER DEFAULT 0,
            deleted_clickhouse_rows INTEGER DEFAULT 0,
            errors                 JSONB DEFAULT '[]',
            dry_run                BOOLEAN DEFAULT FALSE,
            started_at             TIMESTAMPTZ DEFAULT NOW(),
            completed_at           TIMESTAMPTZ
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_retention_log_policy
        ON data_retention_log (policy_name, completed_at DESC)
    """)

    # ── Add silver_processed columns to usage_events (Bronze source) ────
    # These may already exist from Phase 5.5 dev; use IF NOT EXISTS.
    op.execute("""
        ALTER TABLE usage_events
        ADD COLUMN IF NOT EXISTS silver_processed BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS silver_processed_at TIMESTAMPTZ
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_usage_events_silver_unprocessed
        ON usage_events (silver_processed, created_at ASC)
        WHERE silver_processed = FALSE OR silver_processed IS NULL
    """)

    # ── Tenant isolation policies ────────────────────────────────────────
    # PostgreSQL has no `CREATE POLICY IF NOT EXISTS`, so guard with a lookup
    # in pg_policies before issuing the CREATE.
    for table in ("silver_events", "quarantine_events"):
        op.execute(f"""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public'
                      AND tablename = '{table}'
                      AND policyname = 'tenant_isolation_{table}'
                ) THEN
                    EXECUTE format(
                        'CREATE POLICY tenant_isolation_{table} ON {table} FOR ALL TO PUBLIC USING (org_id = current_setting(''app.current_org_id'')::UUID)'
                    );
                END IF;
            END
            $$;
        """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_retention_log_policy")
    op.execute("DROP TABLE IF EXISTS data_retention_log CASCADE")

    op.execute("DROP INDEX IF EXISTS idx_clickhouse_fallback_unresolved")
    op.execute("DROP INDEX IF EXISTS idx_clickhouse_fallback_table")
    op.execute("DROP TABLE IF EXISTS clickhouse_fallback CASCADE")

    op.execute("DROP INDEX IF EXISTS idx_lineage_runs_recorded_at")
    op.execute("DROP INDEX IF EXISTS idx_lineage_runs_job_name")
    op.execute("DROP TABLE IF EXISTS lineage_runs CASCADE")

    op.execute("DROP INDEX IF EXISTS idx_quality_reports_table")
    op.execute("DROP TABLE IF EXISTS data_quality_reports CASCADE")

    op.execute("DROP INDEX IF EXISTS idx_quarantine_events_resolution")
    op.execute("DROP INDEX IF EXISTS idx_quarantine_events_org")
    op.execute("DROP TABLE IF EXISTS quarantine_events CASCADE")

    op.execute("DROP INDEX IF EXISTS idx_silver_events_agent_name")
    op.execute("DROP INDEX IF EXISTS idx_silver_events_trace_id")
    op.execute("DROP INDEX IF EXISTS idx_silver_events_job_id")
    op.execute("DROP INDEX IF EXISTS idx_silver_events_event_type")
    op.execute("DROP INDEX IF EXISTS idx_silver_events_org_timestamp")
    op.execute("DROP TABLE IF EXISTS silver_events CASCADE")

    op.execute("ALTER TABLE usage_events DROP COLUMN IF EXISTS silver_processed")
    op.execute("ALTER TABLE usage_events DROP COLUMN IF EXISTS silver_processed_at")
    op.execute("DROP INDEX IF EXISTS idx_usage_events_silver_unprocessed")
