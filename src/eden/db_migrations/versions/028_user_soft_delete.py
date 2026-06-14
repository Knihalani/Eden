"""028_user_soft_delete — add ``users.deleted_at`` for account deletion.

Revision ID: 028
Revises: 027
Create Date: 2026-06-14

Phase A.4 introduces the ``DELETE /users/me`` endpoint, which soft-deletes
the user's account rather than hard-deleting (preserves referential
integrity in ``org_audit_log``, ``usage_events``, etc.). The column is
nullable; a non-null value means the account is deleted.

``/auth/login`` and ``/auth/me`` are updated to filter out rows where
``deleted_at IS NOT NULL`` so a deleted user cannot log back in.
"""

from __future__ import annotations

from alembic import op

# revision identifiers, used by Alembic.
revision = "028"
down_revision = "027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ
    """)
    # Partial index so the live-user query path stays fast.
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_users_live
        ON users (id) WHERE deleted_at IS NULL
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_users_live")
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS deleted_at")
