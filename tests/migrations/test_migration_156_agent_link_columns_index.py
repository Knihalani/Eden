"""FEAT-98: partial index + bounded backfill for agent-linkage telemetry.

``156_agent_link_columns_index`` adds
``idx_telemetry_events_tenant_operation_name_agent`` (a partial index
supporting the "list agent-invocation spans for tenant X" query) plus a
time-bounded backfill of ``operation_name`` for recent ``tool.call`` rows.
No live Postgres is available in this env, so these tests statically verify
the chain linkage, the SQL shape, and — the point of this ticket — that
downgrade() touches only the new index and never ``finish_reason`` (the
exact mistake FEAT-99 fixed in migration 067).
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

import pytest

MIGRATIONS_DIR = (
    Path(__file__).resolve().parents[2] / "src" / "eden" / "db_migrations" / "versions"
)

MIGRATION_ID = "156_agent_link_columns_index"
PREV_ID = "155_session_summaries_user_index"
INDEX_NAME = "idx_telemetry_events_tenant_operation_name_agent"


def _load_migration(name: str) -> Any:
    path = MIGRATIONS_DIR / f"{name}.py"
    if not path.exists():
        pytest.fail(f"migration not found: {path}")
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def test_migration_file_exists() -> None:
    assert (MIGRATIONS_DIR / f"{MIGRATION_ID}.py").exists()


def test_revision_and_chain_linkage() -> None:
    mod = _load_migration(MIGRATION_ID)
    assert mod.revision == MIGRATION_ID
    assert mod.down_revision == PREV_ID, (
        f"156 must chain directly off {PREV_ID} (the current head at the "
        f"time this migration was written), got {mod.down_revision!r}"
    )


def test_no_other_migration_forks_from_155_or_156() -> None:
    """The chain must stay linear: exactly one migration declares
    ``down_revision = 155_session_summaries_user_index`` (156 itself), and
    exactly one migration descends from 156 (157, the current head)."""
    children_of_155 = []
    children_of_156 = []
    for path in MIGRATIONS_DIR.glob("*.py"):
        src = path.read_text(encoding="utf-8")
        if f'down_revision: str | Sequence[str] | None = "{PREV_ID}"' in src or (
            f'down_revision = "{PREV_ID}"' in src
        ):
            children_of_155.append(path.name)
        if f'down_revision: str | Sequence[str] | None = "{MIGRATION_ID}"' in src or (
            f'down_revision = "{MIGRATION_ID}"' in src
        ):
            children_of_156.append(path.name)
    assert children_of_155 == [f"{MIGRATION_ID}.py"], (
        f"expected only {MIGRATION_ID} to descend from {PREV_ID}, "
        f"found {children_of_155}"
    )
    assert children_of_156 == ["157_agent_artifact_context.py"], (
        f"157 is the current chain head; found descendants of 156 "
        f"{children_of_156}"
    )


def test_upgrade_creates_expected_partial_index() -> None:
    path = MIGRATIONS_DIR / f"{MIGRATION_ID}.py"
    src = path.read_text()
    assert "CREATE INDEX IF NOT EXISTS" in src
    assert INDEX_NAME in src
    assert "ON telemetry_events (tenant_id, operation_name, agent_id)" in src
    assert "WHERE operation_name IN ('invoke_agent', 'create_agent')" in src


def test_upgrade_backfill_is_bounded_and_scoped() -> None:
    """The backfill UPDATE must be scoped by both a recency window and
    ``event_type`` so it cannot turn into an unbounded table rewrite."""
    path = MIGRATIONS_DIR / f"{MIGRATION_ID}.py"
    src = path.read_text()
    assert "UPDATE telemetry_events" in src
    assert "SET operation_name = 'unknown'" in src
    assert "operation_name IS NULL" in src
    assert "created_at > now() - interval '30 days'" in src
    assert "event_type = 'tool.call'" in src


def _op_execute_sql_literals(func: Any) -> list[str]:
    """Extract the string literal passed to every ``op.execute(...)`` call
    inside a migration function, ignoring comments/docstrings."""
    import ast
    import inspect

    tree = ast.parse(inspect.getsource(func))
    literals: list[str] = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "execute"
            and node.args
            and isinstance(node.args[0], ast.Constant)
            and isinstance(node.args[0].value, str)
        ):
            literals.append(node.args[0].value)
    return literals


def test_downgrade_drops_only_the_new_index() -> None:
    """FEAT-98 must not repeat the FEAT-99 mistake: the actual DDL/DML
    downgrade() issues (not its explanatory comments, which are allowed
    to mention the incident they guard against) must not touch
    finish_reason or any column — only the index this migration adds."""
    mod = _load_migration(MIGRATION_ID)
    assert hasattr(mod, "downgrade")

    statements = _op_execute_sql_literals(mod.downgrade)
    assert len(statements) == 1, (
        f"expected downgrade() to issue exactly one op.execute() (the "
        f"index drop), found {len(statements)}: {statements!r}"
    )
    (sql,) = statements
    assert sql.strip() == f"DROP INDEX IF EXISTS {INDEX_NAME}"
    assert "finish_reason" not in sql
    assert "DROP COLUMN" not in sql


def test_upgrade_issues_index_then_backfill_only() -> None:
    """Upgrade should be exactly the index creation and the bounded
    backfill — no stray column changes."""
    mod = _load_migration(MIGRATION_ID)
    statements = _op_execute_sql_literals(mod.upgrade)
    assert len(statements) == 2, (
        f"expected upgrade() to issue exactly two op.execute() calls "
        f"(CREATE INDEX + bounded UPDATE), found {len(statements)}"
    )
    assert statements[0].strip().startswith("CREATE INDEX IF NOT EXISTS")
    assert statements[1].strip().startswith("UPDATE telemetry_events")
    for sql in statements:
        assert "ALTER TABLE" not in sql
        assert "DROP" not in sql
