"""104 — Phase 7 Wave 8: signal clusters, backfill jobs, topics, N10 jobs."""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "104_wave8_signals"
down_revision: str | Sequence[str] | None = "103_wave7_debugger_browser"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS signal_clusters (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL,
            signal_id UUID NOT NULL REFERENCES signal_definitions(id) ON DELETE CASCADE,
            name TEXT,
            status TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'resolved', 'reopened')),
            event_count INT NOT NULL DEFAULT 0,
            first_seen TIMESTAMPTZ,
            last_seen TIMESTAMPTZ,
            centroid JSONB,
            sample_trace_ids TEXT[] DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_signal_clusters_org_signal "
        "ON signal_clusters (org_id, signal_id, status)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS signal_backfill_jobs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL,
            signal_id UUID NOT NULL REFERENCES signal_definitions(id) ON DELETE CASCADE,
            window_start TIMESTAMPTZ NOT NULL,
            window_end TIMESTAMPTZ NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'complete', 'failed', 'cancelled')),
            traces_total INT,
            traces_done INT NOT NULL DEFAULT 0,
            estimated_cost_usd REAL,
            error TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_signal_backfill_org_status "
        "ON signal_backfill_jobs (org_id, status, created_at DESC)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS search_to_signal_jobs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL,
            saved_search_id UUID,
            signal_id UUID REFERENCES signal_definitions(id) ON DELETE SET NULL,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'complete', 'failed')),
            error TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS topic_clusters (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL,
            facet TEXT NOT NULL DEFAULT 'task'
                CHECK (facet IN ('task', 'sentiment', 'issues', 'custom')),
            name TEXT NOT NULL,
            description TEXT,
            share_pct REAL,
            keywords TEXT[] DEFAULT '{}',
            sample_count INT NOT NULL DEFAULT 0,
            representative_trace_ids TEXT[] DEFAULT '{}',
            pattern_id UUID,
            signal_cluster_id UUID REFERENCES signal_clusters(id) ON DELETE SET NULL,
            status TEXT NOT NULL DEFAULT 'active',
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            first_seen TIMESTAMPTZ,
            last_seen TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_topic_clusters_org_facet "
        "ON topic_clusters (org_id, facet, sample_count DESC)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS topic_clusters")
    op.execute("DROP TABLE IF EXISTS search_to_signal_jobs")
    op.execute("DROP TABLE IF EXISTS signal_backfill_jobs")
    op.execute("DROP TABLE IF EXISTS signal_clusters")
