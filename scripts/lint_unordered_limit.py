#!/usr/bin/env python3
"""Fail on SQL that uses ``LIMIT`` without an ``ORDER BY``.

``LIMIT`` without ``ORDER BY`` returns an arbitrary subset of rows — Postgres
makes no guarantee about *which* rows a plan picks, and that plan can change
between calls (different index, different amount of dead tuples, a slightly
different query shape from parameter sniffing). A query that looks like "the
most recent N" or "the top N by cost" silently becomes "N rows, whichever the
planner felt like today" the moment it drops ``ORDER BY``. That class of bug
is quiet: it doesn't error, it just returns plausible-looking, wrong data.

This walks every ``*.py`` under ``src/eden/``, extracts the SQL string passed
as the first positional argument to a DB-call site (``.fetch(``,
``.fetchrow(``, ``.fetchval(``, ``.fetchmany(``, ``.execute(``,
``.executemany(``), and fails listing ``file:line`` for any statement that
contains ``LIMIT`` but not ``ORDER BY``.

Only string/f-string *literals* passed directly as the first argument are
checked — a SQL string built in a local variable and passed by name is not
resolved. This is deliberate: false negatives (missing a violation) are
acceptable, a false positive that blocks an unrelated commit is not.

Escape hatch: a statement that legitimately needs an unordered ``LIMIT``
(e.g. ``LIMIT 1`` on a table with a unique-by-construction filter, or a plain
existence/count-style probe) can opt out with a comment marker anywhere in
the SQL string::

    # lint:unordered-limit-ok
    -- lint:unordered-limit-ok

Existing violations are ratcheted via a baseline file
(``tests/baselines/unordered_limit_baseline.json``) so the check can land
green while the backlog is burned down deliberately. New violations fail
immediately; the baseline may only shrink.

Usage::

    python scripts/lint_unordered_limit.py                 # human output
    python scripts/lint_unordered_limit.py --json           # machine output
    python scripts/lint_unordered_limit.py --strict         # ignore baseline
    python scripts/lint_unordered_limit.py --write-baseline # burn-down helper

Exit codes: ``0`` clean, ``1`` new violations, ``2`` usage/internal error.
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
_SRC = _REPO / "src" / "eden"
_DEFAULT_BASELINE = _REPO / "tests" / "baselines" / "unordered_limit_baseline.json"

#: Attribute names that look like a DB call whose first positional arg is SQL.
_DB_CALL_METHODS = {
    "fetch",
    "fetchrow",
    "fetchval",
    "fetchmany",
    "execute",
    "executemany",
}

_ESCAPE_MARKER = "lint:unordered-limit-ok"
_LIMIT_RE = re.compile(r"\blimit\b", re.I)
_ORDER_BY_RE = re.compile(r"\border\s+by\b", re.I)


@dataclass(frozen=True, order=True)
class Violation:
    file: str
    line: int
    snippet: str

    def key(self) -> str:
        return f"{self.file}:{self.line}"


def _literal_text(node: ast.expr) -> str | None:
    """Return the (possibly interpolated) text of a string/f-string literal."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        parts: list[str] = []
        for value in node.values:
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                parts.append(value.value)
            else:
                parts.append("{}")
        return "".join(parts)
    return None


def _first_line_snippet(sql: str) -> str:
    for line in sql.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped[:80]
    return sql.strip()[:80]


def _iter_db_call_sql(tree: ast.AST) -> list[tuple[int, str]]:
    """Return ``(lineno, sql)`` for every direct-literal DB-call first arg."""
    out: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not isinstance(func, ast.Attribute) or func.attr not in _DB_CALL_METHODS:
            continue
        if not node.args:
            continue
        text = _literal_text(node.args[0])
        if text is None:
            continue
        out.append((node.args[0].lineno, text))
    return out


def _is_violation(sql: str) -> bool:
    if _ESCAPE_MARKER in sql:
        return False
    if not _LIMIT_RE.search(sql):
        return False
    return not _ORDER_BY_RE.search(sql)


def scan_file(path: Path) -> list[Violation]:
    try:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source)
    except (SyntaxError, UnicodeDecodeError):
        return []
    rel = str(path.relative_to(_REPO))
    violations = []
    for lineno, sql in _iter_db_call_sql(tree):
        if _is_violation(sql):
            violations.append(Violation(rel, lineno, _first_line_snippet(sql)))
    return violations


def scan(root: Path) -> list[Violation]:
    out: list[Violation] = []
    for path in sorted(root.rglob("*.py")):
        out.extend(scan_file(path))
    return out


def load_baseline(path: Path) -> set[str]:
    if not path.exists():
        return set()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return set()
    return {row["file"] + ":" + str(row["line"]) for row in data.get("violations", [])}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--baseline", type=Path, default=_DEFAULT_BASELINE)
    ap.add_argument(
        "--write-baseline",
        action="store_true",
        help="record current violations as accepted (use when burning down)",
    )
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--strict", action="store_true", help="ignore the baseline")
    args = ap.parse_args(argv)

    if not _SRC.is_dir():
        print(f"lint_unordered_limit: {_SRC} not found", file=sys.stderr)
        return 2

    violations = sorted(scan(_SRC))

    if args.write_baseline:
        args.baseline.parent.mkdir(parents=True, exist_ok=True)
        args.baseline.write_text(
            json.dumps(
                {
                    "_comment": (
                        "Known LIMIT-without-ORDER-BY violations. Burn this list "
                        "down to []; do not add to it. Regenerate with "
                        "`python scripts/lint_unordered_limit.py --write-baseline`."
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
        print(
            json.dumps(
                {"new": [asdict(v) for v in new], "total": len(violations)}, indent=2
            )
        )
    else:
        print(f"scanned: {len(violations)} total LIMIT-without-ORDER-BY, {len(new)} new")
        for v in new:
            print(f"  {v.file}:{v.line}  {v.snippet}")
        if not new and violations:
            print(
                f"({len(violations)} pre-existing violation(s) allowed via "
                f"{args.baseline.relative_to(_REPO)} — burn these down over time)"
            )

    return 1 if new else 0


if __name__ == "__main__":
    raise SystemExit(main())
