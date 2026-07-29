#!/usr/bin/env python3
"""Measure how much database traffic the platform generates for ITSELF.

At low user counts this dominates the bill: on 2026-07-29 the product
had 47 telemetry events lifetime and 0 in the previous 24h, while Neon
reported the compute endpoint awake 62.6% of the month. That gap is
background loops, heartbeats and synthetic runs — fixed overhead that
does not scale down with usage, so it sets the floor of the cost model.

Read-only.
"""

from __future__ import annotations

import asyncio
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

# (label, table, timestamp column)
SELF_TABLES = [
    ("component heartbeats", "eden_component_heartbeats", "checked_at"),
    ("synthetic runs", "eden_synthetic_runs", "created_at"),
    ("clickhouse fallback", "clickhouse_fallback", "created_at"),
    ("telemetry events (REAL USER LOAD)", "telemetry_events", "timestamp"),
]


def _dsn() -> str:
    txt = (REPO / ".env").read_text()
    url = re.search(r"^DATABASE_URL=(.*)$", txt, re.M).group(1).strip()
    return url.replace("postgresql+asyncpg://", "postgresql://").split("?")[0]


async def main() -> int:
    import asyncpg

    conn = await asyncpg.connect(_dsn(), ssl="require")
    try:
        print(f"{'source':38}{'24h':>10}{'7d':>10}{'/day':>10}")
        print("-" * 68)
        for label, table, ts in SELF_TABLES:
            try:
                d1 = await conn.fetchval(
                    f"SELECT count(*) FROM {table} "
                    f"WHERE {ts} > now() - interval '24 hours'"
                )
                d7 = await conn.fetchval(
                    f"SELECT count(*) FROM {table} "
                    f"WHERE {ts} > now() - interval '7 days'"
                )
                print(f"{label:38}{d1:>10,}{d7:>10,}{d7 / 7:>10,.0f}")
            except Exception as exc:
                print(f"{label:38}{'n/a':>10}  ({str(exc)[:34]})")

        print()
        print("heartbeat writers (who is keeping Postgres awake):")
        try:
            rows = await conn.fetch(
                "SELECT component, count(*) AS n, max(checked_at)::text AS latest "
                "FROM eden_component_heartbeats "
                "WHERE checked_at > now() - interval '24 hours' "
                "GROUP BY component ORDER BY n DESC"
            )
            if not rows:
                print("  (none in the last 24h)")
            for r in rows:
                print(f"  {r['component'][:30]:32}{r['n']:>8,} writes   latest {r['latest']}")
        except Exception as exc:
            print(f"  n/a ({str(exc)[:60]})")

        print()
        print("lease/lock table activity:")
        for t in ("eden_leader_leases", "quality_pipeline_watermark"):
            try:
                n = await conn.fetchval(f"SELECT count(*) FROM {t}")
                print(f"  {t:34}{n:>8,} rows")
            except Exception as exc:
                print(f"  {t:34}   n/a ({str(exc)[:40]})")
    finally:
        await conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
