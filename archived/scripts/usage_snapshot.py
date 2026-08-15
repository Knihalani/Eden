#!/usr/bin/env python3
"""Read-only usage snapshot of the production Postgres.

Feeds the cost model: real table sizes, row counts and ingest rates, so
per-user projections are extrapolated from measured data rather than
guessed. Runs only SELECTs.

    python scripts/usage_snapshot.py
"""

from __future__ import annotations

import asyncio
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def _dsn() -> str:
    txt = (REPO / ".env").read_text()
    m = re.search(r"^DATABASE_URL=(.*)$", txt, re.M)
    if not m:
        raise SystemExit("no DATABASE_URL in .env")
    url = m.group(1).strip()
    url = url.replace("postgresql+asyncpg://", "postgresql://")
    return url.split("?")[0]


TOP_TABLES = """
SELECT relname AS table,
       n_live_tup AS est_rows,
       pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
       pg_total_relation_size(relid) AS bytes
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 20
"""

TENANCY = [
    ("organizations", "SELECT count(*) FROM organizations"),
    ("users", "SELECT count(*) FROM users"),
    ("org_members", "SELECT count(*) FROM org_members"),
    ("api_keys", "SELECT count(*) FROM api_keys"),
]

VOLUME = [
    ("telemetry_events total", "SELECT count(*) FROM telemetry_events"),
    ("distinct traces",
     "SELECT count(DISTINCT trace_id) FROM telemetry_events"),
    ("events last 24h",
     "SELECT count(*) FROM telemetry_events WHERE timestamp > now() - interval '24 hours'"),
    ("events last 7d",
     "SELECT count(*) FROM telemetry_events WHERE timestamp > now() - interval '7 days'"),
    ("distinct tenants seen",
     "SELECT count(DISTINCT tenant_id) FROM telemetry_events"),
    ("earliest event", "SELECT min(timestamp)::text FROM telemetry_events"),
    ("latest event", "SELECT max(timestamp)::text FROM telemetry_events"),
]


async def main() -> int:
    try:
        import asyncpg
    except ImportError:
        print("asyncpg not installed", file=sys.stderr)
        return 2

    conn = await asyncpg.connect(_dsn(), ssl="require")
    try:
        print("=" * 68)
        print("DATABASE SIZE")
        print("=" * 68)
        total = await conn.fetchval(
            "SELECT pg_size_pretty(pg_database_size(current_database()))"
        )
        print(f"  total database size : {total}")

        print()
        print("=" * 68)
        print("LARGEST TABLES")
        print("=" * 68)
        rows = await conn.fetch(TOP_TABLES)
        print(f"  {'table':38}{'est rows':>12}{'size':>14}")
        for r in rows:
            print(f"  {r['table'][:36]:38}{r['est_rows']:>12,}{r['total_size']:>14}")

        for title, queries in (("TENANCY", TENANCY), ("TELEMETRY VOLUME", VOLUME)):
            print()
            print("=" * 68)
            print(title)
            print("=" * 68)
            for label, q in queries:
                try:
                    print(f"  {label:34}: {await conn.fetchval(q)}")
                except Exception as exc:
                    print(f"  {label:34}: n/a ({str(exc)[:50]})")

        # Per-tenant spread — drives the per-user extrapolation.
        print()
        print("=" * 68)
        print("PER-TENANT EVENT COUNTS")
        print("=" * 68)
        try:
            per = await conn.fetch(
                "SELECT tenant_id, count(*) AS n FROM telemetry_events "
                "GROUP BY tenant_id ORDER BY n DESC LIMIT 10"
            )
            for r in per:
                print(f"  {str(r['tenant_id'])[:40]:42}{r['n']:>10,}")
        except Exception as exc:
            print(f"  n/a ({str(exc)[:60]})")
    finally:
        await conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
