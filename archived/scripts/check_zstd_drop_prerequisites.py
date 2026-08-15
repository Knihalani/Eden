"""Verify all four prerequisites for migration 033 (drop original JSONB payload columns).

Phase B1 of the Eden app/storage plan (2026-06-19). Run BEFORE
``scripts/drop_original_payload_columns.sql`` so the operator can
confirm the migration is safe to apply.

Prerequisites (from migration 033 docstring):
  (a) Every writer populates request_body_zstd / response_body_zstd
      (verify: grep TelemetryCollector._build_postgres_row /
      _prepare_postgres_row for compress_jsonb / compress_many wiring)
  (b) Every reader of request_body / response_body reads *_zstd first
      — the canonical reader (telemetry_collector.get_trace_tree) plus
      every known secondary reader in ``_SECONDARY_READERS`` below
      (rules_engine, patterns_clusterer, ...). Extend that tuple
      whenever a new raw SQL reader of these columns ships.
  (c) ≥ 30 days of production traffic on the new path
  (d) Zero open support tickets that reference the old columns
      (manual — cannot check programmatically)
  (e) Informational only, not a gate on the exit code: current value
      of ``telemetry_plaintext_jsonb_write_enabled``. This flag is a
      separate, reversible step (Phase 4 storage) that should flip to
      False — stopping *new* plaintext writes while the columns still
      exist — before the irreversible column DROP below is attempted.

Output: prints each gate's status, exits 0 only if all (a)-(c) pass.
(d) is reported as a manual check. (e) is reported for visibility.

Usage:
    uv run python scripts/check_zstd_drop_prerequisites.py
"""
from __future__ import annotations

import asyncio
import logging
import subprocess
import sys
from datetime import UTC, datetime

import asyncpg

from eden.config import get_settings

logger = logging.getLogger(__name__)


