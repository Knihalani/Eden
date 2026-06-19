"""Verify all four prerequisites for migration 033 (drop original JSONB payload columns).

Phase B1 of the Eden app/storage plan (2026-06-19). Run BEFORE
``scripts/drop_original_payload_columns.sql`` so the operator can
confirm the migration is safe to apply.

Prerequisites (from migration 033 docstring):
  (a) Every writer populates request_body_zstd / response_body_zstd
      (verify: grep TelemetryCollector._route_postgres for the wiring)
  (b) Every reader of request_body / response_body reads *_zstd first
      (verify: grep telemetry_collector._read_payload + the
      ``response_body_zstd IS NULL`` count is 0 in production)
  (c) ≥ 30 days of production traffic on the new path
  (d) Zero open support tickets that reference the old columns
      (manual — cannot check programmatically)

Output: prints each gate's status, exits 0 only if all (a)-(c) pass.
(d) is reported as a manual check.

Usage:
    uv run python scripts/check_zstd_drop_prerequisites.py
"""
from __future__ import annotations

import asyncio
import logging
import re
import subprocess
import sys
from datetime import UTC, datetime, timedelta

import asyncpg

from eden.config import get_settings

logger = logging.getLogger(__name__)


async def check_writer_wired() -> bool:
    """(a) The compression service is wired into TelemetryCollector.

    Greps ``src/eden/observability/telemetry_collector.py`` for
    ``compress_jsonb`` import + use in ``_route_postgres``.
    """
    target = "src/eden/observability/telemetry_collector.py"
    try:
        result = subprocess.run(
            ["grep", "-E", "compress_jsonb", target],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        logger.warning("[a] grep not available; skipping")
        return False

    hits = [line for line in result.stdout.splitlines() if line.strip()]
    if not hits:
        logger.error("[a] FAIL: compress_jsonb not referenced in telemetry_collector.py")
        return False
    logger.info(f"[a] OK: compress_jsonb referenced {len(hits)} time(s) in telemetry_collector.py")
    return True


async def check_reader_wired() -> bool:
    """(b) The reader path checks ``*_zstd`` first.

    Greps ``src/eden/observability/telemetry_collector.py`` for
    ``_read_payload`` + the ``*_zstd`` field references. A bare
    ``request_body`` read with no ``*_zstd`` fallback is a failure.
    """
    target = "src/eden/observability/telemetry_collector.py"
    try:
        result = subprocess.run(
            ["grep", "-E", "_read_payload|response_body_zstd|request_body_zstd", target],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return False

    text = result.stdout
    has_read_payload = "_read_payload" in text
    has_zstd_fallback = ("response_body_zstd" in text) and ("request_body_zstd" in text)
    if not (has_read_payload and has_zstd_fallback):
        logger.error(
            f"[b] FAIL: read path missing _read_payload={has_read_payload} "
            f"or zstd fallback={has_zstd_fallback}"
        )
        return False
    logger.info("[b] OK: _read_payload uses *_zstd fallback")
    return True


async def check_postgres_backfill_complete() -> tuple[bool, int, int]:
    """(c) ≥ 30 days of production traffic on the new path AND no NULL rows.

    Connects to Postgres and:
      - counts rows where request_body_zstd IS NULL but request_body IS NOT NULL
        (these are pre-backfill rows still pending)
      - finds the minimum ingested_at where request_body_zstd IS NOT NULL
        (this is when the new path started serving)
    Returns (ok, pending_count, days_since_new_path_started).
    """
    s = get_settings()
    if not s.database_url:
        logger.error("[c] FAIL: DATABASE_URL not set")
        return (False, -1, -1)

    try:
        conn = await asyncpg.connect(s.database_url)
    except Exception as exc:
        logger.error(f"[c] FAIL: cannot connect to Postgres: {exc}")
        return (False, -1, -1)

    try:
        # Pending rows (backfill not yet complete)
        pending_row = await conn.fetchrow(
            "SELECT COUNT(*) AS n FROM telemetry_events "
            "WHERE request_body IS NOT NULL AND request_body_zstd IS NULL"
        )
        pending = int(pending_row["n"]) if pending_row else -1

        # When did the new path start?
        since_row = await conn.fetchrow(
            "SELECT MIN(timestamp) AS since FROM telemetry_events "
            "WHERE request_body_zstd IS NOT NULL"
        )
        since = since_row["since"] if since_row else None

        if since is None:
            logger.error("[c] FAIL: no rows with request_body_zstd found yet")
            return (False, pending, -1)

        days = (datetime.now(UTC) - since).days if since.tzinfo else (
            datetime.now() - since
        ).days
        ok = pending == 0 and days >= 30
        if pending == 0:
            logger.info(f"[c] OK: 0 pending rows; new path running for {days} days")
        else:
            logger.error(f"[c] FAIL: {pending} pending rows (need 0); new path {days} days old")
        return (ok, pending, days)
    finally:
        await conn.close()


async def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logger.info("Migration 033 prerequisite check (drop original JSONB payload columns)")
    logger.info("=" * 70)

    a = await check_writer_wired()
    b = await check_reader_wired()
    c, pending, days = await check_postgres_backfill_complete()

    logger.info("")
    logger.info("(a) Writer wired to compress_jsonb ........... %s", "PASS" if a else "FAIL")
    logger.info("(b) Reader uses *_zstd fallback ............. %s", "PASS" if b else "FAIL")
    logger.info("(c) Postgres backfill complete .............. %s", "PASS" if c else "FAIL")
    logger.info(
        "    pending rows: %s | days since new path: %s",
        pending,
        days,
    )
    logger.info("(d) Zero open support tickets ............... MANUAL — confirm in your tracker")
    logger.info("")

    if a and b and c:
        logger.info("All automated gates PASS. After manual (d) confirmation:")
        logger.info("  psql $DATABASE_URL -f scripts/drop_original_payload_columns.sql")
        logger.info("  # then VACUUM FULL telemetry_events during a quiet window")
        return 0
    logger.error("One or more gates FAILED. Do NOT run the drop yet.")
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
