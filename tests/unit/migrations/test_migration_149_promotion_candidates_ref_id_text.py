"""Migration 149 — promotion_candidates.ref_id: UUID -> TEXT (FEAT-28).

``EvidenceGate.enqueue`` writes composite refs like
``"checkout-agent:7"`` (kind="prompt_version"), skill ids
(kind="kb_skill"), and judge/policy names (kind="guardrail") into
``promotion_candidates.ref_id``. Migration 092 declared that column
``UUID NOT NULL``, so asyncpg's UUID codec rejected every non-UUID
ref_id outright — caught by ``enqueue``'s bare except and turned into
an unconditional ``None`` / ``False`` return for 5 of the 6 promotion
kinds.

These tests validate the migration SQL is shaped correctly (widen to
TEXT, idempotent/no-op if already TEXT, no destructive downgrade)
without running alembic against a live Postgres.
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
    """Squash carries the 160 revision id and is the chain base (down_revision=None)."""
    assert "160_signal_definitions_org_enabled_created" in migration_source
    assert "down_revision: str | None = None" in migration_source


def test_migration_widens_ref_id_to_text(migration_source: str):
    assert "ALTER TABLE promotion_candidates" in migration_source
    assert "ALTER COLUMN ref_id TYPE TEXT" in migration_source
    assert "USING ref_id::text" in migration_source


def test_migration_upgrade_is_idempotent_guarded(migration_source: str):
    """upgrade() must probe the live column type first (mirrors migration
    127's pattern) rather than blindly re-running the ALTER, so it's safe
    to run against an environment where 149 (or an equivalent fix) has
    already applied."""
    upgrade_start = migration_source.index("def upgrade()")
    downgrade_start = migration_source.index("def downgrade()")
    upgrade_body = migration_source[upgrade_start:downgrade_start]
    assert "_col_data_type(" in upgrade_body
    assert "information_schema.columns" in migration_source


def test_migration_downgrade_does_not_destructively_recast(migration_source: str):
    """Composite text refs (agent:version, skill ids, judge names) are not
    valid UUIDs, so downgrade() must NOT blindly cast the column back to
    UUID (that would raise / silently drop data depending on driver).
    """
    downgrade_start = migration_source.index("def downgrade()")
    downgrade_body = migration_source[downgrade_start:]
    assert "ALTER COLUMN ref_id TYPE UUID" not in downgrade_body
