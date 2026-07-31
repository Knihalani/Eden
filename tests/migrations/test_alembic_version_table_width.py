"""``alembic upgrade head`` must work on a database that has never seen it.

Two independent defects made that impossible, and neither could be caught by
anything already in the suite, because pytest never invokes the alembic CLI.

1. **``env.py`` put the project root on ``sys.path``**, not ``src``. The
   project root has no ``eden`` package, so the name fell through to the
   editable install -- whose ``.pth`` lists ``sdk/python`` before ``src``, and
   ``sdk/python/eden`` is the *SDK*. ``from eden.config import get_settings``
   died with ``ModuleNotFoundError: No module named 'eden.config'`` before a
   single revision ran. ``pyproject.toml`` already documents this shadow for
   pytest (``pythonpath = ["src", "."]``); the CLI never got the same fix.

2. **``alembic_version.version_num`` is ``varchar(32)``** by default, and two
   revision ids are longer, so a fresh database aborted partway through
   revision 118 *while recording it*.

A third defect appeared while fixing (2) and is the reason this file bothers
with a live server at all: the width fix has to run a query before alembic
starts, that query implicitly opens a transaction under SQLAlchemy 2.0, and
alembic then declines to commit a transaction it did not begin. The first
version of the fix made ``alembic upgrade head`` log all 125 revisions, exit
0, and leave an **empty database**. Exit status and log output were identical
to a successful run.

``alembic upgrade head --sql`` would have been the ideal database-free check
-- it exercises ``env.py`` for real, import path included -- but offline mode
is not usable in this project: the revisions guard themselves with
``_table_exists()``, which calls ``op.get_bind().execute(...)``, and that
returns ``None`` when there is no connection. So the checks are split:

* the CLI import path is proven by running the real command against an
  unroutable DSN and asserting it got as far as *failing to connect*;
* the column width is proven against the installed alembic through the hook
  it actually uses;
* ``env.py``'s wiring, including the commit that the silent-rollback bug
  hinged on, is pinned structurally with ``ast``;
* and the two things only a server can show -- that rows persist, and that a
  legacy narrow column gets widened -- are ``realdb``.
"""

from __future__ import annotations

import ast
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from eden.db_migrations.version_table import VERSION_NUM_WIDTH, use_wide_version_table

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = REPO_ROOT / "src" / "eden" / "db_migrations"
VERSIONS_DIR = MIGRATIONS_DIR / "versions"
ENV_PY = MIGRATIONS_DIR / "env.py"

#: Alembic's own default, from ``alembic/ddl/impl.py``. Named so the
#: assertions below read as "wider than stock" rather than as a magic number.
ALEMBIC_DEFAULT_WIDTH = 32

_REVISION_RE = re.compile(r"^revision: str = ['\"]([^'\"]+)['\"]", re.MULTILINE)


def _revision_ids() -> list[str]:
    ids: list[str] = []
    for path in VERSIONS_DIR.glob("*.py"):
        match = _REVISION_RE.search(path.read_text(encoding="utf-8"))
        if match:
            ids.append(match.group(1))
    assert ids, f"no revision ids found under {VERSIONS_DIR}"
    return ids


