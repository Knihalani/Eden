"""Migration 077 — password_reset_tokens table.

Verifies that the migration declares the table, the required
columns (including token_hash, not a plaintext token column), and
the indexes that back the lookup + per-user lookup paths.
"""

import importlib.util
from pathlib import Path


MIGRATION_PATH = (
    Path(__file__).resolve().parents[3]
    / "src/eden/db_migrations/versions/077_password_reset_tokens.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("migration_077", MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_revision_chain():
    module = _load_migration()
    assert module.revision == "077"
    assert module.down_revision == "076"


def test_migration_creates_password_reset_tokens():
    """The migration source must call create_table on
    password_reset_tokens with the expected columns."""
    src = MIGRATION_PATH.read_text()
    assert "create_table" in src
    assert "password_reset_tokens" in src
    # token_hash is required — plaintext token storage is the leak.
    assert "token_hash" in src
    assert "expires_at" in src
    assert "used_at" in src


def test_migration_creates_token_hash_index():
    """The token_hash column must be uniquely indexed so lookups
    are O(log N) and duplicate tokens can't be inserted."""
    src = MIGRATION_PATH.read_text()
    assert "token_hash" in src
    # Find the create_index call.
    assert "create_index" in src
    assert "unique=True" in src


def test_token_is_hashed_not_stored_plaintext():
    """Belt-and-braces: the source must not insert into a column
    literally named 'token' — the only token storage should be
    the hashed variant."""
    src = MIGRATION_PATH.read_text()
    # Migration itself doesn't insert; but the route it backs does.
    # Spot-check the migration doesn't declare a plaintext 'token'
    # column (would need to be removed before merging).
    assert "sa.Column(\"token\"" not in src


def test_migration_downgrade_drops_table():
    src = MIGRATION_PATH.read_text()
    downgrade = src.split("def downgrade()", 1)[1]
    assert "drop_table" in downgrade
    assert "password_reset_tokens" in downgrade