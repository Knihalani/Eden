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

IDEMPOTENCY (audit 2026-07-03) — pre-fix ``op.create_table`` and
``op.create_index`` raised on a re-run. Switched to raw SQL
``CREATE TABLE IF NOT EXISTS`` + ``CREATE INDEX IF NOT EXISTS``
so a half-migrated DB can recover with `alembic upgrade head`
rather than manual intervention. The downgrade keeps the
sa-level ``op.drop_table`` / ``op.drop_index`` for Alembic
autogenerate symmetry.
"""

from alembic import op

revision = "077"
down_revision = "076"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Equivalent (in spirit) to:
    #   op.create_table(
    #       "password_reset_tokens",
    #       sa.Column("id", UUID, primary_key=True,
    #                 server_default=sa.text("gen_random_uuid()")),
    #       sa.Column("user_id", String(128), nullable=False),
    #       sa.Column("token_hash", String(64), nullable=False),
    #       sa.Column("expires_at", DateTime(timezone=True), nullable=False),
    #       sa.Column("used_at", DateTime(timezone=True)),
    #       sa.Column("created_at", DateTime(timezone=True), nullable=False),
    #       sa.Column("ip_address", String(64)),
    #       sa.Column("user_agent", String(512)),
    #       unique=True on token_hash,
    #   )
    # The CREATE TABLE IF NOT EXISTS form is idempotent on re-run.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id VARCHAR(128) NOT NULL,
            token_hash VARCHAR(64) NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL,
            ip_address VARCHAR(64),
            user_agent VARCHAR(512)
        )
        """
    )
    # create_index on token_hash (unique=True) for O(log N) lookup
    # and to prevent duplicate inserts of the same token hash.
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_password_reset_tokens_token_hash "
        "ON password_reset_tokens (token_hash)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id "
        "ON password_reset_tokens (user_id)"
    )


def downgrade() -> None:
    op.drop_index("idx_password_reset_tokens_user_id", table_name="password_reset_tokens")
    op.drop_index("idx_password_reset_tokens_token_hash", table_name="password_reset_tokens")
    op.drop_table("password_reset_tokens")
