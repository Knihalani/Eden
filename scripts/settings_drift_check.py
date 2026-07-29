#!/usr/bin/env python3
"""Find settings flags the code reads that ``Settings`` does not define.

``Settings.model_config`` sets ``extra="ignore"`` (src/eden/config.py),
so a field that does not exist is not an error — it is silently absent.
Combined with ``getattr(settings, "flag", False)`` at the call site, a
misspelled or never-added flag becomes a feature that is permanently
off, reads like a live knob in code review, and cannot be switched on by
any environment variable.

Two live instances found in the 2026-07-29 audit:

  online_scoring_llm_fallback_v1  — gates the production-eval LLM
      fallback in evaluation/online/scorer_cascade.py. Absent from
      config.py, so that path is unreachable regardless of env.
  otel_dual_emit_enabled          — same shape.

Usage:
    python scripts/settings_drift_check.py          # human output
    python scripts/settings_drift_check.py --json   # machine output

Exit 0 when clean, 1 when drift is found.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "src" / "eden"
CONFIG = SRC / "config.py"

# Names that look like settings lookups but are not, or are supplied
# from somewhere other than Settings.
IGNORE_PREFIXES = ("model_", "_")
IGNORE_EXACT = {
    "get", "keys", "values", "items", "copy", "dict", "json",
    "model_dump", "model_config", "model_fields",
}


def _defined_fields() -> set[str]:
    """Every attribute Settings can expose.

    ``Settings`` is built inside ``_build_settings_class`` so it cannot
    simply be imported and introspected without triggering the boot
    guards. Parse instead: annotated assignments at class-body level,
    plus any AliasChoices strings, plus module-level names.
    """
    tree = ast.parse(CONFIG.read_text())
    names: set[str] = set()

    for node in ast.walk(tree):
        # `field: type = default` inside the Settings class body
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    names.add(t.id)
        # AliasChoices("a", "B", "C") — env aliases are valid names too
        elif isinstance(node, ast.Call):
            fn = node.func
            fname = getattr(fn, "id", None) or getattr(fn, "attr", None)
            if fname == "AliasChoices":
                for a in node.args:
                    if isinstance(a, ast.Constant) and isinstance(a.value, str):
                        names.add(a.value.lower())

    # Anything referenced via a bare `settings.x` inside config.py itself
    # (e.g. computed properties) is also legitimate.
    names |= set(re.findall(r"self\.([a-z][a-z0-9_]*)", CONFIG.read_text()))
    return {n.lower() for n in names}


# `getattr(settings, "name", default)` — the SILENT form. With
# extra="ignore" plus a default, an undefined field is indistinguishable
# from one that is defined and falsy. This is the dangerous shape.
_GETATTR = re.compile(
    r"getattr\(\s*(?:settings|s|cfg|_settings|self\.settings|get_settings\(\))\s*,\s*"
    r"[\"']([a-z][a-z0-9_]*)[\"']"
)
# `settings.name` — the LOUD form. An undefined field raises
# AttributeError, so these surface in testing rather than silently
# disabling a feature. Reported separately.
_ATTR = re.compile(r"\bsettings\.([a-z][a-z0-9_]*)\b")

# Names matched by the attribute regex that belong to some other object
# also called `settings` (a dict row, an ORM model, a response body).
_NOT_SETTINGS = {
    "detail", "trace_id", "updated", "postgres_", "alembic_ini",
}


def scan() -> list[dict[str, object]]:
    defined = _defined_fields()
    findings: dict[str, list[str]] = {}

    severity: dict[str, str] = {}
    for path in SRC.rglob("*.py"):
        if path == CONFIG:
            continue
        try:
            text = path.read_text()
        except Exception:
            continue
        for pattern, kind in ((_GETATTR, "silent"), (_ATTR, "raises")):
            for m in pattern.finditer(text):
                name = m.group(1)
                if name in defined or name in _NOT_SETTINGS:
                    continue
                if name in IGNORE_EXACT or name.startswith(IGNORE_PREFIXES):
                    continue
                line = text[: m.start()].count("\n") + 1
                rel = path.relative_to(REPO)
                findings.setdefault(name, []).append(f"{rel}:{line}")
                # "silent" is the worse diagnosis, so it wins.
                if severity.get(name) != "silent":
                    severity[name] = kind

    return [
        {"setting": k, "kind": severity.get(k, "silent"), "sites": sorted(set(v))}
        for k, v in sorted(findings.items())
    ]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    findings = scan()

    if args.json:
        print(json.dumps({"drift": findings, "count": len(findings)}, indent=2))
        return 1 if findings else 0

    if not findings:
        print("✓ every settings attribute the code reads is defined in config.py")
        return 0

    print(f"✗ {len(findings)} setting(s) read but never defined in config.py.")
    print("  Settings uses extra=\"ignore\", so each of these is permanently")
    print("  falsy and cannot be enabled by any environment variable.\n")
    silent = [f for f in findings if f["kind"] == "silent"]
    loud = [f for f in findings if f["kind"] == "raises"]
    print(f"  {len(silent)} read via getattr(..., default) -> SILENTLY always falsy")
    print(f"  {len(loud)} read as settings.X -> would raise AttributeError\n")
    for f in silent + loud:
        print(f"  {f['setting']}  [{f['kind']}]")
        for site in f["sites"][:6]:
            print(f"      {site}")
        if len(f["sites"]) > 6:
            print(f"      ... +{len(f['sites']) - 6} more")
        print()
    return 1


if __name__ == "__main__":
    sys.exit(main())
