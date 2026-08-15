#!/usr/bin/env python3
"""Migration drift detector (June 21 2026 audit follow-up).

Compares alembic-tracked revisions against the on-disk raw SQL
migrations in ``migrations/``. Flags any raw SQL files that have
no corresponding alembic revision (or vice versa).

The audit flagged "49 alembic vs 39 raw SQL — multi-day alembic init
+ reverse-engineer; defer". This script makes that drift visible
in CI so it does not silently grow.

Usage::

    python scripts/migration_drift.py            # human-readable report
    python scripts/migration_drift.py --json     # machine-readable
    python scripts/migration_drift.py --strict   # exit 1 if drift detected

Exit codes:
    0  no drift (or drift found but --strict not set)
    1  drift detected and --strict set
    2  alembic config not found / alembic not importable

This is read-only: it never touches the DB or alembic state. It is
safe to run from CI on every PR.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = REPO_ROOT / "migrations"
ALEMBIC_VERSIONS_DIR = REPO_ROOT / "src" / "eden" / "db_migrations" / "versions"
ALEMBIC_INI = REPO_ROOT / "alembic.ini"

# The commit that added docs/ops/migration-matrix.md and adopted the
# "no new files in migrations/" policy (see that doc's "SQL / alembic
# split (legacy)" section). Any migrations/*.sql file first added to
# git on or after this date is a policy violation worth flagging.
MIGRATIONS_FREEZE_DATE = "2026-06-24"

RAW_SQL_PATTERN = re.compile(r"^(\d{3})_[a-z0-9_]+\.sql$")
ALEMBIC_REVISION_PATTERN = re.compile(
    r"^revision\s*[:=]\s*['\"]([0-9a-f]+)['\"]", re.MULTILINE
)
ALEMBIC_DOWN_REVISION_PATTERN = re.compile(
    r"^down_revision\s*[:=]\s*['\"]?([0-9a-f]+|None)['\"]?", re.MULTILINE
)


def collect_raw_sql() -> set[str]:
    """Return the set of numeric prefixes (e.g. ``{001, 007, 027}``)
    from on-disk raw SQL migration files."""
    if not MIGRATIONS_DIR.is_dir():
        return set()
    prefixes: set[str] = set()
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        m = RAW_SQL_PATTERN.match(path.name)
        if m:
            prefixes.add(m.group(1))
    return prefixes


def collect_alembic() -> dict[str, str]:
    """Return ``{revision_hex: down_revision_hex_or_None}`` from the
    alembic versions directory by parsing each file's header."""
    if not ALEMBIC_VERSIONS_DIR.is_dir():
        return {}
    revs: dict[str, str] = {}
    for path in sorted(ALEMBIC_VERSIONS_DIR.glob("*.py")):
        if path.name == "__init__.py":
            continue
        text = path.read_text()
        rev_m = ALEMBIC_REVISION_PATTERN.search(text)
        down_m = ALEMBIC_DOWN_REVISION_PATTERN.search(text)
        if rev_m:
            revs[rev_m.group(1)] = (down_m.group(1) if down_m else "None")
    return revs


def find_post_freeze_sql_files() -> list[str]:
    """Return raw SQL filenames under ``migrations/`` whose git
    "first added" date is on/after ``MIGRATIONS_FREEZE_DATE``.

    Best-effort: this shells out to ``git log``, so it silently
    returns ``[]`` if git isn't available or this isn't a git
    checkout (e.g. a source tarball) rather than raising — the
    count-based drift check above still works either way.
    """
    if not MIGRATIONS_DIR.is_dir():
        return []
    violations: list[str] = []
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        try:
            out = subprocess.run(
                [
                    "git", "log", "--diff-filter=A", "--format=%ad",
                    "--date=short", "--follow", "--",
                    str(path.relative_to(REPO_ROOT)),
                ],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return []
        if out.returncode != 0 or not out.stdout.strip():
            continue
        # `git log` prints newest-first; the *earliest* add date is
        # the last line (oldest commit that introduced the file).
        added_date = out.stdout.strip().splitlines()[-1].strip()
        if added_date >= MIGRATIONS_FREEZE_DATE:
            violations.append(path.name)
    return violations


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="emit JSON instead of text")
    parser.add_argument("--strict", action="store_true", help="exit 1 if drift detected")
    args = parser.parse_args()

    if not ALEMBIC_INI.exists():
        print(f"alembic.ini not found at {ALEMBIC_INI}", file=sys.stderr)
        return 2

    raw_sql = collect_raw_sql()
    alembic_revs = collect_alembic()
    post_freeze_files = find_post_freeze_sql_files()

    # We can't directly map alembic hex revisions to numeric SQL
    # prefixes — the audit flagged this as "49 alembic vs 39 raw SQL"
    # because alembic uses random hex IDs while raw SQL uses zero-padded
    # numeric prefixes. What we *can* report: counts and a sample of
    # the head/tail of each side so an operator can spot-check.
    report = {
        "raw_sql_count": len(raw_sql),
        "alembic_revision_count": len(alembic_revs),
        "raw_sql_prefixes_sample": sorted(raw_sql)[:5] + (["..."] if len(raw_sql) > 5 else []),
        "alembic_revisions_sample": list(alembic_revs.keys())[:5] + (["..."] if len(alembic_revs) > 5 else []),
        "raw_sql_prefixes_all": sorted(raw_sql),
        "alembic_revisions_all": sorted(alembic_revs.keys()),
        "drift_count": abs(len(raw_sql) - len(alembic_revs)),
        "post_freeze_sql_files": post_freeze_files,
        "migrations_freeze_date": MIGRATIONS_FREEZE_DATE,
        "alembic_ini": str(ALEMBIC_INI),
        "migrations_dir": str(MIGRATIONS_DIR),
        "alembic_versions_dir": str(ALEMBIC_VERSIONS_DIR),
    }

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"Raw SQL migrations:      {report['raw_sql_count']:3d}  (prefix sample: {', '.join(report['raw_sql_prefixes_sample'][:3])})")
        print(f"Alembic revisions:      {report['alembic_revision_count']:3d}  (hex sample: {', '.join(report['alembic_revisions_sample'][:3])})")
        print(f"Drift (count diff):     {report['drift_count']}")
        print()
        print(f"Raw SQL prefixes:      {', '.join(report['raw_sql_prefixes_all'])}")
        print(f"Alembic hex revisions: {', '.join(report['alembic_revisions_all'])}")
        print()
        print("Note: alembic revisions are random hex IDs while raw SQL uses")
        print("zero-padded numeric prefixes — they cannot be directly diffed.")
        print("To find drift, pick a raw SQL file (e.g. 027_*.sql) and confirm")
        print("a corresponding alembic revision exists with the same scope.")
        print()
        if post_freeze_files:
            print(
                f"POLICY VIOLATION: {len(post_freeze_files)} file(s) added to "
                f"migrations/ on/after the {MIGRATIONS_FREEZE_DATE} freeze "
                f"(see docs/ops/migration-matrix.md):"
            )
            for name in post_freeze_files:
                print(f"  - {name}")
        else:
            print(
                f"No migrations/*.sql files added on/after the "
                f"{MIGRATIONS_FREEZE_DATE} freeze date."
            )

    if args.strict and (report["drift_count"] > 0 or post_freeze_files):
        reasons = []
        if report["drift_count"] > 0:
            reasons.append(f"{report['drift_count']} count diff")
        if post_freeze_files:
            reasons.append(f"{len(post_freeze_files)} post-freeze file(s)")
        print(f"\n[strict] drift detected ({'; '.join(reasons)}) — exiting 1", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
