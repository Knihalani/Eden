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
"""

from alembic import op
import sqlalchemy as sa

revision = "078"
down_revision = "077"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "two_factor_recovery_codes",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("user_id", sa.String(length=128), nullable=False),
        # SHA-256 of the recovery code in hex (64 chars).
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "idx_recovery_codes_user",
        "two_factor_recovery_codes",
        ["user_id"],
    )
    op.create_index(
        "idx_recovery_codes_code_hash",
        "two_factor_recovery_codes",
        ["code_hash"],
    )


def downgrade() -> None:
    op.drop_index("idx_recovery_codes_code_hash", table_name="two_factor_recovery_codes")
    op.drop_index("idx_recovery_codes_user", table_name="two_factor_recovery_codes")
    op.drop_table("two_factor_recovery_codes")