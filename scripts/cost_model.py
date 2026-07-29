#!/usr/bin/env python3
"""Infrastructure cost / usage projection for Eden.

Every MEASURED value below was read from the live providers on
2026-07-29 (Neon consumption API, Northflank plans API, production
Postgres). Every ASSUMED value is labelled and collected at the top so
it can be argued with — the point of this script is that the
assumptions are visible, not buried in prose.

    python scripts/cost_model.py
"""

from __future__ import annotations

# ── MEASURED (live providers, 2026-07-29) ────────────────────────────

NEON_PLAN = "launch"                 # neonctl orgs list -> plan
NEON_BASE_USD = 19.0                 # Launch
NEON_INCLUDED_CU_H = 300.0
NEON_INCLUDED_GB = 10.0
NEON_OVERAGE_CU_H = 0.16             # published Launch overage
NEON_OVERAGE_GB = 0.35
NEON_CU_H_AT_ZERO_USERS = 215.0      # 198.6 measured over 28.65d -> 31d
NEON_STORAGE_GB_NOW = 0.065          # 64.8 MB
NEON_MAX_CU = 8.0                    # autoscaling_limit_max_cu on this project

NF_PLAN_USD = 12.0                   # nf-compute-50, 0.5 vCPU / 1 GB
NF_RSS_MIB = 270.6                   # measured in the shipped image

UPSTASH_FREE_CMDS = 500_000          # per month; currently AT the cap
UPSTASH_PER_100K = 0.20              # pay-as-you-go beyond free

# Self-generated Postgres writes/day, measured with ZERO user telemetry.
SYNTHETIC_WRITES_PER_ORG_DAY = 540.0   # 4,860/day observed at 9 orgs
HEARTBEAT_WRITES_PER_DAY = 2_933.0     # fixed: per component, not per org

# ── ASSUMED (argue with these) ───────────────────────────────────────

TRACES_PER_ORG_DAY = 1_000      # an actively-instrumented org
EVENTS_PER_TRACE = 10
# Postgres rows written per completed trace, from the code path:
#   10 telemetry_events + 5 trace_*_reports + up to 20 signal_events
ROWS_PER_TRACE = 35
BYTES_PER_EVENT = 1_500         # payload JSON post-zstd, order-of-magnitude
RETENTION_DAYS = 30

TIERS = [0, 100, 1_000, 10_000]


def fmt_usd(x: float) -> str:
    return f"${x:,.0f}" if x >= 100 else f"${x:,.2f}"


