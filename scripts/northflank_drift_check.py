#!/usr/bin/env python3
"""Compare ``northflank.yml`` against the live Northflank project.

Why this exists
---------------
On 2026-07-29 an audit found that ``northflank.yml`` had never been
applied to the running project, and nothing in CI would ever apply it:

* the file declared compute ``nf-compute-20``; the service ran
  ``nf-compute-100-1`` (3.3x the cost),
* the file declared an HTTP health check on ``/ready``; the service had
  ``healthChecks: null``, so the platform could neither depool nor
  restart an unhealthy container — which is how a 7.4-day silent outage
  of every background loop went undetected,
* the file declared 92 environment variables on ``eden-api``; 11 were
  set,
* the file declared one secret group ``eden-required`` with 30 keys; the
  project had 31 single-key groups under different names
  (``JWT-SECRET``, not ``JWT_SECRET``).

Every tuning decision argued for in that file's comments — Neon
scale-to-zero pool sizing, Upstash command conservation, Sentry
environment separation — was therefore only partly in effect, and no
one could tell which parts.

This script makes that condition detectable. It is read-only: it never
mutates the project.

Usage
-----
    NORTHFLANK_API_TOKEN=... python scripts/northflank_drift_check.py
    python scripts/northflank_drift_check.py --json

Exit codes: 0 = no drift, 1 = drift found, 2 = could not compare.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
MANIFEST = REPO_ROOT / "northflank.yml"


def _nf(args: list[str]) -> Any:
    """Run the northflank CLI and return parsed JSON, or None."""
    try:
        proc = subprocess.run(
            ["northflank", *args, "-o", "json"],
            capture_output=True,
            text=True,
            timeout=90,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"error: northflank CLI unavailable: {exc}", file=sys.stderr)
        return None
    if proc.returncode != 0:
        print(f"error: northflank {' '.join(args)} failed:\n{proc.stderr[:400]}",
              file=sys.stderr)
        return None
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        print(f"error: non-JSON from northflank {' '.join(args)}", file=sys.stderr)
        return None


def _manifest_project() -> str:
    text = MANIFEST.read_text()
    m = re.search(r"^\s*name:\s*(eden-\S+)\s*$", text, re.M)
    return m.group(1) if m else "eden-staging-us-central"


def _manifest_service_block(text: str, name: str, next_name: str | None) -> str:
    start = text.index(f"name: {name}")
    end = text.index(f"name: {next_name}") if next_name else len(text)
    return text[start:end]


def _manifest_env_names(block: str) -> set[str]:
    return set(re.findall(r"^\s*- name: ([A-Z0-9_]+)\s*$", block, re.M))


def _manifest_plain_env(block: str) -> dict[str, str]:
    """Only the variables the manifest gives a literal ``value:``.

    Secret-backed variables (``valueFrom.secretKeyRef``) are delivered by
    the project's secret groups, which do not appear in a service's
    ``runtimeEnvironment``. Counting them as "missing" made this check
    report 31 phantom drifts for credentials that were present and
    working — a checker that cries wolf gets ignored, which defeats its
    whole purpose.
    """
    out: dict[str, str] = {}
    for name, body in re.findall(
        r"- name: ([A-Z0-9_]+)\n(.*?)(?=\n    - name: |\Z)", block, re.S
    ):
        if "secretKeyRef" in body:
            continue
        m = re.search(r'value:\s*"?([^"\n]*)"?', body)
        if m:
            out[name] = m.group(1).strip()
    return out


def _manifest_compute(block: str) -> str | None:
    m = re.search(r"^\s*name:\s*(nf-compute-\S+)\s*$", block, re.M)
    return m.group(1) if m else None


def _manifest_has_healthcheck(block: str) -> bool:
    return "healthCheck:" in block


def check() -> list[dict[str, str]]:
    """Return a list of drift records."""
    drift: list[dict[str, str]] = []
    project = _manifest_project()
    text = MANIFEST.read_text()

    live = _nf(["get", "service", "--project", project, "--service", "eden-api"])
    if live is None:
        raise SystemExit(2)
    svc = live.get("service", live)

    block = _manifest_service_block(text, "eden-api", "eden-worker")

    # 1. compute plan
    want_plan = _manifest_compute(block)
    got_plan = (svc.get("billing") or {}).get("deploymentPlan")
    if want_plan and got_plan and want_plan != got_plan:
        drift.append({
            "resource": "eden-api",
            "field": "compute.name",
            "manifest": want_plan,
            "live": got_plan,
            "impact": "cost and available CPU/RAM differ from what the manifest documents",
        })

    # 2. health checks — the highest-consequence field. Absent means the
    #    platform will never depool or restart an unhealthy container.
    want_hc = _manifest_has_healthcheck(block)
    got_hc = svc.get("healthChecks")
    if want_hc and not got_hc:
        drift.append({
            "resource": "eden-api",
            "field": "healthCheck",
            "manifest": "declared (HTTP /ready)",
            "live": "null — NO health check configured",
            "impact": "an unhealthy or wedged container is never restarted or depooled",
        })

    # 3. instances
    want_inst = re.search(r"^\s*instances:\s*(\d+)\s*$", block, re.M)
    got_inst = (svc.get("deployment") or {}).get("instances")
    if want_inst and got_inst is not None and int(want_inst.group(1)) != int(got_inst):
        drift.append({
            "resource": "eden-api",
            "field": "deployment.instances",
            "manifest": want_inst.group(1),
            "live": str(got_inst),
            "impact": "replica count differs; affects availability during deploys",
        })

    # 4. environment variables actually set on the service.
    #    Compared on plain values only — secret-backed vars come from the
    #    secret groups and are checked separately below.
    want_env = _manifest_plain_env(block)
    live_env = svc.get("runtimeEnvironment") or {}
    got_env = set(live_env)

    # A variable the manifest declares as a plain value may ALSO be owned
    # by a secret group (CLERK_JWKS_URL is, for one). The group supplies
    # it, so it is correctly absent from runtimeEnvironment and must not
    # be reported missing.
    secrets_doc = _nf(["list", "secrets", "--project", project])
    group_env_names: set[str] = set()
    if secrets_doc is not None:
        group_env_names = {
            (g.get("name") or "").replace("-", "_").upper()
            for g in (secrets_doc.get("secrets") or [])
        }

    missing = sorted(set(want_env) - got_env - group_env_names)
    if missing:
        drift.append({
            "resource": "eden-api",
            "field": "runtimeEnvironment",
            "manifest": f"{len(want_env)} plain-value vars declared",
            "live": f"{len(got_env)} set; {len(missing)} missing",
            "impact": "missing: " + ", ".join(missing[:12])
                      + (f" (+{len(missing) - 12} more)" if len(missing) > 12 else ""),
        })

    # 4b. set, but to a different value than the manifest says. This is
    #     the case that silently diverges without anything looking absent.
    wrong = sorted(
        (k, want_env[k], str(live_env[k]))
        for k in set(want_env) & got_env
        if str(live_env[k]).strip() != want_env[k]
    )
    if wrong:
        drift.append({
            "resource": "eden-api",
            "field": "runtimeEnvironment values",
            "manifest": "; ".join(f"{k}={v}" for k, v, _ in wrong[:6]),
            "live": "; ".join(f"{k}={lv}" for k, _, lv in wrong[:6]),
            "impact": f"{len(wrong)} variable(s) set to a value the manifest "
                      "does not declare",
        })

    # 5. secret groups
    secrets = secrets_doc
    if secrets is not None:
        live_groups = {g.get("name") for g in (secrets.get("secrets") or [])}
        declared = set(re.findall(r"group:\s*([a-zA-Z0-9_-]+)", text))
        absent = sorted(g for g in declared if g not in live_groups)
        if absent:
            # The manifest models one group holding every key; the project
            # actually has 31 single-key groups under hyphenated names
            # (JWT-SECRET, not JWT_SECRET). The credentials ARE delivered —
            # Postgres, Qdrant and Clerk all work — so this is a naming and
            # structure mismatch, not a missing-secret outage. Reported as
            # informational so it does not mask a real drift.
            drift.append({
                "resource": "project",
                "field": "secretGroups (informational)",
                "manifest": ", ".join(sorted(declared)),
                "live": f"{len(live_groups)} single-key groups under other names",
                "impact": "credentials ARE delivered and working; the manifest's "
                          "secretKeyRef group name simply does not exist, so this "
                          "file could never be applied as written",
            })

    return drift


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()

    drift = check()

    if args.json:
        print(json.dumps({"drift": drift, "count": len(drift)}, indent=2))
        return 1 if drift else 0

    if not drift:
        print("✓ northflank.yml matches the live project on every checked field.")
        return 0

    print(f"✗ {len(drift)} drift(s) between northflank.yml and the live project:\n")
    for d in drift:
        print(f"  [{d['resource']}] {d['field']}")
        print(f"      manifest: {d['manifest']}")
        print(f"      live    : {d['live']}")
        print(f"      impact  : {d['impact']}\n")
    print("northflank.yml is not applied by any CI job. Either apply it, or")
    print("update it to match reality — but do not leave the two disagreeing.")
    return 1


if __name__ == "__main__":
    if not os.environ.get("NORTHFLANK_API_TOKEN") and "--help" not in sys.argv:
        print("note: NORTHFLANK_API_TOKEN unset; relying on CLI login context",
              file=sys.stderr)
    sys.exit(main())
