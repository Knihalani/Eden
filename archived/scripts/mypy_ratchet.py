#!/usr/bin/env python3
"""Mypy regression ratchet.

Parses mypy's standard output, compares per-file error counts against
``tests/baselines/mypy.json``, and fails when any file gains errors or
a previously-clean file starts erroring. Counts may only go down;
regenerate the baseline deliberately with::

    uv run mypy src/eden | python scripts/mypy_ratchet.py --update

Usage in CI::

    uv run mypy src/eden | python scripts/mypy_ratchet.py

Exit codes: 0 = no regression, 1 = regression (or missing baseline).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

BASELINE = Path("tests/baselines/mypy.json")
LINE_RE = re.compile(r"^(src/eden/[^:]+):\d+: error: ")


def parse_counts(text: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for line in text.splitlines():
        m = LINE_RE.match(line)
        if m:
            counts[m.group(1)] = counts.get(m.group(1), 0) + 1
    return counts


def main() -> int:
    update = "--update" in sys.argv
    current = parse_counts(sys.stdin.read())

    if update:
        BASELINE.parent.mkdir(parents=True, exist_ok=True)
        BASELINE.write_text(json.dumps(current, indent=2, sort_keys=True) + "\n")
        total = sum(current.values())
        print(f"mypy baseline updated: {total} errors across {len(current)} files")
        return 0

    if not BASELINE.exists():
        print(f"mypy ratchet: baseline {BASELINE} missing — run with --update")
        return 1

    baseline: dict[str, int] = json.loads(BASELINE.read_text())
    regressions: list[str] = []
    for path, count in sorted(current.items()):
        base = baseline.get(path, 0)
        if count > base:
            regressions.append(f"  {path}: {base} -> {count} (+{count - base})")

    cur_total = sum(current.values())
    base_total = sum(baseline.values())
    print(f"mypy ratchet: {cur_total} errors (baseline {base_total})")
    if regressions:
        print("regressions:")
        print("\n".join(regressions))
        return 1
    if cur_total < base_total:
        print("errors decreased — regenerate the baseline with --update")
    return 0


if __name__ == "__main__":
    sys.exit(main())
