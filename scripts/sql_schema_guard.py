#!/usr/bin/env python3
"""Fail when application SQL names a column no migration ever created.

Eden's largest defect class, by count: a query references a column that does
not exist, the call raises ``UndefinedColumn`` every single time, and an
``except Exception: logger.debug(...)`` turns it into an empty result. The
feature looks quiet rather than broken. It has silently disabled the metering
chain, trace replay, Live Tail, the reasoning endpoint, every EQL query, and
four intelligence subsystems — all of which shipped, passed review, and
returned ``[]`` in production.

This guard closes the class rather than the instances. It reconstructs the real
schema from the alembic chain (:mod:`eden.db_migrations.schema_model`) and
checks every SQL literal in ``src/eden`` against it.

Design constraints that shape it:

* **Conservative by construction.** Only *qualified* references
  (``alias.column``) and single-table statements are checked. Anything with a
  CTE, a subquery, a join it cannot resolve, an interpolated relation name, or
  a table the model does not know is skipped. False negatives are acceptable;
  a false positive would get the hook disabled, and a disabled guard protects
  nothing.
* **Ratcheted.** Known violations live in a baseline file so the guard can land
  green while the backlog is burned down. New violations fail immediately.

Exit codes: ``0`` clean · ``1`` new violations · ``2`` usage/internal error.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO / "src"))

from eden.db_migrations.schema_model import SchemaModel, build  # noqa: E402

_DEFAULT_BASELINE = _REPO / "tests" / "migrations" / "sql_schema_guard_baseline.json"

_IDENT = r"[A-Za-z_][A-Za-z0-9_$]*"

#: A statement containing any of these is skipped: we cannot resolve which
#: relation an unqualified column belongs to, or the SQL is built dynamically.
_UNRESOLVABLE = (
    " with ",
    "with ",
    "information_schema",
    "pg_catalog",
    "pg_class",
    "pg_stat",
    "execute ",
)

#: Reserved words that can follow a table name and must not be read as aliases.
_NOT_AN_ALIAS = {
    "where", "group", "order", "limit", "offset", "having", "join", "inner",
    "left", "right", "full", "cross", "on", "using", "set", "values",
    "returning", "union", "except", "intersect", "as", "and", "or", "window",
    "for", "fetch", "lateral", "tablesample",
}


@dataclass(frozen=True, order=True)
class Violation:
    file: str
    line: int
    table: str
    column: str

    def key(self) -> str:
        return f"{self.file}:{self.line}:{self.table}.{self.column}"


def _sql_literals(path: Path) -> list[tuple[int, str]]:
    """Return ``(lineno, sql)`` for every string in the file that looks like SQL."""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (SyntaxError, UnicodeDecodeError):
        return []
    out: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            text = node.value
        elif isinstance(node, ast.JoinedStr):
            parts = []
            for v in node.values:
                if isinstance(v, ast.Constant) and isinstance(v.value, str):
                    parts.append(v.value)
                else:
                    parts.append("{}")
            text = "".join(parts)
        else:
            continue
        lowered = text.lower()
        if re.search(r"\bfrom\s+\w", lowered) or re.match(
            r"\s*(insert\s+into|update\s+\w|delete\s+from)\b", lowered
        ):
            out.append((getattr(node, "lineno", 0), text))
    return out


def _relations(sql: str) -> dict[str, str]:
    """Map ``alias -> table`` for the relations named in ``sql``."""
    rels: dict[str, str] = {}
    pattern = re.compile(
        rf"\b(?:from|join|update|into)\s+({_IDENT})(?:\s+(?:as\s+)?({_IDENT}))?",
        re.I,
    )
    for m in pattern.finditer(sql):
        table = m.group(1).lower()
        alias = (m.group(2) or "").lower()
        rels[table] = table
        if alias and alias not in _NOT_AN_ALIAS:
            rels[alias] = table
    return rels


def _check_statement(
    model: SchemaModel, rel: str, sql: str, path: str, lineno: int
) -> list[Violation]:
    """Check qualified ``alias.column`` references in one statement."""
    del rel
    lowered = sql.lower()
    if any(tok in lowered for tok in _UNRESOLVABLE):
        return []
    if "{}" in sql:  # interpolated identifier somewhere; cannot trust it
        return []

    rels = _relations(sql)
    if not rels:
        return []

    found: list[Violation] = []
    seen: set[tuple[str, str]] = set()
    for m in re.finditer(rf"\b({_IDENT})\.({_IDENT})\b", sql):
        alias, column = m.group(1).lower(), m.group(2).lower()
        table = rels.get(alias)
        if table is None or not model.has_table(table):
            continue
        if table in model.opaque:
            continue
        if (table, column) in seen:
            continue
        seen.add((table, column))
        if not model.knows(table, column):
            found.append(Violation(path, lineno, table, column))
    return found


def scan(model: SchemaModel, root: Path) -> list[Violation]:
    """Scan every module under ``root`` for unknown column references."""
    out: list[Violation] = []
    skip = {"db_migrations"}
    for path in sorted(root.rglob("*.py")):
        if any(part in skip for part in path.parts):
            continue
        rel = str(path.relative_to(_REPO))
        for lineno, sql in _sql_literals(path):
            out.extend(_check_statement(model, rel, sql, rel, lineno))
    return out


def load_baseline(path: Path) -> set[str]:
    if not path.exists():
        return set()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return set()
    return {Violation(**row).key() for row in data.get("violations", [])}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--baseline", type=Path, default=_DEFAULT_BASELINE)
    ap.add_argument(
        "--write-baseline",
        action="store_true",
        help="record current violations as accepted (use when burning down)",
    )
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--strict", action="store_true", help="fail on any violation")
    args = ap.parse_args(argv)

    model = build()
    violations = sorted(scan(model, _REPO / "src" / "eden"))

    if args.write_baseline:
        args.baseline.parent.mkdir(parents=True, exist_ok=True)
        args.baseline.write_text(
            json.dumps(
                {
                    "_comment": (
                        "Known SQL-vs-DDL violations. Burn this list down to []; "
                        "do not add to it. Regenerate with "
                        "`python scripts/sql_schema_guard.py --write-baseline`."
                    ),
                    "violations": [asdict(v) for v in violations],
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"baseline written: {len(violations)} violations")
        return 0

    known = set() if args.strict else load_baseline(args.baseline)
    new = [v for v in violations if v.key() not in known]

    if args.json:
        print(json.dumps({"new": [asdict(v) for v in new],
                          "total": len(violations)}, indent=2))
    else:
        print(f"scanned schema: {len(model.tables)} tables")
        print(f"violations: {len(violations)} total, {len(new)} new")
        for v in new:
            print(f"  {v.file}:{v.line}  {v.table}.{v.column} does not exist")

    return 1 if new else 0


if __name__ == "__main__":
    raise SystemExit(main())
