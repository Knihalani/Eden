#!/usr/bin/env python3
"""Locate ingested events after the ingest endpoint reports success.

``POST /orgs/{org}/ingest/openai`` returns
``{"accepted": 1, "rejected": 0}`` and nothing appears in
``telemetry_events``. Either the write is buffered somewhere and lands
later, or it is acknowledged and dropped — which is the worse outcome
and the one a customer would hit during a demo.

Read-only.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

CANDIDATES = [
    ("telemetry_events", "trace_id"),
    ("clickhouse_fallback", None),
    ("usage_events", None),
    ("trace_messages", "trace_id"),
    ("trace_patterns", None),
]


def _dsn() -> str:
    txt = (REPO / ".env").read_text()
    url = re.search(r"^DATABASE_URL=(.*)$", txt, re.M).group(1).strip()
    return url.replace("postgresql+asyncpg://", "postgresql://").split("?")[0]


async def main() -> int:
    import asyncpg

    conn = await asyncpg.connect(_dsn(), ssl="require")
    try:
        print("rows matching the smoke trace prefix:")
        for table, col in CANDIDATES:
            try:
                if col:
                    n = await conn.fetchval(
                        f"SELECT count(*) FROM {table} WHERE {col} LIKE 'smoke-%'"
                    )
                    print(f"  {table:24} smoke={n}")
                else:
                    n = await conn.fetchval(f"SELECT count(*) FROM {table}")
                    print(f"  {table:24} total={n}")
            except Exception as exc:
                print(f"  {table:24} n/a ({str(exc)[:44]})")

        print()
        print("telemetry_events overall:")
        print("  total       :", await conn.fetchval(
            "SELECT count(*) FROM telemetry_events"))
        print("  latest ts   :", await conn.fetchval(
            "SELECT max(timestamp)::text FROM telemetry_events"))
        print("  last 1h     :", await conn.fetchval(
            "SELECT count(*) FROM telemetry_events "
            "WHERE timestamp > now() - interval '1 hour'"))

        print()
        print("is it a hypertable with chunks holding the data?")
        try:
            rows = await conn.fetch(
                "SELECT relname, n_live_tup FROM pg_stat_user_tables "
                "WHERE relname LIKE '_hyper%' ORDER BY n_live_tup DESC LIMIT 6"
            )
            for r in rows:
                print(f"  {r['relname']:24} live_tup={r['n_live_tup']}")
        except Exception as exc:
            print("  n/a", str(exc)[:60])
    finally:
        await conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
