"""078 — two_factor_recovery_codes table.

Revision ID: 078
Revises: 077
Create Date: 2026-07-01

Each row is a single-use recovery code for a user that has 2FA
enabled. The plaintext code is shown to the user ONCE at generation
time; only the SHA-256 hash is stored, so a DB leak cannot
reproduce usable codes.

When a user loses their TOTP device they submit a recovery code
via /auth/2fa/recover; the server hashes the submitted value,
looks it up, marks it used, and (optionally) clears 2FA so the
account is recoverable.

IDEMPOTENCY (audit 2026-07-03) — pre-fix ``op.create_table`` raised
on a re-run after a partial failure. Switched to raw SQL
``CREATE TABLE IF NOT EXISTS`` + ``CREATE INDEX IF NOT EXISTS``
so a half-migrated DB can recover with `alembic upgrade head`
rather than manual intervention. Downgrade keeps sa-level ops
for Alembic autogenerate symmetry.
"""

from alembic import op

revision = "078"
down_revision = "077"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Equivalent (in spirit) to:
    #   op.create_table(
    #       "two_factor_recovery_codes",
    #       sa.Column("id", UUID, primary_key=True,
    #                 server_default=sa.text("gen_random_uuid()")),
    #       sa.Column("user_id", String(128), nullable=False),
    #       sa.Column("code_hash", String(64), nullable=False),
    #       sa.Column("used_at", DateTime(timezone=True)),
    #       sa.Column("created_at", DateTime(timezone=True), nullable=False),
    #   )
    # The CREATE TABLE IF NOT EXISTS form is idempotent on re-run.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS two_factor_recovery_codes (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id VARCHAR(128) NOT NULL,
            code_hash VARCHAR(64) NOT NULL,
            used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_recovery_codes_user "
        "ON two_factor_recovery_codes (user_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_recovery_codes_code_hash "
        "ON two_factor_recovery_codes (code_hash)"
    )


def downgrade() -> None:
    op.drop_index("idx_recovery_codes_code_hash", table_name="two_factor_recovery_codes")
    op.drop_index("idx_recovery_codes_user", table_name="two_factor_recovery_codes")
    op.drop_table("two_factor_recovery_codes")