def project(orgs: int) -> dict[str, float]:
    # --- Postgres write volume -------------------------------------
    self_writes_day = HEARTBEAT_WRITES_PER_DAY + orgs * SYNTHETIC_WRITES_PER_ORG_DAY
    user_writes_day = orgs * TRACES_PER_ORG_DAY * ROWS_PER_TRACE
    total_writes_day = self_writes_day + user_writes_day

    # --- Neon compute ----------------------------------------------
    # At zero users the endpoint is already awake 68% of the month on
    # self-load alone. Any sustained user traffic pins it to 100%, after
    # which CU (not awake-time) is what grows. Model: awake-hours
    # saturate at 744, average CU scales with write rate off the
    # measured 0.425 CU baseline.
    hours_month = 744.0
    if orgs == 0:
        cu_h = NEON_CU_H_AT_ZERO_USERS
    else:
        baseline_writes = HEARTBEAT_WRITES_PER_DAY + 9 * SYNTHETIC_WRITES_PER_ORG_DAY
        load_ratio = total_writes_day / baseline_writes
        raw_cu = 0.425 * max(1.0, load_ratio ** 0.5)  # sublinear
        avg_cu = min(NEON_MAX_CU, raw_cu)
        cu_h = hours_month * avg_cu

    cu_over = max(0.0, cu_h - NEON_INCLUDED_CU_H)

    # --- Neon storage ----------------------------------------------
    events_day = orgs * TRACES_PER_ORG_DAY * EVENTS_PER_TRACE
    storage_gb = NEON_STORAGE_GB_NOW + (
        events_day * BYTES_PER_EVENT * RETENTION_DAYS / 1e9
    )
    gb_over = max(0.0, storage_gb - NEON_INCLUDED_GB)

    neon = NEON_BASE_USD + cu_over * NEON_OVERAGE_CU_H + gb_over * NEON_OVERAGE_GB

    # --- Northflank compute ----------------------------------------
    # 0.5 vCPU serves a near-idle API. Scale replicas roughly with
    # request volume; 1 replica per ~2,000 traces/day sustained is a
    # deliberately conservative placeholder.
    replicas = max(1, round(orgs * TRACES_PER_ORG_DAY / 20_000))
    northflank = NF_PLAN_USD * replicas

    # --- Upstash ----------------------------------------------------
    # Background loops are a fixed ~166k/mo after the bundle-lock fix.
    # Per-request Redis use scales with traffic.
    redis_cmds = 166_000 + events_day * 30 * 0.5   # ~0.5 cmd/event
    redis_over = max(0.0, redis_cmds - UPSTASH_FREE_CMDS)
    upstash = redis_over / 100_000 * UPSTASH_PER_100K

    return {
        "saturated": orgs > 0 and raw_cu > NEON_MAX_CU,
        "raw_cu": raw_cu if orgs > 0 else 0.425,
        "orgs": orgs,
        "events_day": events_day,
        "writes_day": total_writes_day,
        "self_writes_day": self_writes_day,
        "cu_h": cu_h,
        "storage_gb": storage_gb,
        "neon": neon,
        "northflank": northflank,
        "replicas": replicas,
        "redis_cmds": redis_cmds,
        "upstash": upstash,
    }


def main() -> int:
    rows = [project(n) for n in TIERS]

    print("=" * 78)
    print("USAGE")
    print("=" * 78)
    print(f"{'orgs':>8}{'events/day':>15}{'PG writes/day':>16}{'  of which self':>17}{'storage':>10}")
    for r in rows:
        self_pct = r["self_writes_day"] / r["writes_day"] * 100
        print(f"{r['orgs']:>8,}{r['events_day']:>15,.0f}{r['writes_day']:>16,.0f}"
              f"{self_pct:>16.1f}%{r['storage_gb']:>9.1f}G")

    print()
    print("=" * 78)
    print("COST  (USD / month)")
    print("=" * 78)
    print(f"{'orgs':>8}{'Neon':>10}{'CU-h':>9}{'Northflank':>12}{'repl':>6}"
          f"{'Upstash':>10}{'other*':>9}{'TOTAL':>10}")
    for r in rows:
        other = 0.0  # Qdrant/Tinybird/Vercel/Clerk free tiers at these sizes
        if r["orgs"] >= 1_000:
            other = 100.0   # paid tiers become unavoidable somewhere here
        if r["orgs"] >= 10_000:
            other = 800.0
        total = r["neon"] + r["northflank"] + r["upstash"] + other
        print(f"{r['orgs']:>8,}{fmt_usd(r['neon']):>10}{r['cu_h']:>9.0f}"
              f"{fmt_usd(r['northflank']):>12}{r['replicas']:>6}"
              f"{fmt_usd(r['upstash']):>10}{fmt_usd(other):>9}{fmt_usd(total):>10}"
              + ("   <-- Neon CU ceiling exceeded" if r["saturated"] else ""))

    print()
    print("* other = Qdrant + Tinybird + Vercel + Clerk + Sentry. All sit in")
    print("  free tiers today; the figures at 1k/10k are placeholders for when")
    print("  they do not. LLM spend is NOT included — see the report.")
    print()
    print("Assumptions:", f"{TRACES_PER_ORG_DAY:,} traces/org/day,",
          f"{EVENTS_PER_TRACE} events/trace,", f"{ROWS_PER_TRACE} PG rows/trace,",
          f"{BYTES_PER_EVENT}B/event,", f"{RETENTION_DAYS}d retention")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
