"""114 — org_api_keys soft-revoke columns (active / revoked_at).

Revision ID: 114_org_api_keys_soft_revoke
Revises: 113_a7_search_trgm_indexes
Create Date: 2026-07-19

``get_current_org_api_key`` already SELECTs ``active`` / ``revoked_at``.
Without these columns auth 500s on Postgres. Additive soft-revoke
fields matching the S-5 pre-flight checks.
"""

from __future__ import annotations

from alembic import op

revision: str = "114_org_api_keys_soft_revoke"
down_revision: str = "113_a7_search_trgm_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE org_api_keys
            ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE
        """
    )
    op.execute(
        """
        ALTER TABLE org_api_keys
            ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE org_api_keys DROP COLUMN IF EXISTS revoked_at")
    op.execute("ALTER TABLE org_api_keys DROP COLUMN IF EXISTS active")
