"""016_trace_patterns — Phase 7.2 C5 Datadog-style Patterns.

Revision ID: 016
Revises: 015
Create Date: 2026-06-05

Adds the ``trace_patterns`` table that the Patterns clusterer
populates. Each row is a topic cluster: traces that share a
semantic pattern (e.g. "summarize a contract clause") are
grouped under one pattern, with:

  - ``topic_label``: short LLM-generated label (e.g. "contract
    clause summarization")
  - ``coherence_score``: mean intra-cluster cosine similarity
  - ``sample_count``: how many traces fall into this cluster
  - ``representative_trace_ids``: up to 10 traces shown in the
    portal so the user can click through and inspect

The portal reads from this table to render the Patterns page
(``/observability/patterns``) and the coverage-gap markers
(🟢 covered, 🟡 partial, 🔴 no coverage).
"""

from alembic import op

revision = "016"
down_revision = "015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The ``patterns`` table is already a reserved keyword in
    # PostgreSQL (CREATE EXTENSION). We use ``trace_patterns`` to
    # avoid quoting.
    op.execute("""
        CREATE TABLE IF NOT EXISTS trace_patterns (
            pattern_id              UUID PRIMARY KEY,
            tenant_id               VARCHAR(128) NOT NULL,
            name                    VARCHAR(256) NOT NULL,
            description             TEXT,
            topic_label             VARCHAR(256) NOT NULL,
            coherence_score         DOUBLE PRECISION,
            sample_count            INT NOT NULL DEFAULT 0,
            representative_trace_ids TEXT[] NOT NULL DEFAULT '{}',
            first_seen              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            status                  VARCHAR(32) NOT NULL DEFAULT 'active',
            metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
            UNIQUE (tenant_id, topic_label, first_seen)
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_tp_tenant_count
        ON trace_patterns (tenant_id, sample_count DESC)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_tp_tenant_status
        ON trace_patterns (tenant_id, status, last_seen DESC)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_tp_tenant_status")
    op.execute("DROP INDEX IF EXISTS idx_tp_tenant_count")
    op.execute("DROP TABLE IF EXISTS trace_patterns")
