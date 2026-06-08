"""Add password reset columns to users table.

Revision ID: 003
Revises: 002
Create Date: 2026-05-30 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add password reset token and expiry to users table
    op.execute("""
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS password_reset_token TEXT,
        ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users (password_reset_token)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_users_reset_token")
    op.execute("""
        ALTER TABLE users
        DROP COLUMN IF EXISTS password_reset_token,
        DROP COLUMN IF EXISTS password_reset_expires_at
    """)