class TestWithoutADatabase:
    """Everything provable without a server."""

    def test_the_cli_gets_far_enough_to_attempt_a_connection(self) -> None:
        """Defect (1): ``env.py`` bound the SDK's ``eden`` package.

        Run a real command with an unroutable DSN. A connection refusal means
        ``env.py`` imported, resolved settings and built an engine --
        everything the CLI does before touching the database. An import error
        means it never got there. Distinguishing those two is the whole test,
        so both are asserted rather than just ``returncode != 0``.

        ``current`` rather than ``upgrade head`` deliberately. Both load
        ``env.py`` identically and both fail here at the same place -- verified
        -- but ``current`` applies nothing. If the ``DATABASE_URL`` override
        below ever stopped taking effect, ``upgrade head`` would silently run
        125 migrations against whatever ``.env`` points at, which in this repo
        is a live host. A test should not be one environment-variable
        regression away from writing to production.
        """
        proc = subprocess.run(
            [sys.executable, "-m", "alembic", "current"],
            cwd=REPO_ROOT,
            env={
                **os.environ,
                # Port 1 is unroutable: refused immediately, no timeout, and
                # it cannot reach whatever real host .env points at.
                "DATABASE_URL": "postgresql+asyncpg://u:p@127.0.0.1:1/nope",
            },
            capture_output=True,
            text=True,
            timeout=300,
        )
        stderr = proc.stderr

        assert "ModuleNotFoundError" not in stderr, (
            "the alembic CLI could not import the application package.\n"
            "env.py must put `src` on sys.path, not the project root: the "
            "root has no `eden` package, so the name falls through to the "
            "editable install, whose .pth lists `sdk/python` (the SDK) before "
            "`src`.\n"
            f"--- stderr (tail) ---\n{stderr[-2000:]}"
        )
        assert "OperationalError" in stderr or "Connection refused" in stderr, (
            "expected the run to fail while connecting, which is how we know "
            "it got through env.py. It failed some other way instead:\n"
            f"--- stderr (tail) ---\n{stderr[-2000:]}"
        )

    def test_alembic_builds_the_version_table_at_our_width(self) -> None:
        """Defect (2), against the installed alembic rather than a mock.

        ``version_table_impl`` is a documented hook, but it was added in
        alembic 1.14 and the shape of the table it must return is alembic's
        business, not ours. Calling it and inspecting the result is what
        proves the override still takes effect after an alembic upgrade.
        """
        from alembic.ddl.impl import DefaultImpl

        use_wide_version_table()
        table = DefaultImpl.version_table_impl(
            None,
            version_table="alembic_version",
            version_table_schema=None,
            version_table_pk=True,
        )

        assert table.c.version_num.type.length == VERSION_NUM_WIDTH, (
            f"alembic would create version_num as VARCHAR("
            f"{table.c.version_num.type.length}), not {VERSION_NUM_WIDTH}"
        )
        assert [c.name for c in table.primary_key] == ["version_num"], (
            "the override dropped alembic's primary key; alembic relies on it "
            "to keep a single head row"
        )
        assert not table.c.version_num.nullable

    def test_env_py_applies_the_hook_and_commits_before_alembic_begins(
        self,
    ) -> None:
        """Defect (3): the silent rollback, pinned structurally.

        Order is the entire bug. ``ensure_version_table`` must run before
        ``context.configure``, and its transaction must be committed before
        alembic starts one of its own -- otherwise alembic sees an externally
        managed transaction, declines to commit, and the whole migration is
        rolled back on connection close while still exiting 0.

        Checked with ``ast`` rather than a substring search so that a call
        which merely appears in a comment or a docstring cannot satisfy it.
        """
        tree = ast.parse(ENV_PY.read_text(encoding="utf-8"))

        module_calls = {
            node.value.func.id
            for node in tree.body
            if isinstance(node, ast.Expr)
            and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Name)
        }
        assert "use_wide_version_table" in module_calls, (
            "env.py never calls use_wide_version_table() at module level, so "
            "alembic creates version_num at its stock varchar(32) and a fresh "
            "database still breaks on the first long revision id"
        )

        func = next(
            (
                n
                for n in tree.body
                if isinstance(n, ast.FunctionDef) and n.name == "do_run_migrations"
            ),
            None,
        )
        assert func is not None, "do_run_migrations is gone from env.py"

        sequence: list[str] = []
        for node in func.body:
            if not isinstance(node, ast.Expr) or not isinstance(node.value, ast.Call):
                continue
            call = node.value
            if isinstance(call.func, ast.Name):
                sequence.append(call.func.id)
            elif isinstance(call.func, ast.Attribute):
                sequence.append(call.func.attr)

        for name in ("ensure_version_table", "commit", "configure"):
            assert name in sequence, (
                f"do_run_migrations does not call {name}(); found {sequence!r}"
            )
        assert (
            sequence.index("ensure_version_table")
            < sequence.index("commit")
            < sequence.index("configure")
        ), (
            "do_run_migrations must call ensure_version_table(), then "
            "connection.commit(), then context.configure(), in that order. "
            f"Found {sequence!r}. Without the commit, the implicit "
            "transaction opened by ensure_version_table's SELECT is one "
            "alembic did not begin, so alembic never commits it and every "
            "migration is rolled back on connection close -- while the "
            "command still logs each revision and exits 0."
        )

    def test_the_widening_is_load_bearing(self) -> None:
        """Pin *why* this module exists.

        If ``VERSION_NUM_WIDTH`` were quietly reverted to alembic's default,
        the two tests above would still pass on a chain whose ids all happen
        to be short -- and the next descriptive revision name would break
        fresh installs again.
        """
        assert VERSION_NUM_WIDTH > ALEMBIC_DEFAULT_WIDTH, (
            f"VERSION_NUM_WIDTH is {VERSION_NUM_WIDTH}, which is not wider "
            f"than alembic's stock {ALEMBIC_DEFAULT_WIDTH}; the override in "
            "env.py is then a no-op"
        )

    def test_the_longest_id_on_disk_is_covered(self) -> None:
        """Cheap, and gives a precise message when someone adds a long name.

        Deliberately checks the files rather than the generated script, so a
        revision that is present but not yet reachable from head is still
        caught.
        """
        ids = _revision_ids()
        longest = max(ids, key=len)
        assert len(longest) <= VERSION_NUM_WIDTH, (
            f"revision id {longest!r} is {len(longest)} characters, longer "
            f"than the {VERSION_NUM_WIDTH}-character version_num column"
        )

    def test_the_chain_still_contains_the_ids_that_broke_it(self) -> None:
        """A regression anchor.

        These two are why the bug existed. If they are ever renamed, this test
        fails and whoever renamed them has to confirm they also handled the
        value already stored in every deployed database's ``alembic_version``.
        """
        ids = set(_revision_ids())
        for revision in (
            "118_improvement_plans_closed_status",
            "124_missing_columns_both_sides_assume",
        ):
            assert revision in ids, (
                f"{revision!r} is gone. It was longer than alembic's stock "
                "varchar(32) and is the reason for version_table.py. If it "
                "was renamed, confirm that databases which already recorded "
                "the old id can still resolve their head."
            )
            assert len(revision) > ALEMBIC_DEFAULT_WIDTH


