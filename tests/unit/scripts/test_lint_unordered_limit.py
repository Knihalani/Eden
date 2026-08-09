"""The unordered-LIMIT lint must catch the bug class it exists for.

``LIMIT`` without ``ORDER BY`` returns an arbitrary, plan-dependent subset of
rows — a query that looks like "top N" or "most recent N" silently becomes
"N rows, whichever the planner picked today". These tests pin:

* the extractor finds SQL passed directly to ``.fetch``/``.fetchrow``/
  ``.fetchval``/``.execute`` and friends;
* ``LIMIT`` + ``ORDER BY`` together is not flagged;
* the ``# lint:unordered-limit-ok`` escape hatch suppresses a real hit;
* the CLI's ratchet only fails on *new* violations, not the known backlog.
"""

from __future__ import annotations

import ast
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[3]
_SCRIPT = _REPO / "scripts" / "lint_unordered_limit.py"
_BASELINE = _REPO / "tests" / "baselines" / "unordered_limit_baseline.json"

_spec = importlib.util.spec_from_file_location("lint_unordered_limit", _SCRIPT)
lint_unordered_limit = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
sys.modules["lint_unordered_limit"] = lint_unordered_limit
_spec.loader.exec_module(lint_unordered_limit)


def _violations_in(source: str) -> list[lint_unordered_limit.Violation]:
    tree = ast.parse(source)
    out = []
    for lineno, sql in lint_unordered_limit._iter_db_call_sql(tree):
        if lint_unordered_limit._is_violation(sql):
            out.append(
                lint_unordered_limit.Violation(
                    "test.py", lineno, lint_unordered_limit._first_line_snippet(sql)
                )
            )
    return out


class TestExtraction:
    def test_flags_limit_without_order_by(self) -> None:
        src = '''
async def f(conn):
    return await conn.fetch("""
        SELECT id FROM users LIMIT 10
    """)
'''
        assert len(_violations_in(src)) == 1

    def test_allows_limit_with_order_by(self) -> None:
        src = '''
async def f(conn):
    return await conn.fetch("""
        SELECT id FROM users ORDER BY created_at DESC LIMIT 10
    """)
'''
        assert _violations_in(src) == []

    def test_allows_query_without_limit(self) -> None:
        src = '''
async def f(conn):
    return await conn.fetch("SELECT id FROM users")
'''
        assert _violations_in(src) == []

    def test_escape_hatch_suppresses_violation(self) -> None:
        src = '''
async def f(conn):
    return await conn.fetchrow("""
        -- lint:unordered-limit-ok
        SELECT id FROM users WHERE clerk_id = 'system' LIMIT 1
    """)
'''
        assert _violations_in(src) == []

    def test_covers_fetchval_and_execute(self) -> None:
        src = '''
async def f(conn):
    await conn.fetchval("SELECT count FROM t LIMIT 5")
    await conn.execute("DELETE FROM t WHERE id IN (SELECT id FROM t LIMIT 5)")
'''
        assert len(_violations_in(src)) == 2

    def test_ignores_sql_built_in_a_variable(self) -> None:
        """Deliberate false negative: only direct literals are checked."""
        src = '''
async def f(conn):
    query = "SELECT id FROM users LIMIT 10"
    return await conn.fetch(query)
'''
        assert _violations_in(src) == []

    def test_ignores_non_db_call(self) -> None:
        src = '''
def f():
    return "SELECT id FROM users LIMIT 10".format()
'''
        assert _violations_in(src) == []


class TestBaselineRatchet:
    def test_baseline_exists_and_is_parseable(self) -> None:
        data = json.loads(_BASELINE.read_text())
        assert "violations" in data
        assert isinstance(data["violations"], list)
        assert len(data["violations"]) > 0

    def test_no_new_violations(self) -> None:
        result = subprocess.run(
            [sys.executable, str(_SCRIPT)],
            capture_output=True,
            text=True,
            cwd=_REPO,
        )
        assert result.returncode == 0, (
            "new SQL uses LIMIT without ORDER BY and no escape hatch:\n"
            f"{result.stdout}\n{result.stderr}"
        )

    @pytest.mark.xfail(
        strict=False,
        reason="burn-down in progress; flip to a hard assert when it reaches []",
    )
    def test_baseline_is_empty(self) -> None:
        data = json.loads(_BASELINE.read_text())
        assert data["violations"] == []
