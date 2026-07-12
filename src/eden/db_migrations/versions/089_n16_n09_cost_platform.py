"""089 — N16 sampling summaries + N09 span content blobs.

Revision ID: 089
Revises: 088
Create Date: 2026-07-12

Wave 2 cost platform:
  * ``trace_sampling_summaries`` — metrics-only rows for N16 drops
  * ``span_content_blobs`` — org-scoped content-addressed payloads (N09)

Both tables are ``IF NOT EXISTS`` so upgrades are idempotent.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "089"
down_revision: str | Sequence[str] | None = "088"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS trace_sampling_summaries (
            org_id TEXT NOT NULL,
            trace_id TEXT NOT NULL,
            agent_id TEXT,
            duration_ms INT NOT NULL DEFAULT 0,
            cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
            span_count INT NOT NULL DEFAULT 0,
            dropped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            drop_reason TEXT NOT NULL DEFAULT 'sampled_out',
            PRIMARY KEY (org_id, trace_id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_trace_sampling_summaries_dropped
        ON trace_sampling_summaries (org_id, dropped_at DESC)
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS span_content_blobs (
            org_id TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            content BYTEA NOT NULL,
            content_type TEXT NOT NULL,
            byte_size INT NOT NULL,
            ref_count BIGINT NOT NULL DEFAULT 1,
            first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (org_id, content_hash)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_span_content_blobs_type
        ON span_content_blobs (org_id, content_type)
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS span_content_blobs")
    op.execute("DROP TABLE IF EXISTS trace_sampling_summaries")