REAL_DSN = os.environ.get("EDEN_TEST_PG_DSN")


@pytest.mark.realdb
@pytest.mark.skipif(
    not REAL_DSN,
    reason=(
        "needs a throwaway Postgres with the timescaledb and vector "
        "extensions. Run: docker run -d --rm --name eden_mig_probe "
        "-e POSTGRES_PASSWORD=probe -e POSTGRES_USER=probe "
        "-e POSTGRES_DB=probe -p 55439:5432 timescale/timescaledb-ha:pg16 "
        "then EDEN_TEST_PG_DSN=postgresql+asyncpg://probe:probe@127.0.0.1:"
        "55439/probe uv run pytest -m realdb "
        "tests/migrations/test_alembic_version_table_width.py"
    ),
)
class TestAgainstARealServer:
    """The part that needs a server, because the bug it catches is invisible
    without one."""

    @staticmethod
    def _psql(sql: str) -> str:
        proc = subprocess.run(
            ["docker", "exec", "eden_mig_probe", "psql", "-U", "probe",
             "-d", "probe", "-tAc", sql],
            capture_output=True,
            text=True,
            timeout=120,
        )
        assert proc.returncode == 0, proc.stderr
        return proc.stdout.strip()

    @staticmethod
    def _alembic(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-m", "alembic", *args],
            cwd=REPO_ROOT,
            env={**os.environ, "DATABASE_URL": REAL_DSN or ""},
            capture_output=True,
            text=True,
            timeout=1800,
        )

    def test_a_fresh_database_actually_persists(self) -> None:
        """Exit 0 is not evidence that anything was written.

        The first attempt at the width fix opened a transaction alembic then
        refused to commit; the run logged all 125 revisions and exited 0
        against an empty database. Counting tables afterwards is the only
        assertion that distinguishes the two outcomes.
        """
        self._psql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")

        proc = self._alembic("upgrade", "head")
        assert proc.returncode == 0, proc.stderr[-3000:]

        tables = int(
            self._psql(
                "SELECT count(*) FROM information_schema.tables "
                "WHERE table_schema='public'"
            )
        )
        assert tables > 100, (
            f"`alembic upgrade head` exited 0 but the database has {tables} "
            "tables. The migrations ran and were rolled back -- most likely "
            "something opened a transaction before alembic's own, which makes "
            "alembic treat it as externally managed and leave it uncommitted."
        )

        width = int(
            self._psql(
                "SELECT character_maximum_length FROM information_schema.columns "
                "WHERE table_name='alembic_version' AND column_name='version_num'"
            )
        )
        assert width == VERSION_NUM_WIDTH

    def test_a_legacy_narrow_column_is_widened_in_place(self) -> None:
        """The other population: databases created before the fix.

        The hook only affects tables alembic creates, so an existing
        ``varchar(32)`` has to be altered. Simulated by upgrading to the last
        revision that fits, then narrowing the column back.
        """
        self._psql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")

        proc = self._alembic("upgrade", "117_portal_schema_drift")
        assert proc.returncode == 0, proc.stderr[-3000:]

        self._psql(
            "ALTER TABLE alembic_version "
            "ALTER COLUMN version_num TYPE VARCHAR(32)"
        )
        assert (
            self._psql(
                "SELECT character_maximum_length FROM information_schema.columns "
                "WHERE table_name='alembic_version' AND column_name='version_num'"
            )
            == "32"
        ), "the fixture failed to narrow the column"

        proc = self._alembic("upgrade", "head")
        assert proc.returncode == 0, proc.stderr[-3000:]

        assert self._psql("SELECT version_num FROM alembic_version") == (
            "125_clickhouse_fallback_drain"
        )
        assert (
            int(
                self._psql(
                    "SELECT character_maximum_length FROM information_schema.columns "
                    "WHERE table_name='alembic_version' AND column_name='version_num'"
                )
            )
            == VERSION_NUM_WIDTH
        )
