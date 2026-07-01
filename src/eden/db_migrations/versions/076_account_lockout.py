"""076 — account lockout columns on users.

Revision ID: 076
Revises: 075
Create Date: 2026-07-01

Adds three columns to ``users`` that back the /auth/login
"lock-after-N-failures" defence:

  * failed_login_count  — rolling counter, reset on success
  * locked_until        — TIMESTAMPTZ, NULL when account is unlocked
  * last_failed_login_at — TIMESTAMPTZ, used to age out the counter

Backoff policy: 5 failed attempts → 5-minute lockout. Each
subsequent lockout doubles (5m → 10m → 20m, capped at 24h).
A successful login resets both counter and lockout.

The lockout check runs server-side in the login route handler,
BEFORE bcrypt verification, so a locked account never even
reveals whether the password would have been valid.

Clerk-managed users (``clerk_id IS NOT NULL``) skip this layer
entirely — Clerk owns their authentication surface.
"""

from alembic import op
import sqlalchemy as sa

revision = "076"
down_revision = "075"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "failed_login_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "users",
        sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column(
            "last_failed_login_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "last_failed_login_at")
    op.drop_column("users", "locked_until")
    op.drop_column("users", "failed_login_count")