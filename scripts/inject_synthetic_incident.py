#!/usr/bin/env python3
"""Inject a synthetic incident into a dev stack (plan M1, spec §2.2).

Seeds stumbles through the REAL detection write path
(``StumbleWriter.create`` → burst dedup → ``agent_stumbles`` insert →
``IssuePromoter.upsert`` → ``agent_issues`` open/regressed → issue hook →
closed-loop ISSUE_CREATED when the orchestrator is subscribed) — no
hand-rolled SQL, so whatever the loop does next is exactly what it would
do for real traffic.

    uv run python scripts/inject_synthetic_incident.py \
        --scenario code-bug --org <org-uuid> [--fingerprint fp-demo] [--count 6]

Scenarios:

* ``code-bug``          — N tool_error stumbles pointing at a known-buggy
                          file (drives triage → propose → PR).
* ``deploy-regression`` — N statgate_p0 stumbles (drives the StatGate P0
                          rail → rollback heal decision; the org needs an
                          ``autonomy_policies`` row with
                          ``auto_runtime_heal=true`` and an ACTIVE
                          ``prompt_canaries`` row for the heal to execute).
* ``regression``        — same fingerprint as ``code-bug`` re-fired, for
                          the post-merge quiet window (drives
                          VERIFY_FAILED → guardian).

``--fingerprint`` seeds the per-kind error signature so the derived
fingerprint is stable across runs (the writer computes the real
fingerprint from ``(kind, agent_id, error_signature)`` — see
``eden.issues.fingerprint``; we cannot set it directly and do not try).

Requires a reachable Postgres (DATABASE_URL / POSTGRES_* settings).
Redis is optional — without it only the 5s burst dedup is skipped.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from typing import Any

# The core _detail_for logic lives in the importable module so the
# onboarding seed route can reuse it without importing this script.
# The script re-exports the same constants for backwards-compat.
from eden.onboarding.demo_seed import (  # noqa: F401 — re-exported for callers
    DEMO_AGENT_ID_PREFIX,
    DEMO_DETECTED_BY,
    _detail_for as _demo_detail_for,
)

AGENT_ID = "synthetic-incident-agent"
BUGGY_FILE = "agent/checkout.py"


def _detail_for(scenario: str, seed: str) -> tuple[str, str, dict[str, Any]]:
    """Return (kind, title, detail) whose error signature embeds ``seed``
    so every stumble in the batch lands on one stable fingerprint.

    Thin shim — delegates to :func:`eden.onboarding.demo_seed._detail_for`
    with the legacy signature so existing callers are unaffected.
    """
    return _demo_detail_for(scenario, seed, seed)


async def inject(scenario: str, org_id: str, seed: str, count: int) -> int:
    from eden.issues.models import StumbleCreate
    from eden.issues.stumble_writer import StumbleWriter

    kind, title, detail = _detail_for(scenario, seed)
    writer = StumbleWriter()
    batch = int(time.time())
    issue = None
    fingerprint = ""
    inserted = 0

    for i in range(count):
        sc = StumbleCreate(
            org_id=org_id,
            trace_id=f"synthetic-{scenario}-{batch}-{i}",
            kind=kind,
            title=title,
            detail=dict(detail),
            detected_by="inject_synthetic_incident",
            agent_id=AGENT_ID,
            user_id=f"synthetic-user-{i % 3}",
        )
        result = await writer.create(sc)
        fingerprint = result.get("fingerprint") or fingerprint
        if result.get("inserted"):
            inserted += 1
        issue = result.get("issue") or issue
        print(
            f"stumble {i + 1}/{count}: inserted={result.get('inserted')} "
            f"deduped={result.get('deduped')} fingerprint={fingerprint}"
        )

    print()
    print(f"SCENARIO={scenario}")
    print(f"FINGERPRINT={fingerprint}")
    print(f"INSERTED={inserted}/{count}")
    if issue is not None:
        print(f"ISSUE_ID={issue.id}")
        print(f"ISSUE_STATUS={issue.status}")
        print(
            f"ISSUE={issue.severity} kind={issue.kind} "
            f"stumbles={issue.stumble_count} regressed={issue.was_regressed}"
        )
    else:
        print("ISSUE=none (promotion did not run — check Postgres connectivity)")

    if scenario == "deploy-regression":
        print(
            "\nheal prerequisites (not seeded here): an autonomy_policies row "
            "with auto_runtime_heal=true for the org, and an ACTIVE "
            "prompt_canaries row to roll back — without them the heal is "
            "denied/failed by design."
        )
    return 0 if inserted or issue is not None else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--scenario",
        required=True,
        choices=("code-bug", "deploy-regression", "regression"),
    )
    parser.add_argument("--org", required=True, help="org id (uuid)")
    parser.add_argument(
        "--fingerprint",
        default=None,
        help="stable seed for the derived fingerprint (default: scenario name)",
    )
    parser.add_argument(
        "--count",
        type=int,
        default=6,
        help="stumbles to inject (default 6 — above the ≥5 promote floor)",
    )
    args = parser.parse_args()
    seed = args.fingerprint or f"synthetic-{args.scenario}"
    try:
        return asyncio.run(inject(args.scenario, args.org, seed, args.count))
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # noqa: BLE001 — CLI surface, report and exit
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
