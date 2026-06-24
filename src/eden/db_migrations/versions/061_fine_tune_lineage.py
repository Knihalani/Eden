"""061_fine_tune_lineage — D.12.5 Fine-tune lineage per upgradespec §B.9.

Revision ID: 061
Revises: 060
Create Date: 2026-06-24

Per spec §B.9 (D.12.5):

    CREATE TABLE fine_tuning_runs (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id              UUID NOT NULL,
        provider            TEXT NOT NULL,    -- 'openai' | 'together' | 'anyscale'
        base_model          TEXT NOT NULL,
        fine_tuned_model    TEXT NOT NULL,
        dataset_id          UUID NOT NULL,
        training_params     JSONB NOT NULL DEFAULT '{}'::jsonb,
        status              TEXT NOT NULL DEFAULT 'pending',
        eval_results        JSONB,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at        TIMESTAMPTZ
    );

    CREATE TABLE dataset_trace_lineage (
        dataset_id          UUID NOT NULL,
        trace_id            UUID NOT NULL,
        span_id             UUID,
        added_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (dataset_id, trace_id)
    );

    CREATE TABLE fine_tune_trace_usage (
        fine_tuning_run_id  UUID NOT NULL REFERENCES fine_tuning_runs(id),
        trace_id            UUID NOT NULL,
        first_used_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (fine_tuning_run_id, trace_id)
    );

Ponytail:
* ``org_id`` switched from UUID to VARCHAR(128) for spine-style
  org scoping (matches the D.12.1-4 services).
* Idempotency: ``fine_tuning_runs(id)`` is server-generated but
  the webhook ingest is keyed on the provider's
  ``fine_tune_id`` (stored in the unique-on
  ``(provider, fine_tune_id)`` index) so re-deliveries
  don't double-write. This is risk R-12 in the spec.
* Indices: ``(org_id, created_at DESC)`` for the runs list
  + ``(org_id, status)`` for the dashboard filter
  + ``(provider, fine_tune_id)`` for webhook idempotency.
"""

from __future__ import annotations

from alembic import op

revision = "061"
down_revision = "060"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS fine_tuning_runs (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id              VARCHAR(128) NOT NULL,
            provider            TEXT NOT NULL,
            provider_fine_tune_id TEXT,
            base_model          TEXT NOT NULL,
            fine_tuned_model    TEXT NOT NULL,
            dataset_id          UUID NOT NULL,
            training_params     JSONB NOT NULL DEFAULT '{}'::jsonb,
            status              TEXT NOT NULL DEFAULT 'pending',
            eval_results        JSONB,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at        TIMESTAMPTZ
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_fine_tuning_runs_org "
        "ON fine_tuning_runs(org_id, created_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_fine_tuning_runs_org_status "
        "ON fine_tuning_runs(org_id, status)"
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_fine_tuning_provider_id "
        "ON fine_tuning_runs(provider, provider_fine_tune_id) "
        "WHERE provider_fine_tune_id IS NOT NULL"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS dataset_trace_lineage (
            dataset_id          UUID NOT NULL,
            trace_id            UUID NOT NULL,
            span_id             UUID,
            added_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (dataset_id, trace_id)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_dataset_trace_lineage_trace "
        "ON dataset_trace_lineage(trace_id)"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS fine_tune_trace_usage (
            fine_tuning_run_id  UUID NOT NULL
                                REFERENCES fine_tuning_runs(id) ON DELETE CASCADE,
            trace_id            UUID NOT NULL,
            first_used_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (fine_tuning_run_id, trace_id)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_fine_tune_trace_usage_trace "
        "ON fine_tune_trace_usage(trace_id)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_fine_tune_trace_usage_trace")
    op.execute("DROP TABLE IF EXISTS fine_tune_trace_usage")
    op.execute("DROP INDEX IF EXISTS idx_dataset_trace_lineage_trace")
    op.execute("DROP TABLE IF EXISTS dataset_trace_lineage")
    op.execute("DROP INDEX IF EXISTS uq_fine_tuning_provider_id")
    op.execute("DROP INDEX IF EXISTS idx_fine_tuning_runs_org_status")
    op.execute("DROP INDEX IF EXISTS idx_fine_tuning_runs_org")
    op.execute("DROP TABLE IF EXISTS fine_tuning_runs")
