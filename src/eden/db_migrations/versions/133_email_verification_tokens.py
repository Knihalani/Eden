"""133 — email_verification_tokens table.

Revision ID: 133_email_verification_tokens
Revises: 132_plan_parent
Create Date: 2026-08-02

The password-signup path (``api/routes/auth.py``) mints an email
verification token per new user; the table it inserts into was never
declared, so with ``email_verification_enabled`` on, every signup would
have raised ``UndefinedTable``. Ships together with
``email_service.send_verification_email`` and the
``/auth/verify-email`` route — see ``docs/ops/disabled-features.md``
§1c, whose re-enable condition is exactly "table + sender + route
together".

Schema mirrors ``077_password_reset_tokens``:
  * ``token_hash`` stores the SHA-256 of the random token — the
    plaintext token only ever exists in the email link.
  * ``expires_at`` is the absolute deadline (24h; resets get 1h).
  * ``used_at`` enforces single-use; the verify route marks it and
    sets ``users.email_verified = TRUE`` in the same transaction.
  * ``created_at`` lets us GC expired rows on a cron schedule.

Raw SQL ``CREATE TABLE IF NOT EXISTS`` / ``CREATE INDEX IF NOT EXISTS``
so a half-migrated DB recovers with `alembic upgrade head` (same
idempotency lesson as 077).
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "133_email_verification_tokens"
down_revision: str | Sequence[str] | None = "132_plan_parent"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS email_verification_tokens (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id VARCHAR(128) NOT NULL,
            token_hash VARCHAR(64) NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_email_verification_tokens_token_hash "
        "ON email_verification_tokens (token_hash)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user_id "
        "ON email_verification_tokens (user_id)"
    )


def downgrade() -> None:
    op.drop_index(
        "idx_email_verification_tokens_user_id",
        table_name="email_verification_tokens",
    )
    op.drop_index(
        "idx_email_verification_tokens_token_hash",
        table_name="email_verification_tokens",
    )
    op.drop_table("email_verification_tokens")
