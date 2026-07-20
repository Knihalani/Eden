"""115 — org_api_keys key_prefix + created_by (portal API keys).

Revision ID: 115_api_keys_prefix
Revises: 114_org_api_keys_soft_revoke
Create Date: 2026-07-20

Prod ``org_api_keys`` matched the slim 001 schema (hash + scopes) but
``api_keys.py`` SELECT/INSERT expects ``key_prefix`` and ``created_by``.
Missing columns → UndefinedColumnError → unhandled 500 on list/create.

Revision id kept ≤32 chars (``alembic_version.version_num`` width).
"""

from __future__ import annotations

from alembic import op

revision: str = "115_api_keys_prefix"
down_revision: str = "114_org_api_keys_soft_revoke"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Display suffix shown in the portal keys table (last 8 of raw key).
    op.execute(
        """
        ALTER TABLE org_api_keys
            ADD COLUMN IF NOT EXISTS key_prefix TEXT NOT NULL DEFAULT ''
        """
    )
    # Who minted the key. Prod ``users.id`` is TEXT (Clerk-era), not UUID —
    # a UUID FK fails with DatatypeMismatchError. Keep TEXT, no FK.
    op.execute(
        """
        ALTER TABLE org_api_keys
            ADD COLUMN IF NOT EXISTS created_by TEXT
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE org_api_keys DROP COLUMN IF EXISTS created_by")
    op.execute("ALTER TABLE org_api_keys DROP COLUMN IF EXISTS key_prefix")
