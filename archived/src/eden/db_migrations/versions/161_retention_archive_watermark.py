"""161 — watermark table for retention_cron cold-archive org selection (OPT-52).

Revision ID: 161_retention_archive_watermark
Revises: 160_signal_definitions_org_enabled_created
Create Date: 2026-08-06

``retention_cron._list_orgs_with_old_traces`` previously scanned
``telemetry_events`` with ``SELECT DISTINCT tenant_id ... LIMIT 1000``
and no durable "when did we last archive this org" state. Combined with
an unordered org walk, a poison org that always fails could sit at the
front of every daily run while healthy orgs behind it starved.

This table is the durable oldest-processed-first watermark that
``eden.storage.watermark.fetch_stale_candidates`` /
``advance_watermark`` left-join / upsert against — same idiom as
``auto_curator_watermark`` (144). One row per org (``tenant_id``);
never-processed orgs have no row (NULL sorts first). ``archive_old_rows``
is a no-op for orgs without rows older than their warm window, so
candidate selection does not need a second telemetry pre-filter.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "161_retention_archive_watermark"
down_revision: str | Sequence[str] | None = "160_signal_definitions_org_enabled_created"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS retention_archive_watermark (
            tenant_id UUID PRIMARY KEY
                REFERENCES organizations(id) ON DELETE CASCADE,
            last_processed_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS retention_archive_watermark_last_processed_idx
        ON retention_archive_watermark (last_processed_at)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS retention_archive_watermark_last_processed_idx")
    op.execute("DROP TABLE IF EXISTS retention_archive_watermark")
