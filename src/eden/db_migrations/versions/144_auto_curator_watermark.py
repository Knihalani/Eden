"""144 — watermark table for auto_curator's daily org selection (OPT-3).

Revision ID: 144_auto_curator_watermark
Revises: 143_signal_events_indexes
Create Date: 2026-08-05

``cron_tick._run_auto_curator`` selected its batch of orgs with
``SELECT id::text AS org_id FROM organizations LIMIT 50`` — no
``ORDER BY``, no time-window floor. Postgres has no obligation to vary
that plan's output, and in practice doesn't, so this ran the *same*
stable-but-arbitrary 50 orgs every single day forever; everything past
row 50 was silently starved, and the excluded set only grew as the org
base grew. It never raised, so nothing ever paged on it.

This table is the durable "when did we last run this org" watermark
that ``eden.storage.watermark.fetch_stale_candidates`` /
``advance_watermark`` left-join / upsert against, mirroring the
in-table idiom ``columnar_partitions.last_compaction_at`` already uses
(``ORDER BY ... ASC NULLS FIRST``, see 022_columnar_engine). One row
per org; a never-processed org has no row (NULL sorts first), so the
FIFO ordering naturally covers newly-created orgs before recycling
back through already-processed ones.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "144_auto_curator_watermark"
down_revision: str | Sequence[str] | None = "143_signal_events_indexes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS auto_curator_watermark (
            org_id UUID PRIMARY KEY
                REFERENCES organizations(id) ON DELETE CASCADE,
            last_processed_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS auto_curator_watermark_last_processed_idx
        ON auto_curator_watermark (last_processed_at)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS auto_curator_watermark_last_processed_idx")
    op.execute("DROP TABLE IF EXISTS auto_curator_watermark")
