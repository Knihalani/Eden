#!/usr/bin/env python3
"""Spec truth gates: flag-table drift (M4, D20) + status drift (Phase 0.4).

Check 1 — assert the spec's flag table matches ``config.py`` defaults.
Check 2 — assert per-spec ``**Eden status**`` headers agree with every
EDEN-MASTER-ROADMAP.md status row for the same ID, and that the roadmap
links no nonexistent ``features/*.md`` file. Any mismatch or dead link
fails the build (``--allow ID`` is the only, explicit, escape hatch).

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

ROADMAP = REPO / "docs" / "specs" / "EDEN-MASTER-ROADMAP.md"
FEATURES_DIR = REPO / "docs" / "specs" / "features"

_FLAG_RE = re.compile(r"`([A-Za-z_][A-Za-z0-9_]*)`")

# ---------------------------------------------------------------------------
# Part 2 — spec-status truth reconciliation (Phase 0.4).
#
# Status drift is the same disease as flag drift: the roadmap's per-ID
# status table and the per-spec `**Eden status**` headers rot apart
# (F49's header said MISSING while the roadmap said SHIPPED v0 and the
# code shipped it). These checks make ANY mismatch fail the build, and
# also fail when the roadmap links a spec file that does not exist
# (the Wave-10 CUT specs used to be dead links).
# ---------------------------------------------------------------------------

# Normalized status vocabulary. DONE is an alias of SHIPPED. CUT and
# DELETED are terminal "will not build" states. The first token found
# (left to right) in a status cell wins, so headers like
# "SHIPPED (core) — cold tier deferred" normalize to SHIPPED.
_STATUS_TOKEN_RE = re.compile(
    r"\b(MISSING|PARTIAL|SHIPPED|DONE|DELETED|DOGFOOD|CUT)\b"
)
_STATUS_ALIASES = {"DONE": "SHIPPED"}

_ROADMAP_ID_RE = re.compile(r"^([FN]\d{2})$")
_SPEC_FILE_ID_RE = re.compile(r"^([fn]\d{2})-")
_ROADMAP_LINK_RE = re.compile(r"\(features/([^)#]+\.md)\)")


def _normalize_status(cell: str) -> str | None:
    """First status token in a table cell, alias-folded; None if absent."""
    m = _STATUS_TOKEN_RE.search(cell)
    if m is None:
        return None
    token = m.group(1)
    return _STATUS_ALIASES.get(token, token)


def parse_roadmap_statuses(text: str | None = None) -> dict[str, list[tuple[int, str]]]:
    """{ID: [(line_no, normalized_status), ...]} from every roadmap table row.

    A row counts when its first cell is a bare F/N id (``F49``, ``N09``,
    strikethrough/bold stripped) and some later cell carries a status
    token. Rows with no status token (e.g. N09's "—" rows) are skipped.
    Every occurrence is kept: the same ID may appear in a wave table
    and in the master checklist, and all of them must agree.
    """
    text = text if text is not None else ROADMAP.read_text()
    statuses: dict[str, list[tuple[int, str]]] = {}
    for line_no, ln in enumerate(text.splitlines(), start=1):
        row = ln.strip()
        if not row.startswith("|"):
            continue
        cells = [c.strip() for c in row.strip("|").split("|")]
        if len(cells) < 3:
            continue
        raw_id = cells[0].replace("**", "").replace("~~", "").strip()
        id_match = _ROADMAP_ID_RE.match(raw_id)
        if id_match is None:
            continue
        status = next(
            (s for c in cells[1:] if (s := _normalize_status(c)) is not None),
            None,
        )
        if status is None:
            continue
        statuses.setdefault(id_match.group(1), []).append((line_no, status))
    if not statuses:
        raise ValueError(f"no per-ID status rows parsed from {ROADMAP}")
    return statuses


def parse_spec_headers() -> dict[str, tuple[Path, str]]:
    """{ID: (path, normalized_status)} from `**Eden status**` header rows."""
    headers: dict[str, tuple[Path, str]] = {}
    for path in sorted(FEATURES_DIR.glob("*.md")):
        id_match = _SPEC_FILE_ID_RE.match(path.name)
        if id_match is None:
            continue
        spec_id = id_match.group(1).upper()
        for ln in path.read_text().splitlines():
            if "**Eden status**" not in ln:
                continue
            cells = [c.strip() for c in ln.strip().strip("|").split("|")]
            cell = next(
                (c for c in cells if "Eden status" not in c and c), ""
            )
            status = _normalize_status(cell)
            if status is not None:
                headers[spec_id] = (path, status)
            break
    if not headers:
        raise ValueError(f"no `**Eden status**` headers parsed under {FEATURES_DIR}")
    return headers


def check_status_consistency(allow: set[str]) -> list[str]:
    """One message per ID whose roadmap row(s) disagree with its header.

    Any mismatch fails — the roadmap is the gating doc, so it may not
    claim more OR less than the spec header. IDs in ``allow`` are
    skipped (explicit, visible escape hatch only).
    """
    roadmap = parse_roadmap_statuses()
    headers = parse_spec_headers()
    problems: list[str] = []
    for spec_id, occurrences in sorted(roadmap.items()):
        if spec_id in allow or spec_id not in headers:
            continue
        path, header_status = headers[spec_id]
        for line_no, row_status in occurrences:
            if row_status != header_status:
                problems.append(
                    f"{spec_id}: roadmap says {row_status} "
                    f"(EDEN-MASTER-ROADMAP.md:{line_no}) but "
                    f"{path.name} header says {header_status}"
                )
        distinct = {s for _, s in occurrences}
        if len(distinct) > 1:
            problems.append(
                f"{spec_id}: roadmap disagrees with itself: "
                + ", ".join(f"{s}@:{n}" for n, s in occurrences)
            )
    return problems


def check_roadmap_links() -> list[str]:
    """One message per features/*.md link in the roadmap that is missing."""
    text = ROADMAP.read_text()
    problems: list[str] = []
    seen: set[str] = set()
    for line_no, ln in enumerate(text.splitlines(), start=1):
        for name in _ROADMAP_LINK_RE.findall(ln):
            if name in seen:
                continue
            seen.add(name)
            if not (FEATURES_DIR / name).exists():
                problems.append(
                    f"EDEN-MASTER-ROADMAP.md:{line_no} links "
                    f"features/{name} which does not exist"
                )
    return problems


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
    ap.add_argument(
        "--allow",
        action="append",
        default=[],
        metavar="ID",
        help="spec ID (e.g. F49) exempt from roadmap/header status "
        "consistency — use only for deliberate, temporary divergence",
    )
    args = ap.parse_args()

    try:
        diffs = check()
        flag_count = len(parse_spec_flag_table())
        status_problems = check_status_consistency({a.upper() for a in args.allow})
        link_problems = check_roadmap_links()
        checked_ids = sorted(
            set(parse_roadmap_statuses()) & set(parse_spec_headers())
        )
    except ValueError as exc:
        print(f"✗ spec_drift_check cannot parse its inputs: {exc}")
        return 2

    failed = bool(diffs or status_problems or link_problems)

    if args.json:
        print(
            json.dumps(
                {
                    "drift": diffs,
                    "checked": flag_count,
                    "status_drift": status_problems,
                    "status_ids_checked": checked_ids,
                    "missing_spec_links": link_problems,
                },
                indent=2,
            )
        )
        return 1 if failed else 0

    if not diffs:
        print(
            f"✓ all {flag_count} flags in AUTONOMY-OVERHAUL-PLAN.md §1.4 "
            "match config.py defaults"
        )
    else:
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

    if not status_problems:
        print(
            f"✓ all {len(checked_ids)} spec IDs with both a roadmap row and "
            "an `**Eden status**` header agree on status"
        )
    else:
        print(
            f"✗ {len(status_problems)} status inconsistenc(ies) between "
            "EDEN-MASTER-ROADMAP.md and docs/specs/features/ headers:\n"
        )
        for p in status_problems:
            print(f"  {p}")
        print(
            "\nFix whichever side lies: verify in code, then update the "
            "roadmap row(s) and the spec header to the same status."
        )

    if not link_problems:
        print("✓ every features/*.md file linked from the roadmap exists")
    else:
        print(
            f"✗ {len(link_problems)} dead spec link(s) in "
            "EDEN-MASTER-ROADMAP.md:\n"
        )
        for p in link_problems:
            print(f"  {p}")
        print(
            "\nRemove the dead link (state CUT honestly) or restore the "
            "spec file."
        )

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
