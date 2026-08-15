#!/usr/bin/env python3
"""Extract the default each drifted setting is currently read with.

Adding a Settings field with a DIFFERENT default than the call site's
``getattr`` fallback would silently change behaviour on deploy. This
reads the actual default out of each call site so the new fields can be
generated to preserve current behaviour exactly — the fix being that
the value becomes settable, not that it changes.

Reports a conflict when the same name is read with different defaults
in different places, because then there is no single safe answer.
"""

from __future__ import annotations

import ast
import json
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "src" / "eden"

_RECEIVERS = {"settings", "s", "cfg", "_settings"}


def _is_settings(node: ast.expr) -> bool:
    if isinstance(node, ast.Name) and node.id in _RECEIVERS:
        return True
    if isinstance(node, ast.Attribute) and node.attr == "settings":
        return True
    if isinstance(node, ast.Call):
        fn = node.func
        return (getattr(fn, "id", None) or getattr(fn, "attr", None)) == "get_settings"
    return False


def _literal(node: ast.expr) -> object:
    try:
        return ast.literal_eval(node)
    except Exception:
        return "<non-literal>"


def collect() -> dict[str, dict]:
    found: dict[str, set] = defaultdict(set)
    sites: dict[str, list[str]] = defaultdict(list)

    for path in SRC.rglob("*.py"):
        try:
            tree = ast.parse(path.read_text())
        except Exception:
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            if getattr(node.func, "id", None) != "getattr":
                continue
            if not node.args or not _is_settings(node.args[0]):
                continue
            if len(node.args) < 2 or not isinstance(node.args[1], ast.Constant):
                continue
            name = node.args[1].value
            if not isinstance(name, str):
                continue
            default = _literal(node.args[2]) if len(node.args) > 2 else None
            found[name].add(repr(default))
            sites[name].append(
                f"{path.relative_to(REPO)}:{node.lineno}"
            )

    return {
        name: {
            "defaults": sorted(vals),
            "conflict": len(vals) > 1,
            "sites": sorted(set(sites[name])),
        }
        for name, vals in sorted(found.items())
    }


def main() -> int:
    import subprocess

    drift = json.loads(
        subprocess.run(
            ["python", str(REPO / "scripts" / "settings_drift_check.py"), "--json"],
            capture_output=True, text=True, check=False,
        ).stdout or '{"drift": []}'
    )
    drifted = {f["setting"] for f in drift.get("drift", [])}

    all_defaults = collect()
    rows = {k: v for k, v in all_defaults.items() if k in drifted}

    print(f"{'setting':38}{'default(s)':<26}{'conflict'}")
    print("-" * 76)
    for name, info in rows.items():
        d = ", ".join(info["defaults"])
        flag = "  <-- CONFLICT" if info["conflict"] else ""
        print(f"{name:38}{d:<26}{flag}")

    missing = sorted(drifted - set(rows))
    if missing:
        print()
        print("read WITHOUT a getattr default (bare attribute -> AttributeError):")
        for m in missing:
            print(f"  {m}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
