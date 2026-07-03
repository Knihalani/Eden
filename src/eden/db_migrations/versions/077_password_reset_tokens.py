"""077 — password_reset_tokens table.

Revision ID: 077
Revises: 076
Create Date: 2026-07-01

The /auth/forgot-password endpoint mints a token and inserts a row
into ``password_reset_tokens``; the table itself was never declared
in a migration, so production deployments would fail on the first
reset request.

Schema notes:
  * ``token_hash`` stores the SHA-256 of the random token — the
    plaintext token only ever exists in the email link. If the
    table is leaked, no token is directly usable.
  * ``expires_at`` is the absolute deadline; the route rejects
    expired tokens even before the row is fetched by date.
  * ``used_at`` enforces single-use; the route marks it on
    successful reset and refuses any later submission.
  * ``created_at`` lets us GC expired rows on a cron schedule.
  * ``ip_address`` and ``user_agent`` are recorded for the audit
    trail (NOT security-relevant — they can be spoofed, so the
    reset itself is the authoritative signal).
"""

from alembic import op
import sqlalchemy as sa

revision = "077"
down_revision = "076"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "password_reset_tokens",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("user_id", sa.String(length=128), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ip_address", sa.String(length=64), nullable=True),
        sa.Column("user_agent", sa.String(length=512), nullable=True),
    )
    op.create_index(
        "idx_password_reset_tokens_token_hash",
        "password_reset_tokens",
        ["token_hash"],
        unique=True,
    )
    op.create_index(
        "idx_password_reset_tokens_user_id",
        "password_reset_tokens",
        ["user_id"],
    )


def downgrade() -> None:
    op.drop_index("idx_password_reset_tokens_user_id", table_name="password_reset_tokens")
    op.drop_index("idx_password_reset_tokens_token_hash", table_name="password_reset_tokens")
    op.drop_table("password_reset_tokens")