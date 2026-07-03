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

IDEMPOTENCY (audit 2026-07-03) — pre-fix the upgrade used
``op.add_column`` which raises ``DuplicateColumnError`` on a
re-run after a partial failure. Switched to raw
``ALTER TABLE ... ADD COLUMN IF NOT EXISTS`` so the migration
is safe to re-apply (e.g. after a half-migrated deploy). The
downgrade keeps ``op.drop_column`` because DROP COLUMN IF
EXISTS is harmless and preserves Alembic's autogenerate
symmetry.
"""

from alembic import op

revision = "076"
down_revision = "075"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Raw SQL with IF NOT EXISTS so a re-run on a half-migrated DB
    # is a no-op rather than a hard failure.
    # Equivalent (in spirit) to:
    #   op.add_column("users", sa.Column("failed_login_count", ...))
    #   op.add_column("users", sa.Column("locked_until", ...))
    #   op.add_column("users", sa.Column("last_failed_login_at", ...))
    #   op.add_column("users", sa.Column("token_version", ...))
    #   op.add_column("users", sa.Column("last_seen_at", ...))
    op.execute(
        "ALTER TABLE users "
        "ADD COLUMN IF NOT EXISTS failed_login_count INTEGER "
        "NOT NULL DEFAULT 0"
    )
    op.execute(
        "ALTER TABLE users "
        "ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ"
    )
    op.execute(
        "ALTER TABLE users "
        "ADD COLUMN IF NOT EXISTS last_failed_login_at TIMESTAMPTZ"
    )
    # token_version is bumped on password change / reset / account
    # deletion. The change-password route has used it since 2026-06
    # without a declaring migration — this commit adds the column
    # so the existing UPDATE statements stop failing in fresh DBs.
    op.execute(
        "ALTER TABLE users "
        "ADD COLUMN IF NOT EXISTS token_version INTEGER "
        "NOT NULL DEFAULT 0"
    )
    # last_seen_at backs the idle-timeout check in get_current_user.
    # Updated best-effort on every authenticated request; if a
    # token's iat predates ``last_seen_at - 30min`` the request is
    # rejected as idle-expired.
    op.execute(
        "ALTER TABLE users "
        "ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ"
    )


def downgrade() -> None:
    # drop_column is idempotent in Postgres 9.6+ (drops are no-ops
    # if the column is already gone) so we keep the sa-level API
    # here for Alembic autogenerate symmetry.
    op.drop_column("users", "last_seen_at")
    op.drop_column("users", "token_version")
    op.drop_column("users", "last_failed_login_at")
    op.drop_column("users", "locked_until")
    op.drop_column("users", "failed_login_count")