async def check_writer_wired() -> bool:
    """(a) The compression service is wired into TelemetryCollector.

    Greps ``src/eden/observability/telemetry_collector.py`` for either
    ``compress_jsonb`` (direct) or ``compress_many`` (the batched
    dispatcher added in the v1.8 storage-optimisation pass — it fans
    out to the same ``compress_jsonb`` under the hood, see
    ``eden.storage.compression``) referenced in the row-build path.
    """
    target = "src/eden/observability/telemetry_collector.py"
    try:
        result = subprocess.run(
            ["grep", "-E", "compress_jsonb|compress_many", target],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        logger.warning("[a] grep not available; skipping")
        return False

    hits = [line for line in result.stdout.splitlines() if line.strip()]
    if not hits:
        logger.error(
            "[a] FAIL: neither compress_jsonb nor compress_many referenced "
            "in telemetry_collector.py"
        )
        return False
    logger.info(
        f"[a] OK: compress_jsonb/compress_many referenced {len(hits)} "
        "time(s) in telemetry_collector.py"
    )
    return True


#: Known non-canonical readers of ``telemetry_events.request_body`` /
#: ``response_body`` that must prefer the ``*_zstd`` column before
#: falling back to plaintext. ``get_trace_tree`` in telemetry_collector
#: is the canonical reader and is checked separately below; this list
#: is the set of *other* readers Phase 4 storage migrated. Extend this
#: list whenever a new raw SQL reader of these columns is added —
#: ``grep -rn "SELECT.*request_body" src/`` finds candidates.
_SECONDARY_READERS: tuple[str, ...] = (
    "src/eden/evaluation/online/rules_engine.py",
    "src/eden/observability/patterns_clusterer.py",
)


def _grep(pattern: str, target: str) -> list[str]:
    try:
        result = subprocess.run(
            ["grep", "-E", pattern, target],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return []
    return [line for line in result.stdout.splitlines() if line.strip()]


async def check_reader_wired() -> bool:
    """(b) Every known reader checks ``*_zstd`` first.

    Two parts:
      1. The canonical reader (``telemetry_collector.get_trace_tree``,
         via its ``_resolve_request_for`` / ``_resolve_response_for``
         helpers) decodes ``*_zstd`` and only falls back to the
         plaintext column when the zstd value is absent.
      2. Every file in ``_SECONDARY_READERS`` that selects
         ``request_body``/``response_body`` also selects and decodes
         the matching ``*_zstd`` column.

    A bare ``request_body`` read with no ``*_zstd`` fallback anywhere
    in this set is a failure — it would go blind the moment
    ``telemetry_plaintext_jsonb_write_enabled`` flips to False.
    """
    canonical = "src/eden/observability/telemetry_collector.py"
    has_resolver = bool(_grep("_resolve_request_for|_resolve_response_for", canonical))
    has_zstd_cols = bool(_grep("request_body_zstd", canonical)) and bool(
        _grep("response_body_zstd", canonical)
    )
    if not (has_resolver and has_zstd_cols):
        logger.error(
            f"[b] FAIL: canonical reader missing resolver={has_resolver} "
            f"or zstd columns={has_zstd_cols} in {canonical}"
        )
        return False
    logger.info(f"[b] OK: canonical reader ({canonical}) uses *_zstd fallback")

    all_ok = True
    for target in _SECONDARY_READERS:
        selects_body = bool(_grep(r"request_body|response_body", target))
        if not selects_body:
            logger.info(f"[b] OK: {target} does not read request_body/response_body")
            continue
        selects_zstd = bool(_grep(r"request_body_zstd|response_body_zstd", target))
        if not selects_zstd:
            logger.error(
                f"[b] FAIL: {target} reads request_body/response_body "
                "without a *_zstd fallback"
            )
            all_ok = False
        else:
            logger.info(f"[b] OK: {target} uses *_zstd fallback")
    return all_ok


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


def check_plaintext_write_flag() -> bool:
    """(e) Informational: current state of the dual-write kill switch.

    ``telemetry_plaintext_jsonb_write_enabled`` (default True) is the
    softer, reversible step that should flip to False *before* the
    (destructive, irreversible) column drop is ever attempted — it
    stops new plaintext writes while the columns still exist, so any
    reader gap surfaces as a bug (empty field) rather than data loss.
    Not a hard gate on this script's exit code: the column drop only
    needs (a)-(d); this is reported for operator visibility.
    """
    try:
        from eden.config import get_settings

        flag = bool(get_settings().telemetry_plaintext_jsonb_write_enabled)
    except Exception as exc:
        logger.warning(f"[e] could not read telemetry_plaintext_jsonb_write_enabled: {exc}")
        return True  # default value; do not block on an import failure
    if flag:
        logger.info(
            "[e] INFO: telemetry_plaintext_jsonb_write_enabled=True — still "
            "dual-writing plaintext JSONB. Safe to flip False once (a)+(b) "
            "PASS and the flip has burned in on staging."
        )
    else:
        logger.info(
            "[e] INFO: telemetry_plaintext_jsonb_write_enabled=False — "
            "plaintext JSONB writes already stopped; *_zstd is the only "
            "write path for the five gated blob columns."
        )
    return flag


async def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logger.info("Migration 033 prerequisite check (drop original JSONB payload columns)")
    logger.info("=" * 70)

    a = await check_writer_wired()
    b = await check_reader_wired()
    c, pending, days = await check_postgres_backfill_complete()
    e = check_plaintext_write_flag()

    logger.info("")
    logger.info("(a) Writer wired to compress_jsonb/compress_many .. %s", "PASS" if a else "FAIL")
    logger.info("(b) Readers use *_zstd fallback ................... %s", "PASS" if b else "FAIL")
    logger.info("(c) Postgres backfill complete ..................... %s", "PASS" if c else "FAIL")
    logger.info(
        "    pending rows: %s | days since new path: %s",
        pending,
        days,
    )
    logger.info("(d) Zero open support tickets ...................... MANUAL — confirm in your tracker")
    logger.info(
        "(e) Plaintext dual-write still on ................... %s",
        "YES (safe default)" if e else "NO (already off)",
    )
    logger.info("")

    if a and b and c:
        logger.info("All automated gates PASS. After manual (d) confirmation:")
        logger.info("  1. Flip telemetry_plaintext_jsonb_write_enabled=False, burn in, THEN:")
        logger.info("  psql $DATABASE_URL -f scripts/drop_original_payload_columns.sql")
        logger.info("  # then VACUUM FULL telemetry_events during a quiet window")
        return 0
    logger.error("One or more gates FAILED. Do NOT run the drop yet.")
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
