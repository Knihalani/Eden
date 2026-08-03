#!/usr/bin/env python3
"""Assert the spec's flag table matches ``config.py`` defaults (M4, D20).

``docs/specs/AUTONOMY-OVERHAUL-PLAN.md`` §1.4 ("Live defaults that
decide behavior") is the master table of the flags that decide what the
autonomy loop actually does. D20 happened because tables like this one
rot silently: f46's flag table said ``closed_loop_orchestrator_v1 |
false`` while the shipped default was True, and AUTONOMOUS-MAINTENANCE
§6 called shipped modules greenfield. Prose can lie indefinitely; this
check makes the §1.4 table fail the build the moment it diverges from
``get_settings()`` defaults.

Mechanics:

* The table is parsed from the §1.4 section only (up to the next
  ``###`` heading). Each row's first cell may name several flags in
  backticks separated by ``/``; the Default cell then carries the same
  number of ``/``-separated values (e.g. ``10 / 3 / 8``).
* Defaults come from a real Settings instance built with the process
  environment cleared and ``_env_file=None`` — the same "defaults, not
  my laptop's .env" discipline as ``settings_drift_check.py``, which
  deliberately avoids env/dotenv influence when judging config truth.
* Values compare as bool ("True"/"False"), then int, then float, then
  case-sensitive string (``**bold**`` and backticks stripped).

Usage:
    python scripts/spec_drift_check.py          # human output
    python scripts/spec_drift_check.py --json   # machine output

Exit 0 when the spec matches, 1 on drift (each diff named), 2 when the
table cannot be found/parsed (a silently-skipped check is drift too).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any
from unittest import mock

REPO = Path(__file__).resolve().parents[1]
SPEC = REPO / "docs" / "specs" / "AUTONOMY-OVERHAUL-PLAN.md"
SECTION_HEADING = "### 1.4"

_FLAG_RE = re.compile(r"`([A-Za-z_][A-Za-z0-9_]*)`")


def parse_spec_flag_table(text: str | None = None) -> dict[str, str]:
    """Return {flag_name: default_string} parsed from the §1.4 table."""
    text = text if text is not None else SPEC.read_text()
    lines = text.splitlines()
    start = next(
        (i for i, ln in enumerate(lines) if ln.startswith(SECTION_HEADING)),
        None,
    )
    if start is None:
        raise ValueError(f"{SECTION_HEADING} section not found in {SPEC}")

    flags: dict[str, str] = {}
    for ln in lines[start + 1 :]:
        if ln.startswith("### ") or ln.startswith("## "):
            break
        row = ln.strip()
        if not row.startswith("|"):
            continue
        cells = [c.strip() for c in row.strip("|").split("|")]
        if len(cells) < 2:
            continue
        names = _FLAG_RE.findall(cells[0])
        if not names:  # header / separator / prose rows
            continue
        raw_default = cells[1].replace("**", "").replace("`", "").strip()
        values = [v.strip() for v in raw_default.split("/")]
        if len(values) != len(names):
            raise ValueError(
                f"spec row {cells[0]!r}: {len(names)} flag(s) but "
                f"{len(values)} default value(s) ({raw_default!r})"
            )
        for name, value in zip(names, values, strict=True):
            flags[name] = value
    if not flags:
        raise ValueError(f"no flag rows parsed from {SECTION_HEADING} in {SPEC}")
    return flags


def default_settings() -> Any:
    """A Settings instance carrying pure config.py defaults.

    Environment cleared + ``_env_file=None`` so neither exported env
    vars nor a local ``.env`` can mask spec drift (or fake it).
    """
    sys.path.insert(0, str(REPO / "src"))
    from eden import config  # noqa: PLC0415

    settings_cls = config._build_settings_class()
    with mock.patch.dict(os.environ, {}, clear=True):
        return settings_cls(_env_file=None)


def _values_match(spec_value: str, actual: Any) -> bool:
    if spec_value in ("True", "False"):
        return isinstance(actual, bool) and actual is (spec_value == "True")
    try:
        return int(spec_value) == int(actual) and float(actual) == int(spec_value)
    except (TypeError, ValueError):
        pass
    try:
        return float(spec_value) == float(actual)
    except (TypeError, ValueError):
        pass
    return str(spec_value) == str(actual)


def check() -> list[dict[str, Any]]:
    """Return one diff dict per drifted/missing flag (empty == clean)."""
    spec_flags = parse_spec_flag_table()
    settings = default_settings()
    _MISSING = object()

    diffs: list[dict[str, Any]] = []
    for name, spec_value in spec_flags.items():
        actual = getattr(settings, name, _MISSING)
        if actual is _MISSING:
            diffs.append(
                {"flag": name, "spec": spec_value, "actual": None,
                 "problem": "not defined on Settings"}
            )
        elif not _values_match(spec_value, actual):
            diffs.append(
                {"flag": name, "spec": spec_value, "actual": repr(actual),
                 "problem": "default differs"}
            )
    return diffs


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    try:
        diffs = check()
        flag_count = len(parse_spec_flag_table())
    except ValueError as exc:
        print(f"✗ spec_drift_check cannot parse the flag table: {exc}")
        return 2

    if args.json:
        print(json.dumps({"drift": diffs, "checked": flag_count}, indent=2))
        return 1 if diffs else 0

    if not diffs:
        print(
            f"✓ all {flag_count} flags in AUTONOMY-OVERHAUL-PLAN.md §1.4 "
            "match config.py defaults"
        )
        return 0

    print(
        f"✗ {len(diffs)} flag(s) drifted between AUTONOMY-OVERHAUL-PLAN.md "
        "§1.4 and config.py defaults:\n"
    )
    for d in diffs:
        print(f"  {d['flag']}: spec={d['spec']!r} actual={d['actual']}"
              f"  [{d['problem']}]")
    print(
        "\nFix the spec table (or config.py) so the documented autonomy "
        "posture is the shipped one."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
