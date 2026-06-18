"""Add password_changed_at to users table for session invalidation.

Revision ID: 005
Revises: 004
Create Date: 2026-05-30 00:00:00.000000

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "005"
down_revision: str | None = "004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Add password_changed_at to users table for session invalidation on password reset
    op.add_column(
        "users",
        sa.Column("password_changed_at", sa.DateTime(timezone=True), server_default=sa.text("NOW()"), nullable=True),
    )
    op.create_index("idx_users_password_changed_at", "users", ["password_changed_at"])


def downgrade() -> None:
    op.drop_index("idx_users_password_changed_at", table_name="users")
    op.drop_column("users", "password_changed_at")
