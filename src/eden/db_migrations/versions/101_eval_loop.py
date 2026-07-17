"""101 — Phase 4 eval loop: datasets hub, offline experiments, regression runs, labeling queues."""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "101_eval_loop"
down_revision: str | Sequence[str] | None = "100_artifacts_ledger"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS datasets (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            source_type TEXT NOT NULL DEFAULT 'manual',
            source_ref TEXT,
            version INT NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (org_id, name)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_datasets_org ON datasets (org_id, created_at DESC)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS dataset_items (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            dataset_id UUID NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
            input TEXT NOT NULL DEFAULT '',
            expected_output TEXT NOT NULL DEFAULT '',
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            origin_trace_id TEXT,
            origin_issue_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_dataset_items_dataset "
        "ON dataset_items (dataset_id, created_at DESC)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS dataset_snapshots (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            dataset_id UUID NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
            org_id VARCHAR(128) NOT NULL,
            version INT NOT NULL,
            row_count INT NOT NULL DEFAULT 0,
            snapshot_data JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS offline_experiments (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            name TEXT NOT NULL,
            dataset_id UUID NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
            dataset_snapshot_id UUID,
            config JSONB NOT NULL DEFAULT '{}'::jsonb,
            baseline_experiment_id UUID,
            source_issue_id TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS experiment_datapoints (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            experiment_id UUID NOT NULL REFERENCES offline_experiments(id) ON DELETE CASCADE,
            row_id UUID,
            input_data JSONB NOT NULL DEFAULT '{}'::jsonb,
            control_output JSONB NOT NULL DEFAULT '{}'::jsonb,
            treatment_output JSONB NOT NULL DEFAULT '{}'::jsonb,
            grade TEXT,
            score_delta DOUBLE PRECISION,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS regression_eval_runs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            agent_id TEXT,
            change_id TEXT,
            passed INT NOT NULL DEFAULT 0,
            failed INT NOT NULL DEFAULT 0,
            failures JSONB NOT NULL DEFAULT '[]'::jsonb,
            status TEXT NOT NULL DEFAULT 'completed',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_regression_eval_runs_org "
        "ON regression_eval_runs (org_id, created_at DESC)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS labeling_queues (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id VARCHAR(128) NOT NULL,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            schema JSONB NOT NULL DEFAULT '{}'::jsonb,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (org_id, name)
        )
        """
    )
    # Legacy SQL migration 035 created labeling_items; some prod DBs never
    # received it. Create a compatible base table before queue columns.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS labeling_items (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            source_trace_id TEXT,
            source_span_id TEXT,
            source_dataset_id UUID,
            source_synthetic_qa_id TEXT,
            payload JSONB NOT NULL DEFAULT '{}'::jsonb,
            label_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
            prompt TEXT,
            -- users.id is TEXT in prod (Clerk/Eden hybrid ids); keep assigned_to TEXT.
            assigned_to TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            tags TEXT[] NOT NULL DEFAULT '{}',
            annotations_required INT NOT NULL DEFAULT 1,
            required_skills TEXT[] NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        """
        ALTER TABLE labeling_items
        ADD COLUMN IF NOT EXISTS queue_id UUID REFERENCES labeling_queues(id) ON DELETE SET NULL
        """
    )
    op.execute(
        """
        ALTER TABLE labeling_items
        ADD COLUMN IF NOT EXISTS kanban_status TEXT NOT NULL DEFAULT 'todo'
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE labeling_items DROP COLUMN IF EXISTS kanban_status")
    op.execute("ALTER TABLE labeling_items DROP COLUMN IF EXISTS queue_id")
    op.execute("DROP TABLE IF EXISTS labeling_queues")
    op.execute("DROP TABLE IF EXISTS regression_eval_runs")
    op.execute("DROP TABLE IF EXISTS experiment_datapoints")
    op.execute("DROP TABLE IF EXISTS offline_experiments")
    op.execute("DROP TABLE IF EXISTS dataset_snapshots")
    op.execute("DROP TABLE IF EXISTS dataset_items")
    op.execute("DROP TABLE IF EXISTS datasets")
