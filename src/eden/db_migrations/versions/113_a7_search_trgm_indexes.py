"""113 — A7 search/trgm indexes (pg_trgm + jobs request::text).

Revision ID: 113_a7_search_trgm_indexes
Revises: 112_w28_f64_f34_mcp
Create Date: 2026-07-18

Supports Wave-1 A7:
* K31 — gin_trgm indexes for telemetry_events ILIKE search fallback
* K33 — expression index on jobs.request::text for list_jobs q=

Additive-only. Forward-compat: yes. Downgrade risk: none.
"""

from __future__ import annotations

from alembic import op

revision: str = "113_a7_search_trgm_indexes"
down_revision: str = "112_w28_f64_f34_mcp"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_name_trgm
        ON telemetry_events USING gin (name gin_trgm_ops)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_telemetry_events_agent_id_trgm
        ON telemetry_events USING gin (agent_id gin_trgm_ops)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_jobs_job_id_trgm
        ON jobs USING gin (job_id gin_trgm_ops)
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_jobs_request_text_trgm
        ON jobs USING gin ((request::text) gin_trgm_ops)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_jobs_request_text_trgm")
    op.execute("DROP INDEX IF EXISTS idx_jobs_job_id_trgm")
    op.execute("DROP INDEX IF EXISTS idx_telemetry_events_agent_id_trgm")
    op.execute("DROP INDEX IF EXISTS idx_telemetry_events_name_trgm")
