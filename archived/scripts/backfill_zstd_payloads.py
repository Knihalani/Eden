"""Backfill zstd-compressed columns on ``telemetry_events``.

For each row where ``request_body_zstd`` (or ``response_body_zstd``) is
NULL and the original JSONB column is not NULL, compress with the
trained dictionary and write to the BYTEA column. Idempotent and
resumable — re-run any time and it picks up where it left off.

Usage:
    uv run python scripts/backfill_zstd_payloads.py \\
        --batch-size 1000 \\
        --max-batches 10000 \\
        --sleep-ms 50

Defaults are safe for production. The script never blocks on a single
row (no row holds a lock for more than a few ms), and the sleep
between batches lets the WAL flush.

Why a separate script and not part of the alembic migration
------------------------------------------------------------
Alembic migrations are atomic transactions; doing the backfill in a
migration would hold a transaction open for hours on a 100M-row table
and block ``ALTER TABLE`` operations needed for incident response.
Running the backfill out-of-band is the standard pattern.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from typing import Any

import asyncpg

from eden.storage.compression import compress_jsonb

logger = logging.getLogger(__name__)


# The two columns we backfill. Add more (e.g. reasoning, tool_calls_full)
# once the headline pair is fully migrated and the dict proves itself.
_TARGETS = [
    ("request_body", "request_body_zstd"),
    ("response_body", "response_body_zstd"),
]


async def backfill(
    dsn: str,
    table: str,
    batch_size: int,
    max_batches: int,
    sleep_ms: int,
) -> dict[str, int]:
    """Backfill zstd columns. Returns a per-column row count."""
    conn = await asyncpg.connect(dsn=dsn)
    counts: dict[str, int] = {new: 0 for _, new in _TARGETS}
    try:
        for old_col, new_col in _TARGETS:
            logger.info(
                "Backfilling %s.%s -> %s (batch_size=%d)...",
                table,
                old_col,
                new_col,
                batch_size,
            )
            batches = 0
            while batches < max_batches:
                # Server-side cursor pagination via OFFSET/LIMIT on a
                # filtered subquery. For very large tables this could
                # be slow (offset cost); for a 100M-row table the
                # typical backfill completes in < 4 hours.
                rows = await conn.fetch(
                    f"""
                    SELECT event_id, {old_col}::text AS body
                      FROM {table}
                     WHERE {old_col} IS NOT NULL
                       AND {new_col} IS NULL
                     ORDER BY timestamp ASC
                     LIMIT $1
                    """,
                    batch_size,
                )
                if not rows:
                    logger.info("No more rows to backfill for %s.", new_col)
                    break
                # Update in one round-trip per batch via UNNEST.
                ids = [r["event_id"] for r in rows]
                bodies = [
                    r["body"].encode("utf-8") if r["body"] is not None else None
                    for r in rows
                ]
                compressed: list[bytes | None] = [
                    compress_jsonb(json.loads(b.decode("utf-8"))) if b else None
                    for b in bodies
                ]
                await conn.execute(
                    f"""
                    UPDATE {table} AS t
                       SET {new_col} = c.body
                      FROM UNNEST($1::text[], $2::bytea[]) AS c(id, body)
                     WHERE t.event_id = c.id
                    """,
                    ids,
                    compressed,
                )
                counts[new_col] += len(rows)
                batches += 1
                logger.info(
                    "  %s: batch %d done (%d rows, %d total)",
                    new_col,
                    batches,
                    len(rows),
                    counts[new_col],
                )
                if sleep_ms > 0:
                    await asyncio.sleep(sleep_ms / 1000.0)
    finally:
        await conn.close()
    return counts


async def report_pending(dsn: str, table: str) -> dict[str, int]:
    """Print the per-target pending row count."""
    conn = await asyncpg.connect(dsn=dsn)
    pending: dict[str, int] = {}
    try:
        for old_col, new_col in _TARGETS:
            n = await conn.fetchval(
                f"""
                SELECT count(*)
                  FROM {table}
                 WHERE {old_col} IS NOT NULL
                   AND {new_col} IS NULL
                """
            )
            pending[new_col] = n or 0
    finally:
        await conn.close()
    return pending


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
    )

    parser = argparse.ArgumentParser(
        description="Backfill zstd-compressed columns on telemetry_events."
    )
    parser.add_argument(
        "--pg-url",
        default=None,
        help="Postgres DSN. Defaults to the configured test DB.",
    )
    parser.add_argument(
        "--table",
        default="telemetry_events",
        help="Table to backfill (default: telemetry_events).",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=1000,
        help="Rows per batch (default: 1000).",
    )
    parser.add_argument(
        "--max-batches",
        type=int,
        default=10_000,
        help="Maximum batches to process per column (default: 10000).",
    )
    parser.add_argument(
        "--sleep-ms",
        type=int,
        default=50,
        help="Sleep between batches in ms (default: 50).",
    )
    parser.add_argument(
        "--report-only",
        action="store_true",
        help="Just print the pending count and exit (no writes).",
    )
    args = parser.parse_args()

    if args.pg_url is None:
        from eden.config import get_settings

        s = get_settings()
        args.pg_url = (
            f"postgresql://{s.postgres_user}:{s.postgres_password}"
            f"@{s.postgres_host}:{s.postgres_port}/{s.postgres_db}"
        )

    start = time.time()
    if args.report_only:
        pending = asyncio.run(report_pending(args.pg_url, args.table))
        for col, n in pending.items():
            print(f"  {col}: {n} pending", file=sys.stderr)
        return 0

    counts = asyncio.run(
        backfill(
            args.pg_url,
            args.table,
            args.batch_size,
            args.max_batches,
            args.sleep_ms,
        )
    )
    elapsed = time.time() - start
    for col, n in counts.items():
        logger.info("Backfilled %d rows into %s in %.1fs", n, col, elapsed)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
