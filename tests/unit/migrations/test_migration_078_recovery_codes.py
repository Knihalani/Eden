"""Migration 078 — two_factor_recovery_codes table."""

import importlib.util
from pathlib import Path


MIGRATION_PATH = (
    Path(__file__).resolve().parents[3]
    / "src/eden/db_migrations/versions/078_two_factor_recovery_codes.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("migration_078", MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_revision_chain():
    module = _load_migration()
    assert module.revision == "078"
    assert module.down_revision == "077"


def test_creates_recovery_codes_table_with_hash_column():
    src = MIGRATION_PATH.read_text()
    assert "create_table" in src
    assert "two_factor_recovery_codes" in src
    # The whole point: store the hash, not the plaintext code.
    assert "code_hash" in src
    assert "used_at" in src


def test_no_plaintext_code_column():
    """Belt-and-braces: there should be no column literally named 'code'
    that could be confused with a plaintext storage slot."""
    src = MIGRATION_PATH.read_text()
    assert "sa.Column(\"code\"" not in src


def test_downgrade_drops_table():
    src = MIGRATION_PATH.read_text()
    downgrade = src.split("def downgrade()", 1)[1]
    assert "drop_table" in downgrade
    assert "two_factor_recovery_codes" in downgrade