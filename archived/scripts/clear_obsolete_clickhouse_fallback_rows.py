"""Mark undiagnosable pre-fix ``clickhouse_fallback`` rows as dead.

Context (docs/ops/known-issues.md #1): ``ClickHouseSink._fallback_to_postgres``
never populated ``error_message`` until 2026-07-30, so every row parked
before that fix carries a NULL reason and cannot be diagnosed. The drain
(``eden.data_platform.clickhouse_fallback_drain``) reads oldest-first, so
these rows sit at the head of the queue ahead of anything newer and
diagnosable.

This script marks them ``dead_at`` (the same terminal state the drain
itself uses for a row that exhausts its retries) rather than deleting
them, so:

* the existing purge job (``_purge_settled``) still applies the normal
  30-day retention window afterwards instead of this being an immediate,
  irreversible delete;
* the audit trail (target_table, failed_at, id) survives until the purge;
* nothing in ``telemetry_events`` or any other Postgres source-of-truth
  table is touched — this only clears the ClickHouse *mirror's* retry
  queue, never the durable write path the portal actually reads from.

Usage:
    python scripts/clear_obsolete_clickhouse_fallback_rows.py             # report only
    python scripts/clear_obsolete_clickhouse_fallback_rows.py --apply     # write

    # Override the cutoff (ISO date) if diagnosing a different backlog:
    python scripts/clear_obsolete_clickhouse_fallback_rows.py --before 2026-07-30 --apply
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from datetime import UTC, datetime


async def main(apply: bool, before: str | None) -> int:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL is not set", file=sys.stderr)
        return 2

    import asyncpg

    from eden.data_platform.clickhouse_fallback_drain import (
        _ERROR_MESSAGE_FIX_CUTOFF,
        _PURGE_DEAD_AFTER_DAYS,
        mark_obsolete_pre_fix_rows_dead,
    )

    cutoff = datetime.fromisoformat(before).replace(tzinfo=UTC) if before else _ERROR_MESSAGE_FIX_CUTOFF

    conn = await asyncpg.connect(dsn)

    class Adapter:
        async def fetch(self, q: str, *a: object) -> list[dict]:
            return [dict(r) for r in await conn.fetch(q, *a)]

        async def execute(self, q: str, *a: object) -> str:
            return await conn.execute(q, *a)

    try:
        pg = Adapter()
        result = await mark_obsolete_pre_fix_rows_dead(pg, cutoff=cutoff, dry_run=not apply)

        if result["candidates"] == 0:
            print(f"No undiagnosable rows parked before {cutoff.isoformat()}. Nothing to do.")
            return 0

        if not apply:
            print(
                f"Found {result['candidates']} row(s) parked before {cutoff.isoformat()} "
                f"with no error_message (undiagnosable, pre-fix backlog):\n"
            )
            for rid in result.get("ids", []):
                print(f"  {rid}")
            print(
                f"\nRe-run with --apply to mark these dead_at (not delete). "
                f"The existing purge job removes dead rows after "
                f"{_PURGE_DEAD_AFTER_DAYS} days."
            )
            return 0

        print(f"Marked {result['marked_dead']} row(s) dead_at. This did not touch telemetry_events.")
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="write dead_at (default: report only)")
    ap.add_argument(
        "--before",
        default=None,
        help="ISO date cutoff (default: 2026-07-30, the error_message fix date)",
    )
    args = ap.parse_args()
    raise SystemExit(asyncio.run(main(args.apply, args.before)))
