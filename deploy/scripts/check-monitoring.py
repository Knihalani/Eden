#!/usr/bin/env python3
"""A static check of deploy/monitoring without Alloy or promtool (D997):

- config.alloy: braces and quotes balance; every component a `forward_to`, `targets` or `.output` names is defined
  in the file; every `sys.env("X")` it reads is listed in its header comment, so an operator knows what to set.
- alerts.yaml: parses; every rule has `alert`, `expr` and a `severity` label; every `eden_*` metric an expression uses
  is one Eden emits (its name appears in packages/server/src), so no alert watches a series that never exists.

It does not evaluate PromQL or Alloy semantics: `alloy fmt` and `promtool check rules` remain the real checks.

    python3 -I deploy/scripts/check-monitoring.py
"""
import pathlib
import re
import sys

import yaml  # PyYAML: in Ubuntu's python3-yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
SERVER = ROOT.parent / "packages" / "server" / "src"


def check_alloy(text: str) -> list[str]:
    problems = []
    code = re.sub(r"//.*", "", text)
    if code.count("{") != code.count("}"):
        problems.append(f"config.alloy: {code.count('{')} '{{' against {code.count('}')} '}}'")
    if code.count('"') % 2:
        problems.append("config.alloy: an unbalanced quote")
    defined = {f"{m.group(1)}.{m.group(2)}" for m in re.finditer(r'^([a-z_]+(?:\.[a-z_]+)+) "(\w+)" \{', code, re.M)}
    for m in re.finditer(r"\b((?:prometheus|loki|discovery)(?:\.[a-z_]+)+?)\.(\w+)\.(receiver|targets|output)\b", code):
        ref = f"{m.group(1)}.{m.group(2)}"
        if ref not in defined:
            problems.append(f"config.alloy: {ref} is referenced but not defined")
    header = text.split("\n\n", 1)[0]
    for env in set(re.findall(r'sys\.env\("(\w+)"\)', code)):
        if env not in header:
            problems.append(f"config.alloy: reads {env}, which the header does not list")
    return problems


def emitted_metrics() -> set[str]:
    names: set[str] = set()
    for f in SERVER.glob("*.ts"):
        names.update(re.findall(r"\b(eden_[a-z_]+)", f.read_text()))
    # The store counters are built from SharedFrozenDisk's `remote` keys (ops.ts): eden_store_<key>_total.
    shared = (ROOT.parent / "packages" / "engine" / "src" / "persist-shared.ts").read_text()
    block = re.search(r"readonly remote = \{(.*?)\};", shared, re.S)
    if block:
        for key in re.findall(r"(\w+): 0", block.group(1)):
            names.add("eden_store_" + re.sub(r"[A-Z]", lambda c: "_" + c.group(0).lower(), key) + "_total")
    names.add("eden_store_backlog")
    return names


def check_alerts(text: str) -> list[str]:
    problems = []
    doc = yaml.safe_load(text)
    known = emitted_metrics()
    rules = [r for g in doc.get("groups", []) for r in g.get("rules", [])]
    if not rules:
        problems.append("alerts.yaml: no rules")
    for r in rules:
        name = r.get("alert", "?")
        for key in ("alert", "expr"):
            if not r.get(key):
                problems.append(f"alerts.yaml: {name} has no {key}")
        if not (r.get("labels") or {}).get("severity"):
            problems.append(f"alerts.yaml: {name} has no severity label")
        for metric in set(re.findall(r"\b(eden_[a-z_]+?)(?:_bucket|_sum|_count)?\b", str(r.get("expr", "")))):
            base = re.sub(r"_(bucket|sum|count)$", "", metric)
            if metric not in known and base not in known:
                problems.append(f"alerts.yaml: {name} uses {metric}, which Eden does not emit")
    return problems


def main() -> None:
    mon = ROOT / "monitoring"
    problems = check_alloy((mon / "config.alloy").read_text()) + check_alerts((mon / "alerts.yaml").read_text())
    for p in problems:
        print(p)
    print("monitoring: ok" if not problems else f"monitoring: {len(problems)} problem(s)")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
