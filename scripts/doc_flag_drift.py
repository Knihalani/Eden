#!/usr/bin/env python3
"""doc_flag_drift — detect feature-flag doc drift.

Fails with exit code 1 if any user-facing docs claim a feature flag is
live / enabled / production-ready when that flag defaults to False in
src/eden/config.py.

Usage::

    python scripts/doc_flag_drift.py

The mapping below is intentionally explicit (one entry per flag) so it
stays readable. Add a flag here when docs mention it and the config
default matters for user expectations.

Wave-cycle note (2026-08-12): flags being enabled in the current wave
(trace_summaries_read_v1, rtbf_fanout_v1) are excluded from the drift
check or handled specially — see EXCLUDE_FROM_CHECK.
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# Config source of truth
# ---------------------------------------------------------------------------
CONFIG_PY = REPO_ROOT / "src" / "eden" / "config.py"


def _read_flag_defaults() -> dict[str, bool]:
    """Parse config.py and return {flag_name: default_value} for bool flags."""
    source = CONFIG_PY.read_text()
    tree = ast.parse(source)
    defaults: dict[str, bool] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.AnnAssign):
            if (
                isinstance(node.annotation, ast.Name)
                and node.annotation.id == "bool"
                and node.value is not None
                and isinstance(node.target, ast.Name)
                and isinstance(node.value, (ast.Constant,))
            ):
                defaults[node.target.id] = bool(node.value.value)
    return defaults


# ---------------------------------------------------------------------------
# Flag → "forbidden-claim" patterns
#
# Each entry maps a flag name (must be in config.py and default False) to a
# list of regex patterns that — if found in docs — constitute a claim that
# the feature is live/enabled when it isn't.
#
# Keep patterns narrow: match the sentence-level claim, not the flag name in
# isolation (the flag name may appear legitimately in "this flag is off by
# default" disclaimer text, which is good).
# ---------------------------------------------------------------------------
FLAG_FORBIDDEN_PATTERNS: dict[str, list[str]] = {
    "mcp_http_transport_v1": [
        # Claiming MCP HTTP transport is live/available right now
        r"mcp.*transport.*(?:live|enabled|available|production|shipped)",
        r"(?:live|enabled|available|production|shipped).*mcp.*transport",
        r"Eden MCP server.*(?:is live|is available|is enabled|now serves)",
    ],
}

# Flags that ARE being enabled in the current wave-cycle (2026-08-12).
# These are excluded from the drift check — their docs may legitimately
# describe the enabled state.
EXCLUDE_FROM_CHECK: set[str] = {
    "rtbf_fanout_v1",           # enabled Wave 1 / plan 9.13
    "trace_summaries_read_v1",  # being enabled this cycle
}

# Docs directories to scan (relative to repo root)
DOCS_DIRS = [
    "docs/docs",
]

# File globs to scan
GLOB_PATTERN = "**/*.md"

# ---------------------------------------------------------------------------


def _scan_docs(
    flag: str,
    patterns: list[str],
    flag_default: bool,
) -> list[tuple[Path, int, str]]:
    """Return (path, lineno, snippet) for each forbidden claim found."""
    if flag_default is True:
        # Flag is on by default — no drift possible
        return []
    if flag in EXCLUDE_FROM_CHECK:
        return []

    compiled = [re.compile(p, re.IGNORECASE) for p in patterns]
    hits: list[tuple[Path, int, str]] = []

    for docs_dir in DOCS_DIRS:
        search_root = REPO_ROOT / docs_dir
        if not search_root.exists():
            continue
        for md_file in search_root.glob(GLOB_PATTERN):
            if "node_modules" in str(md_file):
                continue
            try:
                lines = md_file.read_text(errors="replace").splitlines()
            except OSError:
                continue
            for lineno, line in enumerate(lines, 1):
                for pat in compiled:
                    if pat.search(line):
                        hits.append((md_file, lineno, line.strip()))
                        break  # one hit per line is enough

    return hits


def main() -> int:
    flag_defaults = _read_flag_defaults()
    total_hits = 0

    for flag, patterns in FLAG_FORBIDDEN_PATTERNS.items():
        default = flag_defaults.get(flag)
        if default is None:
            print(f"WARNING: flag {flag!r} not found in config.py — skipping")
            continue

        hits = _scan_docs(flag, patterns, default)
        if hits:
            total_hits += len(hits)
            print(f"\nFLAG DRIFT: {flag!r} defaults to False in config.py")
            print("  but docs contain live-claim patterns:")
            for path, lineno, snippet in hits:
                rel = path.relative_to(REPO_ROOT)
                print(f"  {rel}:{lineno}  {snippet[:120]}")

    if total_hits:
        print(f"\n{total_hits} flag-drift violation(s) found. Fix docs before merging.")
        return 1

    print("doc_flag_drift: OK — no flag-drift violations found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
