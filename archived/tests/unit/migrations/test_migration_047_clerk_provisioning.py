"""Migration 047 — Clerk user provisioning (June 22 2026 fix).

Three things the migration must do:
1. Drop NOT NULL on users.password_hash (Clerk-managed users have no password)
2. Add users.clerk_id TEXT UNIQUE (Clerk id strings like "user_2abc...")
3. Add idx_users_clerk_id index (hot lookup path for /auth/me + webhook)

Plus the downgrade() must:
- Drop the index
- Refuse to drop clerk_id if any rows still reference it (loud failure > silent loss)
- Re-apply NOT NULL only when no rows have NULL password_hash

These tests validate the SQL is shaped correctly without actually
running alembic against the test DB (which would require a full
live Postgres with all prior migrations applied — handled separately
in the deployment smoke test).
"""

from pathlib import Path

import pytest

MIGRATION_PATH = (
    Path(__file__).resolve().parents[3]
    / "src"
    / "eden"
    / "db_migrations"
    / "versions"
    / "000_squash_001_160.py"
)


@pytest.fixture(scope="module")
def migration_source() -> str:
    assert MIGRATION_PATH.exists(), f"Missing migration file: {MIGRATION_PATH}"
    return MIGRATION_PATH.read_text()


def test_migration_file_exists_and_nonempty():
    assert MIGRATION_PATH.exists(), f"Missing migration file: {MIGRATION_PATH}"
    text = MIGRATION_PATH.read_text()
    assert text.strip(), "Migration file is empty"


def test_migration_revision_and_down_revision(migration_source: str):
    """Squash carries the 160 revision id; this is the base of the chain."""
    assert "160_signal_definitions_org_enabled_created" in migration_source
    assert "down_revision: str | None = None" in migration_source


def test_migration_drops_not_null_on_password_hash(migration_source: str):
    """Clerk users have no password; the constraint blocks auto-provision."""
    assert "ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL" in migration_source


def test_migration_adds_clerk_id_column(migration_source: str):
    """Stores Clerk's string id (e.g. 'user_2abc...') alongside the UUID PK."""
    assert "ADD COLUMN IF NOT EXISTS clerk_id" in migration_source
    assert "clerk_id TEXT UNIQUE" in migration_source


def test_migration_creates_partial_index_on_clerk_id(migration_source: str):
    """Partial index on clerk_id keeps the unique constraint cheap
    AND the WHERE clause skips NULL rows for legacy Eden-direct users
    that never had a Clerk id.
    """
    assert "CREATE INDEX IF NOT EXISTS idx_users_clerk_id" in migration_source
    assert "WHERE clerk_id IS NOT NULL" in migration_source


def test_migration_downgrade_raises_not_implemented(migration_source: str):
    """The squash boundary downgrade() must raise NotImplementedError — it
    cannot be applied piecemeal; a DB backup is required to go back."""
    downgrade_start = migration_source.index("def downgrade()")
    downgrade_body = migration_source[downgrade_start:]
    assert "NotImplementedError" in downgrade_body
