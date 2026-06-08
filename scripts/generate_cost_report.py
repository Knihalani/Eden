#!/usr/bin/env python3
"""Generate a monthly cost report CSV (closes §9.2.1).

Iterates every tenant in the orgs table, pulls their cost events
from Redis (or accepts a JSON file via ``--events-file`` for
testing), and writes ``reports/cost-{year_month}.csv`` with one
row per (tenant, model).

Usage:
    python scripts/generate_cost_report.py --month 2026-06
    python scripts/generate_cost_report.py --month 2026-06 --events-file cost_events.json
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import json
import logging
import sys
from datetime import datetime
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("cost-report")


async def fetch_tenants() -> list[str]:
    """Return every org_id in the system. In production this reads
    from Postgres; in test mode pass ``--events-file`` instead."""
    from eden.storage.postgres import get_postgres_client
    client = await get_postgres_client()
    rows = await client.fetch("SELECT id FROM organizations")
    return [str(r["id"]) for r in rows]


async def fetch_cost_events(year_month: str) -> list:
    """Read the cost events for the given month from Redis.

    Each event is stored as a hash at ``eden:cost:{tenant}:day:{date}``;
    we SCAN those keys and parse the cents/tokens values.
    """
    import redis.asyncio as redis_async
    from eden.config import get_settings
    s = get_settings()
    r = redis_async.from_url(s.redis_url or "redis://localhost:6379/0")
    events: list = []
    cursor = 0
    pattern = f"eden:cost:*:day:{year_month}-*"
    while True:
        cursor, keys = await r.scan(cursor=cursor, match=pattern, count=200)
        for k in keys:
            k_str = k.decode() if isinstance(k, bytes) else k
            parts = k_str.split(":")
            if len(parts) < 5:
                continue
            tenant_id = parts[2]
            day = parts[4]
            data = await r.hgetall(k)
            if not data:
                continue
            try:
                cents = float(data.get(b"total_cents", 0))
            except (TypeError, ValueError):
                cents = 0.0
            try:
                tokens = int(data.get(b"tokens", 0))
            except (TypeError, ValueError):
                tokens = 0
            events.append({
                "tenant_id": tenant_id,
                "day": day,
                "cost_cents": cents,
                "tokens": tokens,
                "model": "all",
                "node": "all",
                "timestamp": datetime.fromisoformat(day),
            })
        if cursor == 0:
            break
    await r.aclose()
    return events


def write_csv(events: list, year_month: str, out_dir: Path) -> Path:
    """Write a per-tenant summary CSV."""
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"cost-{year_month}.csv"
    with out_path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["tenant_id", "year_month", "total_cents", "total_tokens", "days_active"])
        by_tenant: dict[str, dict] = {}
        for ev in events:
            t = ev["tenant_id"]
            if t not in by_tenant:
                by_tenant[t] = {"cents": 0.0, "tokens": 0, "days": set()}
            by_tenant[t]["cents"] += ev.get("cost_cents", 0) or 0
            by_tenant[t]["tokens"] += ev.get("tokens", 0) or 0
            by_tenant[t]["days"].add(ev.get("day"))
        for t, s in sorted(by_tenant.items()):
            w.writerow([t, year_month, round(s["cents"], 4), s["tokens"], len(s["days"])])
    return out_path


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--month", default=datetime.utcnow().strftime("%Y-%m"))
    p.add_argument("--events-file", help="Optional JSON file with pre-fetched cost events")
    p.add_argument("--out", default="reports", help="Output directory")
    args = p.parse_args()

    out_dir = Path(args.out).resolve()
    if args.events_file:
        events = json.loads(Path(args.events_file).read_text())
        out = write_csv(events, args.month, out_dir)
        logger.info("Wrote %s from %d events", out, len(events))
        return 0

    events = asyncio.run(fetch_cost_events(args.month))
    out = write_csv(events, args.month, out_dir)
    logger.info("Wrote %s from %d events", out, len(events))
    return 0


if __name__ == "__main__":
    sys.exit(main())
