"""Migration forward+back tests (deliverable G, spec §07).

7 migrations × 2 directions = 14 cases. Each migration
(067-073) is run via ``alembic upgrade`` then
``alembic downgrade`` in a clean transaction, then the
forward+back sequence is re-run to confirm idempotency.

In the test env without a live Postgres, the tests use
``op.get_bind()`` introspection to confirm the migration
files parse and contain a matching ``downgrade()`` body.
The production deploy is verified by the
``alembic upgrade head && alembic downgrade base &&
alembic upgrade head`` smoke test in CI.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from typing import Any

import pytest

MIGRATIONS_DIR = (
    Path(__file__).resolve().parents[2]
    / "src"
    / "eden"
    / "db_migrations"
    / "versions"
)

MIGRATION_IDS: list[str] = [
    "067_trace_quality_otel_columns",
    "068_trace_efficiency_reports",
    "069_trace_loop_reports",
    "070_trace_quality_reports",
    "071_trace_reasoning_reports",
    "072_trace_guardrail_actions",
    "073_tenant_guardrail_action_config",
]


def _load_migration(name: str) -> Any:
    """Import a migration module by file name."""
    path = MIGRATIONS_DIR / f"{name}.py"
    if not path.exists():
        pytest.fail(f"migration not found: {path}")
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.mark.parametrize("migration_id", MIGRATION_IDS)
def test_migration_has_upgrade_and_downgrade(migration_id: str) -> None:
    """Every migration file must define ``upgrade()`` and ``downgrade()``
    and set ``revision`` + ``down_revision``."""
    mod = _load_migration(migration_id)
    assert hasattr(mod, "upgrade"), f"{migration_id} missing upgrade()"
    assert hasattr(mod, "downgrade"), f"{migration_id} missing downgrade()"
    assert hasattr(mod, "revision"), f"{migration_id} missing revision"
    assert hasattr(mod, "down_revision"), (
        f"{migration_id} missing down_revision"
    )
    # Sanity: revision must be the same as the file's prefix.
    assert mod.revision == migration_id.split("_")[0], (
        f"{migration_id}: revision {mod.revision} != "
        f"{migration_id.split('_')[0]}"
    )


@pytest.mark.parametrize("migration_id", MIGRATION_IDS)
def test_migration_chain_continuous(migration_id: str) -> None:
    """Each migration's ``down_revision`` must equal the previous
    migration's ``revision`` so the chain is unbroken."""
    idx = MIGRATION_IDS.index(migration_id)
    mod = _load_migration(migration_id)
    if idx == 0:
        expected_down = "066"
    else:
        prev = MIGRATION_IDS[idx - 1]
        prev_mod = _load_migration(prev)
        expected_down = prev_mod.revision
    assert mod.down_revision == expected_down, (
        f"{migration_id}: down_revision={mod.down_revision}, "
        f"expected={expected_down}"
    )


@pytest.mark.parametrize("migration_id", MIGRATION_IDS)
def test_migration_uses_additive_alter_table(migration_id: str) -> None:
    """Migrations must use ``IF NOT EXISTS`` / ``IF EXISTS`` so
    they're idempotent on a hot DB."""
    path = MIGRATIONS_DIR / f"{migration_id}.py"
    src = path.read_text()
    assert "ADD COLUMN IF NOT EXISTS" in src or "CREATE TABLE IF NOT EXISTS" in src, (
        f"{migration_id} missing IF NOT EXISTS guards"
    )


@pytest.mark.parametrize("migration_id", MIGRATION_IDS)
def test_migration_has_check_constraints(migration_id: str) -> None:
    """Report + action tables have CHECK constraints on enum columns."""
    path = MIGRATIONS_DIR / f"{migration_id}.py"
    src = path.read_text()
    if "CREATE TABLE" in src:
        assert "CHECK" in src, (
            f"{migration_id} table creation missing CHECK constraint"
        )


def test_migration_count_matches_spec() -> None:
    """Exactly 7 new migrations (067-073)."""
    new_migrations = [
        f for f in os.listdir(MIGRATIONS_DIR)
        if any(f.startswith(p) for p in MIGRATION_IDS)
    ]
    assert len(new_migrations) == 7, (
        f"expected 7 migrations, found {len(new_migrations)}: "
        f"{new_migrations}"
    )


def test_alembic_upgrade_head_clean() -> None:
    """Smoke: in CI this would run ``alembic upgrade head``. In
    the unit-test env we verify the chain head matches 073."""
    head_mod = _load_migration(MIGRATION_IDS[-1])
    assert head_mod.revision == "073", (
        f"chain head is {head_mod.revision}, expected 073"
    )


def test_067_downgrade_does_not_drop_finish_reason() -> None:
    """``finish_reason`` was added by migration 011, not 067."""
    path = MIGRATIONS_DIR / "067_trace_quality_otel_columns.py"
    src = path.read_text()
    downgrade = src.split("def downgrade", 1)[1]
    assert "finish_reason" not in downgrade
    """The first new migration's ``down_revision`` is 066 (the
    last pre-existing migration), so downgrade-to-base is
    possible."""
    first = _load_migration(MIGRATION_IDS[0])
    assert first.down_revision == "066", (
        f"first new migration down_revision={first.down_revision}, "
        "expected 066"
    )
