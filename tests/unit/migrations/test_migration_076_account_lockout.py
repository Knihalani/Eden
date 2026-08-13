"""Migration 076 — account lockout columns on users.

The migration adds three columns used by the /auth/login lockout
defence:
  * failed_login_count      — rolling counter, reset on success
  * locked_until             — TIMESTAMPTZ, NULL when unlocked
  * last_failed_login_at     — TIMESTAMPTZ, ages out the counter

This test imports the migration as source so it runs without a
database connection — the structure of the upgrade/downgrade is
verified, not its on-disk effect.
"""

import importlib.util
from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).resolve().parents[3]
    / "src/eden/db_migrations/versions/000_squash_001_160.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("migration_squash", MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_revision_chain():
    module = _load_migration()
    assert module.revision == "160_signal_definitions_org_enabled_created"
    assert module.down_revision is None


def test_migration_has_upgrade_and_downgrade():
    module = _load_migration()
    assert callable(module.upgrade)
    assert callable(module.downgrade)


def test_migration_adds_expected_columns():
    """Inspect the upgrade source for the three new columns."""
    src = MIGRATION_PATH.read_text()
    assert "failed_login_count" in src
    assert "locked_until" in src
    assert "last_failed_login_at" in src


def test_migration_downgrade_raises_not_implemented():
    src = MIGRATION_PATH.read_text()
    # The squash boundary downgrade raises NotImplementedError — roll back via DB backup.
    downgrade_body = src.split("def downgrade()", 1)[1]
    assert "NotImplementedError" in downgrade_body
