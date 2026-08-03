#!/usr/bin/env python3
"""Autonomy-loop baseline report (AUTONOMY-OVERHAUL-PLAN §0 / Phase 0).

Emits the current value of every §0 success metric from the live tables
(`improvement_plans`, `issue_verifications`, `autonomy_audit_log`,
`customer_cost_events`, `agent_activity_events`, `agent_issues`), plus
the plan's assertable queries (issues stuck in ``fix_pending`` > 24h,
``triaged`` issues with an empty triage payload).

Every metric that cannot be computed prints ``unmeasured`` — that is a
finding, not an error (§2.1: "Missing data → 'unmeasured' is itself the
finding"). Run weekly; snapshot into ``docs/ops/autonomy-baseline/``.

    uv run python scripts/autonomy_baseline.py             # best-effort DB
    uv run python scripts/autonomy_baseline.py --dry-run   # print queries only
    uv run python scripts/autonomy_baseline.py --require-db  # exit 1 if no DB

Exit code is 0 unless ``--require-db`` is passed and the DB connection
fails.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from typing import Any

UNMEASURED = "unmeasured"

# Look-back windows (days). Argue with these, don't bury them.
WINDOW_RATE_DAYS = 30       # merge-and-hold / bad-PR rates
WINDOW_HOLD_DAYS = 7        # "no guardian regression" hold window
WINDOW_AUDIT_DAYS = 7       # autonomy decision mix
WINDOW_ACTIVITY_DAYS = 7    # agent_activity_events volume

# ── §0 metric + assertable queries ───────────────────────────────────
# name -> (description, SQL, scalar-extractor hint)
QUERIES: dict[str, tuple[str, str]] = {
    "plans_by_status": (
        "improvement_plans count by status (context for every rate below)",
        "SELECT status, COUNT(*) AS n FROM improvement_plans GROUP BY status ORDER BY n DESC",
    ),
    "fix_pr_merge_and_hold_rate": (
        "§0: merged plans with no guardian follow-up within "
        f"{WINDOW_HOLD_DAYS}d ÷ merged plans (last {WINDOW_RATE_DAYS}d)",
        f"""
        WITH merged AS (
            SELECT id FROM improvement_plans
            WHERE status = 'merged'
              AND updated_at >= NOW() - INTERVAL '{WINDOW_RATE_DAYS} days'
        ),
        regressed AS (
            SELECT DISTINCT parent_plan_id AS id FROM improvement_plans
            WHERE parent_plan_id IS NOT NULL
              AND evidence ? 'guardian_action'
              AND created_at >= NOW() - INTERVAL '{WINDOW_RATE_DAYS + WINDOW_HOLD_DAYS} days'
        )
        SELECT (SELECT COUNT(*) FROM merged)                                   AS merged,
               (SELECT COUNT(*) FROM merged m WHERE m.id IN (SELECT id FROM regressed)) AS regressed
        """,
    ),
    "bad_pr_rate": (
        "§0: PRs opened then closed-unmerged/rejected ÷ all plans that "
        f"opened a PR (last {WINDOW_RATE_DAYS}d)",
        f"""
        SELECT COUNT(*) FILTER (WHERE status IN ('closed', 'rejected'))  AS bad,
               COUNT(*)                                                  AS opened
        FROM improvement_plans
        WHERE pr_url IS NOT NULL
          AND updated_at >= NOW() - INTERVAL '{WINDOW_RATE_DAYS} days'
        """,
    ),
    "p0_first_remediation_latency_s": (
        "§0: P0 issue created → first heal/patch transition, seconds "
        "(avg over transitions present; ∞/no rows today = always-human)",
        """
        SELECT AVG(EXTRACT(EPOCH FROM (t.created_at - i.created_at))) AS avg_s,
               COUNT(*) AS n
        FROM issue_state_transitions t
        JOIN agent_issues i ON i.id = t.issue_id AND i.org_id = t.org_id
        WHERE i.severity = 'p0'
          AND t.event_type IN ('heal_requested', 'patch_proposed', 'heal_executed')
        """,
    ),
    "llm_usd_per_merged_fix": (
        f"§0: patches+autonomy cost-ledger spend ÷ merged plans (last {WINDOW_RATE_DAYS}d)",
        f"""
        SELECT (SELECT COALESCE(SUM(cost_usd), 0) FROM customer_cost_events
                WHERE feature IN ('patches', 'autonomy')
                  AND recorded_at >= NOW() - INTERVAL '{WINDOW_RATE_DAYS} days') AS spend_usd,
               (SELECT COUNT(*) FROM improvement_plans
                WHERE status = 'merged'
                  AND updated_at >= NOW() - INTERVAL '{WINDOW_RATE_DAYS} days')  AS merged
        """,
    ),
    "patch_spend_merged_share": (
        "§0: share of patch-gen spend (improvement_plans.llm_cost_usd) that "
        "ended in a merged PR (target ≥ 70%)",
        f"""
        SELECT COALESCE(SUM(llm_cost_usd) FILTER (WHERE status = 'merged'), 0) AS merged_usd,
               COALESCE(SUM(llm_cost_usd), 0)                                  AS total_usd
        FROM improvement_plans
        WHERE created_at >= NOW() - INTERVAL '{WINDOW_RATE_DAYS} days'
        """,
    ),
    "fix_pending_stuck_over_24h": (
        "§0 + assertable: issues sitting in fix_pending > 24h (target 0)",
        """
        SELECT COUNT(*) AS n FROM agent_issues
        WHERE status = 'fix_pending'
          AND updated_at < NOW() - INTERVAL '24 hours'
        """,
    ),
    "triaged_with_empty_payload": (
        "assertable (D5): issues in triaged with an empty/error triage payload (target 0)",
        """
        SELECT COUNT(*) AS n FROM agent_issues
        WHERE status = 'triaged'
          AND (triage_result IS NULL
               OR triage_result = '{}'::jsonb
               OR COALESCE(triage_result->>'source', '') IN ('', 'error'))
        """,
    ),
    "verifications_by_status": (
        "issue_verifications count by status (verify truthfulness context, D6)",
        "SELECT status, COUNT(*) AS n FROM issue_verifications GROUP BY status ORDER BY n DESC",
    ),
    "autonomy_decisions_7d": (
        f"autonomy_audit_log decision mix, last {WINDOW_AUDIT_DAYS}d "
        "(all-deny/require_approval = heals never fire, D1/D2)",
        f"""
        SELECT decision, COUNT(*) AS n FROM autonomy_audit_log
        WHERE created_at >= NOW() - INTERVAL '{WINDOW_AUDIT_DAYS} days'
        GROUP BY decision ORDER BY n DESC
        """,
    ),
    "agent_activity_events_7d": (
        f"agent_activity_events rows, last {WINDOW_ACTIVITY_DAYS}d "
        "(orphan table — no writers found in code; 0 expected)",
        f"""
        SELECT COUNT(*) AS n FROM agent_activity_events
        WHERE created_at >= NOW() - INTERVAL '{WINDOW_ACTIVITY_DAYS} days'
        """,
    ),
}

# §0 metrics with no data source yet — printing them as unmeasured IS the
# baseline finding.
UNMEASURABLE: dict[str, str] = {
    "loop_dead_time": (
        "§0: Redis/bus-down detection latency — no liveness probe exists "
        "until M2's /internal/loop-health + loop_events_outbox"
    ),
    "secrets_in_evidence": (
        "§0: secret values in plan evidence / PR bodies — no value-level "
        "scanner exists until §7.2 lands (redaction is key-name-only, D23)"
    ),
}


def _fmt_rows(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return "(no rows)"
    return "; ".join(
        ", ".join(f"{k}={v}" for k, v in row.items()) for row in rows
    )


def _derive(name: str, rows: list[dict[str, Any]]) -> str | None:
    """Turn raw rows into the headline §0 number where one exists."""
    if not rows:
        return None
    r = rows[0]
    try:
        if name == "fix_pr_merge_and_hold_rate":
            merged, regressed = int(r["merged"]), int(r["regressed"])
            if merged == 0:
                return f"{UNMEASURED} (0 merged plans in window)"
            return f"{(merged - regressed) / merged:.1%} ({merged - regressed}/{merged} held)"
        if name == "bad_pr_rate":
            bad, opened = int(r["bad"]), int(r["opened"])
            if opened == 0:
                return f"{UNMEASURED} (0 PRs opened in window)"
            return f"{bad / opened:.1%} ({bad}/{opened})"
        if name == "p0_first_remediation_latency_s":
            n = int(r.get("n") or 0)
            if n == 0 or r.get("avg_s") is None:
                return "∞ (no P0 heal/patch transitions recorded — always human)"
            return f"{float(r['avg_s']):.0f}s avg over {n}"
        if name == "llm_usd_per_merged_fix":
            spend, merged = float(r["spend_usd"] or 0), int(r["merged"])
            if merged == 0:
                return f"{UNMEASURED} (${spend:.2f} spent, 0 merged fixes)"
            return f"${spend / merged:.2f}/merged fix (${spend:.2f} over {merged})"
        if name == "patch_spend_merged_share":
            merged_usd, total = float(r["merged_usd"] or 0), float(r["total_usd"] or 0)
            if total == 0:
                return f"{UNMEASURED} (no plan llm_cost_usd recorded)"
            return f"{merged_usd / total:.1%} of ${total:.2f} plan spend ended merged"
        if name in ("fix_pending_stuck_over_24h", "triaged_with_empty_payload",
                    "agent_activity_events_7d"):
            return str(int(r["n"]))
    except (KeyError, TypeError, ValueError):
        return None
    return None


async def run_report(require_db: bool) -> int:
    client = None
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
    except Exception as exc:  # noqa: BLE001 — no DB is a finding, not a crash
        print(f"[warn] Postgres unavailable: {exc}", file=sys.stderr)
        if require_db:
            return 1

    print("=" * 78)
    print("AUTONOMY BASELINE — spec §0 metrics + assertable queries")
    print("=" * 78)

    for name, (desc, sql) in QUERIES.items():
        print(f"\n## {name}\n#  {desc}")
        if client is None:
            print(f"   {UNMEASURED} (no database connection)")
            continue
        try:
            rows = await client.fetch(sql)
        except Exception as exc:  # noqa: BLE001 — per-metric failure isolated
            print(f"   {UNMEASURED} (query failed: {str(exc)[:120]})")
            continue
        headline = _derive(name, rows)
        if headline is not None:
            print(f"   {headline}")
        print(f"   raw: {_fmt_rows(rows)}")

    print()
    print("=" * 78)
    print("UNMEASURABLE TODAY (the finding is that there is no data source)")
    print("=" * 78)
    for name, why in UNMEASURABLE.items():
        print(f"\n## {name}\n#  {why}\n   {UNMEASURED}")
    print()
    return 0


def dry_run() -> int:
    print("=" * 78)
    print("AUTONOMY BASELINE — dry run (queries only, no DB connection)")
    print("=" * 78)
    for name, (desc, sql) in QUERIES.items():
        print(f"\n-- {name}: {desc}")
        print(sql.strip())
    for name, why in UNMEASURABLE.items():
        print(f"\n-- {name}: {why}\n-- (no query — {UNMEASURED})")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print every metric query without connecting to the database",
    )
    parser.add_argument(
        "--require-db",
        action="store_true",
        help="exit non-zero when the database connection fails "
        "(default: degrade to 'unmeasured' and exit 0)",
    )
    args = parser.parse_args()
    if args.dry_run:
        return dry_run()
    return asyncio.run(run_report(require_db=args.require_db))


if __name__ == "__main__":
    raise SystemExit(main())
