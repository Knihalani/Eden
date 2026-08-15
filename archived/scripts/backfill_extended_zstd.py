"""Backfill zstd-compressed columns on the 6 extended fields (Phase B2).

Mirrors :mod:`scripts.backfill_zstd_payloads` for the 6 new BYTEA
columns added in migration 038 (``:reasoning``, ``:tool_calls_full``,
``:tool_results``, ``:payload``, ``:metrics``, ``:attributes``).

For each row where the JSONB column is non-NULL and the corresponding
``*_zstd`` BYTEA column is NULL, compress with the trained ZSTD
dictionary and write to the BYTEA column. Idempotent and resumable
— re-run any time and it picks up where it left off.

Usage::

    # Production
    uv run python scripts/backfill_extended_zstd.py \\
        --batch-size 1000 --max-batches 10000 --sleep-ms 50

    # Report pending only (no writes)
    uv run python scripts/backfill_extended_zstd.py --report-only

Defaults are safe for production: never blocks on a single row,
sleeps between batches to let the WAL flush.

Pre-flight: train the dictionary on the new fields before running
the backfill for maximum ratio. See ``scripts/train_zstd_dict.py``::

    uv run python scripts/train_zstd_dict.py \\
        --sample-size 10000 \\
        --output /app/var/zstd_dict.bin

Why out-of-band
---------------
Alembic migrations are atomic transactions; doing the backfill in
a migration would hold a transaction open for hours on a 100M-row
table and block ``ALTER TABLE`` operations needed for incident
response. Same rationale as ``scripts/backfill_zstd_payloads.py``.
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


# The 6 (old, new) pairs backfilled by this script. Add to this list
# once migration 038 ships — paired with the dict retraining step
# above so the dictionary covers the new fields.
_TARGETS: list[tuple[str, str]] = [
    ("reasoning", "reasoning_zstd"),
    ("tool_calls_full", "tool_calls_full_zstd"),
    ("tool_results", "tool_results_zstd"),
    ("payload", "payload_zstd"),
    ("metrics", "metrics_zstd"),
    ("attributes", "attributes_zstd"),
]


async def backfill(
    dsn: str,
    table: str,
    batch_size: int,
    max_batches: int,
    sleep_ms: int,
) -> dict[str, int]:
    """Backfill the 6 zstd columns. Returns a per-column row count."""
    conn = await asyncpg.connect(dsn=dsn)
    counts: dict[str, int] = {new: 0 for _, new in _TARGETS}
    started = time.monotonic()
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
    elapsed = time.monotonic() - started
    logger.info(
        "Backfill complete in %.1fs. Totals: %s",
        elapsed,
        {k: v for k, v in counts.items() if v > 0},
    )
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


def _get_dsn(args: argparse.Namespace) -> str:
    """Resolve the Postgres DSN. Prefers ``--pg-url``, then ``DATABASE_URL``."""
    if args.pg_url:
        return args.pg_url
    import os

    dsn = os.environ.get("DATABASE_URL", "")
    if not dsn:
        logger.error("No DSN: pass --pg-url or set DATABASE_URL")
        sys.exit(2)
    return dsn


async def _amain(args: argparse.Namespace) -> int:
    dsn = _get_dsn(args)
    if args.report_only:
        pending = await report_pending(dsn, args.table)
        for col, n in pending.items():
            status = "OK" if n == 0 else "PENDING"
            logger.info("  %s: %d (%s)", col, n, status)
        total_pending = sum(pending.values())
        return 0 if total_pending == 0 else 1
    counts = await backfill(
        dsn=dsn,
        table=args.table,
        batch_size=args.batch_size,
        max_batches=args.max_batches,
        sleep_ms=args.sleep_ms,
    )
    return 0 if all(v > 0 or True for v in counts.values()) else 1


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Backfill zstd-compressed columns on the 6 extended fields."
    )
    parser.add_argument("--pg-url", default=None, help="Postgres DSN.")
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
        help="Maximum batches per column (default: 10000).",
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
        help="Print pending row counts and exit without backfilling.",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
    )
    return asyncio.run(_amain(args))


if __name__ == "__main__":
    sys.exit(main())
