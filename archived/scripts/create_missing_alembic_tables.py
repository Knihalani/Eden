"""Create tables that Alembic declares but production does not have.

Why this exists
---------------
``alembic_version`` reports ``125_clickhouse_fallback_drain`` — i.e.
head — so ``alembic upgrade head`` is a no-op and will never create
these. Yet twelve tables that live code issues SQL against do not exist
in the database.

Nothing 500s, because every call site wraps the query in a try/except
that swallows ``UndefinedTableError`` and returns None/[]/False. So the
features are simply, silently inert — the same "degraded path reports
success" shape found everywhere else in this codebase.

This extracts the CREATE TABLE / CREATE INDEX statements for exactly
those tables out of the project's own migration files and runs them.
Every statement is ``IF NOT EXISTS``, so this is purely additive: it
cannot modify or drop existing data.

    python scripts/create_missing_alembic_tables.py          # plan only
    python scripts/create_missing_alembic_tables.py --apply  # execute
"""

from __future__ import annotations

import argparse
import ast
import asyncio
import os
import re
import sys
from pathlib import Path

import asyncpg

REPO = Path(__file__).resolve().parents[1]
VERSIONS = REPO / "src" / "eden" / "db_migrations" / "versions"

#: Tables the code queries that are absent from production.
TARGETS = [
    "a2a_links",
    "computer_use_steps",
    "computer_use_screenshots_tombstoned",
    "dataset_trace_lineage",
    "debugger_llm_cache",
    "fine_tune_trace_usage",
    "fine_tuning_runs",
    "hook_events",
    "issue_fix_sessions",
    "mcp_server_auth_failures",
    "pr_rejection_memory",
    "provider_routing_attempts",
    "voice_sessions",
]

CREATE_RE = re.compile(
    r"^\s*CREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX)\b", re.I
)


def _sql_literals(path: Path) -> list[str]:
    """Every string literal passed to op.execute() in upgrade()."""
    tree = ast.parse(path.read_text(errors="ignore"))
    out: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef) or node.name != "upgrade":
            continue
        for sub in ast.walk(node):
            if not isinstance(sub, ast.Call):
                continue
            func = sub.func
            name = getattr(func, "attr", None)
            if name != "execute":
                continue
            for arg in sub.args:
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    out.append(arg.value)
                elif isinstance(arg, ast.JoinedStr):
                    # f-string; skip — we will not guess at interpolation.
                    pass
                elif isinstance(arg, ast.BinOp):
                    # Implicit concatenation of constants.
                    parts = [
                        n.value
                        for n in ast.walk(arg)
                        if isinstance(n, ast.Constant) and isinstance(n.value, str)
                    ]
                    if parts:
                        out.append(" ".join(parts))
    return out


def plan() -> list[tuple[str, str, str]]:
    """[(table, source_file, sql)] for the target tables."""
    found: list[tuple[str, str, str]] = []
    for path in sorted(VERSIONS.glob("*.py")):
        try:
            literals = _sql_literals(path)
        except SyntaxError:
            continue
        for sql in literals:
            stripped = sql.strip()
            if not CREATE_RE.match(stripped):
                continue
            for table in TARGETS:
                # Match the table as a whole word in the DDL.
                if re.search(rf"\b{re.escape(table)}\b", stripped):
                    found.append((table, path.name, stripped))
                    break
    return found


async def main(apply: bool) -> int:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL is not set", file=sys.stderr)
        return 2

    conn = await asyncpg.connect(dsn)
    try:
        missing = []
        for t in TARGETS:
            if not await conn.fetchval("SELECT to_regclass($1)", t):
                missing.append(t)
        print(f"Missing tables in this database: {len(missing)}/{len(TARGETS)}")
        if not missing:
            print("Nothing to do.")
            return 0

        stmts = [s for s in plan() if s[0] in missing]
        by_table: dict[str, int] = {}
        for table, _src, _sql in stmts:
            by_table[table] = by_table.get(table, 0) + 1

        print(f"\nFound {len(stmts)} DDL statement(s) across {len(by_table)} table(s):")
        for table in sorted(by_table):
            src = next(s[1] for s in stmts if s[0] == table)
            print(f"  {table:38s} {by_table[table]:2d} stmt(s)   ({src})")

        unresolved = sorted(set(missing) - set(by_table))
        if unresolved:
            print(f"\n  no DDL found for: {', '.join(unresolved)}")

        # Every statement must be guarded — this script must never be
        # capable of dropping or rewriting anything.
        unguarded = [
            (t, s) for t, _f, s in stmts if not re.search(r"IF\s+NOT\s+EXISTS", s, re.I)
        ]
        if unguarded:
            print(
                f"\n✗ REFUSING: {len(unguarded)} statement(s) are not "
                f"IF NOT EXISTS guarded:"
            )
            for t, s in unguarded[:5]:
                print(f"    {t}: {s.splitlines()[0][:90]}")
            return 1

        if not apply:
            print("\nRe-run with --apply to execute. All statements are additive.")
            return 0

        applied, failed = 0, []
        # Tables first, then indexes — an index cannot precede its table.
        ordered = sorted(stmts, key=lambda s: 0 if "CREATE TABLE" in s[2].upper() else 1)
        async with conn.transaction():
            for table, src, sql in ordered:
                try:
                    await conn.execute(sql)
                    applied += 1
                except Exception as exc:
                    failed.append((table, src, str(exc)[:160]))

        if failed:
            print(f"\n✗ {len(failed)} statement(s) failed (transaction rolled back):")
            for t, src, err in failed:
                print(f"    {t} ({src}): {err}")
            return 1

        still = [t for t in TARGETS if not await conn.fetchval("SELECT to_regclass($1)", t)]
        print(f"\n✓ applied {applied} statement(s)")
        print(f"  tables still missing: {len(still)}{': ' + ', '.join(still) if still else ''}")
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    raise SystemExit(asyncio.run(main(args.apply)))
