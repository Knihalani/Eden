"""162 — nullable ``split`` tag on ``dataset_items`` (FEAT-167).

Revision ID: 162_dataset_items_split
Revises: 161_retention_archive_watermark
Create Date: 2026-08-06

LangSmith-style subset tag for eval subsetting (e.g. ``"smoke"``,
``"full"``). Nullable so existing rows stay valid; callers that care
about splits pass it on create and read it back on list.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "162_dataset_items_split"
down_revision: str | Sequence[str] | None = "161_retention_archive_watermark"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE dataset_items ADD COLUMN IF NOT EXISTS split TEXT"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE dataset_items DROP COLUMN IF EXISTS split")
