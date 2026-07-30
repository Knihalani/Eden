"""Find Alembic tables whose declared columns are NOT what the DB has.

Why this exists
---------------
Eden has two migration systems: ``migrations/*.sql`` and
``src/eden/db_migrations/versions/*.py``. When a raw SQL file creates a
table and a later Alembic revision creates the *same* table with
``CREATE TABLE IF NOT EXISTS``, the Alembic version silently no-ops —
while still recording itself as applied.

The code then reads the columns Alembic declared, which do not exist.
Every query raises, the surrounding ``except`` swallows it, and the
endpoint reports success while persisting nothing. That is exactly what
happened to ``onboarding_state`` (migration 029 vs Alembic 056): its
routes returned ``{"status":"ok","live":true}`` and wrote nothing.

This finds the rest of that class, by comparing what each Alembic
revision *declares* against what the live database *has*.

    python scripts/alembic_schema_reality_check.py
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
from pathlib import Path

import asyncpg

REPO = Path(__file__).resolve().parents[1]
VERSIONS = REPO / "src" / "eden" / "db_migrations" / "versions"

#: Just the header; the body is extracted by balancing parentheses,
#: because a regex cannot handle nested parens like NUMERIC(10,2) and
#: will happily run past the end of one statement into the next.
CREATE_HEAD_RE = re.compile(
    r"CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w\.]*)\s*\(",
    re.I,
)

#: A column definition: identifier followed by a recognisable SQL type.
#: Requiring a known type keyword is what stops SQL clause words ("and",
#: "or", "where") from being harvested as column names.
TYPE_WORDS = (
    "uuid|text|varchar|char|integer|int|bigint|smallint|serial|bigserial|"
    "boolean|bool|timestamptz|timestamp|date|time|jsonb|json|numeric|"
    "decimal|real|double|float|bytea|inet|interval|vector|tsvector|"
    "cidr|macaddr|money|xml|bit"
)
COL_RE = re.compile(rf"^([a-z_][a-z0-9_]*)\s+({TYPE_WORDS})\b", re.I)

#: Lines that are constraints, not columns.
NOT_A_COLUMN = re.compile(
    r"^(PRIMARY|FOREIGN|UNIQUE|CONSTRAINT|CHECK|EXCLUDE|LIKE|DEFERRABLE)\b",
    re.I,
)


def _balanced_body(text: str, open_idx: int) -> tuple[str, int] | None:
    """Return the text inside the parens opened at ``open_idx``."""
    depth = 0
    for i in range(open_idx, len(text)):
        ch = text[i]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return text[open_idx + 1 : i], i
    return None


def _split_top_level(body: str) -> list[str]:
    """Split a column list on commas that are NOT inside parens."""
    parts, depth, cur = [], 0, []
    for ch in body:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    if cur:
        parts.append("".join(cur))
    return parts


def declared_tables() -> dict[str, tuple[set[str], str]]:
    """{table: (declared_columns, source_file)} from Alembic revisions."""
    out: dict[str, tuple[set[str], str]] = {}
    for path in sorted(VERSIONS.glob("*.py")):
        text = path.read_text(errors="ignore")
        for m in CREATE_HEAD_RE.finditer(text):
            # An unguarded CREATE TABLE raises loudly if the table already
            # exists, so it cannot silently disagree with the database.
            if not m.group(1):
                continue
            table = m.group(2).split(".")[-1].strip('"')
            got = _balanced_body(text, m.end() - 1)
            if got is None:
                continue
            body, _ = got
            cols: set[str] = set()
            for part in _split_top_level(body):
                # Drop comments, collapse to one line.
                cleaned = " ".join(
                    ln.split("--")[0].strip()
                    for ln in part.splitlines()
                    if ln.split("--")[0].strip()
                ).strip()
                if not cleaned or NOT_A_COLUMN.match(cleaned):
                    continue
                cm = COL_RE.match(cleaned)
                if cm:
                    cols.add(cm.group(1).lower())
            if cols:
                # Keep the FIRST declaration; later ones are usually ALTERs.
                out.setdefault(table, (cols, path.name))
    return out


async def main() -> int:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL is not set", file=sys.stderr)
        return 2

    declared = declared_tables()
    conn = await asyncpg.connect(dsn)
    try:
        rows = await conn.fetch(
            """
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
            """
        )
        live: dict[str, set[str]] = {}
        for r in rows:
            live.setdefault(r["table_name"], set()).add(r["column_name"].lower())

        findings = []
        missing_tables = []
        for table, (cols, src) in sorted(declared.items()):
            if table not in live:
                missing_tables.append((table, src))
                continue
            absent = cols - live[table]
            if absent:
                findings.append((table, src, sorted(absent), len(cols)))

        print(
            f"Checked {len(declared)} guarded CREATE TABLE declaration(s) "
            f"against the live database.\n"
        )

        if findings:
            print(
                f"✗ {len(findings)} table(s) where Alembic declares columns "
                f"the database does NOT have.\n"
                f"  These are silent-failure landmines: the code reads the "
                f"declared columns,\n  every query raises, and the "
                f"surrounding except reports success.\n"
            )
            for table, src, absent, total in findings:
                print(f"  {table}  (declared in {src})")
                print(f"      missing {len(absent)}/{total}: {', '.join(absent)}")
        else:
            print("✓ every declared column exists in the live database")

        if missing_tables:
            print(
                f"\n  note: {len(missing_tables)} declared table(s) do not "
                f"exist at all (may be unapplied or intentionally dropped):"
            )
            for table, src in missing_tables:
                print(f"      {table}  ({src})")

        return 1 if findings else 0
    finally:
        await conn.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
