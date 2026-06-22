"""047 — Clerk user provisioning (June 2026 cutover fix).

Revision ID: 047
Revises: 046
Create Date: 2026-06-22

The June 17 Clerk cutover moved end-user auth to Clerk. Two bugs
surfaced immediately but stayed invisible until a real user signed up
on June 21:

1. ``/auth/me`` auto-provision tries ``INSERT INTO users (id, email,
   name, ...)`` — but ``password_hash`` is ``NOT NULL`` (set in
   migration 001). The INSERT fails with a constraint violation.
   The ``try/except`` swallows it; the user gets 404.

2. Clerk user IDs are strings like ``user_2abc...`` (Clerk's default
   ``user_`` prefix + base62). ``users.id`` is a Postgres ``UUID``
   column, so the INSERT fails with ``invalid input syntax for type
   uuid``. Same silent ``except`` branch; same 404.

The Clerk webhook (``src/eden/api/routes/clerk_webhooks.py:_upsert_user``)
has the same two bugs — every webhook delivery since the cutover has
been failing. Users exist in Clerk but never in Postgres.

This migration fixes both:

- ``password_hash`` becomes ``NULL``-able. Clerk-managed users have
  no password; the legacy Eden-direct /signup path still uses bcrypt.
- ``clerk_id TEXT UNIQUE`` stores Clerk's string id. Existing UUID PK
  is preserved so every existing FK (``org_members.user_id``,
  ``organizations.owner_id``, ``notifications.user_id``, etc.)
  keeps pointing at the same rows.
- ``idx_users_clerk_id`` makes the ``/auth/me`` + webhook lookup
  hot path O(log n).

Upgrade is non-destructive: existing rows keep their UUID PK and
bcrypt hash; ``clerk_id`` is just NULL for them. Downgrade drops the
index + column and re-applies ``NOT NULL`` (the ``NOT NULL``
re-application is guarded by an EXISTS check so a downgrade after
any Clerk row has been inserted will fail loudly instead of silently
corrupting data — at that point the operator has to drop the Clerk
rows first).
"""

from __future__ import annotations

import logging

from alembic import op

logger = logging.getLogger(__name__)


revision = "047"
down_revision = "046"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Make password_hash nullable. Clerk-managed users have no
    #    password; the legacy /signup path still writes a bcrypt
    #    hash and continues to work. Required so both /auth/me
    #    auto-provision AND clerk_webhooks._upsert_user can INSERT.
    op.execute("ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL")

    # 2. Add clerk_id column. UNIQUE so webhook re-deliveries are
    #    idempotent (ON CONFLICT (clerk_id) DO UPDATE). NOT NULL is
    #    deliberately omitted — legacy Eden-direct users don't have
    #    a Clerk id and shouldn't be forced into one.
    op.execute(
        """
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS clerk_id TEXT UNIQUE
        """
    )

    # 3. Lookup-by-clerk-id is on every /auth/me and webhook hit.
    #    The UNIQUE constraint already creates an index, but be
    #    explicit so a future drop-and-recreate doesn't lose it.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_users_clerk_id ON users(clerk_id) "
        "WHERE clerk_id IS NOT NULL"
    )


def downgrade() -> None:
    # Drop the partial index first (Postgres needs the index gone
    # before the column constraint can be re-applied with a unique
    # index, but in our case we're dropping the column entirely so
    # order doesn't matter — keep it simple).
    op.execute("DROP INDEX IF EXISTS idx_users_clerk_id")

    # Refuse to drop clerk_id if any rows reference it. Better a
    # loud failure than a silent data loss — operator can purge the
    # Clerk-only rows first if a downgrade is genuinely required.
    clerk_row_count = op.get_bind().execute(
        "SELECT COUNT(*) FROM users WHERE clerk_id IS NOT NULL"
    ).scalar()
    if clerk_row_count and clerk_row_count > 0:
        raise RuntimeError(
            f"Refusing to drop clerk_id column while {clerk_row_count} "
            f"row(s) still reference it. Delete those users first."
        )
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS clerk_id")

    # Re-apply NOT NULL — but ONLY if no row is currently NULL.
    # (The guard above already ensured the table is empty of Clerk
    # rows, so all remaining users have a password_hash.)
    op.execute("ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL")
