"""Tighten the ClickHouse ``telemetry_events_ch`` TTL from 90d to 30d.

Phase B1 of the Eden app/storage plan (2026-06-19). Run once per
cluster after deploying the new ``clickhouse_sink.py``. The table
definition in code is updated for fresh clusters; this script
handles clusters that already have the table with the old 90d TTL.

Why a separate script and not an alembic migration
--------------------------------------------------
ClickHouse DDL (including TTL) lives outside Postgres alembic's
reach. The standard pattern is a one-shot SQL script (matches
``scripts/train_zstd_dict.py``).

Usage:
    uv run python scripts/clickhouse_tighten_ttl.py --dry-run
    uv run python scripts/clickhouse_tighten_ttl.py --no-dry-run
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from eden.config import get_settings
from eden.data_platform.clickhouse_sink import ClickHouseSink, ClickHouseConfig

logger = logging.getLogger(__name__)

# Hardcoded target TTL. Kept as a module constant so the script is
# grep-able; bump to ``INTERVAL 60 DAY`` etc. if the policy changes.
TARGET_TTL = "INTERVAL 30 DAY"


async def current_ttl(sink: ClickHouseSink, table: str) -> str | None:
    """Read the current TTL expression for ``telemetry_events_ch``."""
    row = await sink._execute(
        f"SELECT engine_full FROM system.tables "
        f"WHERE database = '{sink.config.database}' AND name = '{table}'"
    )
    if not row:
        return None
    engine_full = row[0][0] if isinstance(row[0], tuple) else row[0]
    # engine_full looks like ``MergeTree() PARTITION BY ... ORDER BY ... TTL ...``
    if "TTL" not in engine_full:
        return None
    # Extract the TTL substring from the engine definition
    after = engine_full.split("TTL", 1)[1].strip()
    return after


async def apply(sink: ClickHouseSink, table: str, dry_run: bool) -> None:
    """Run ``ALTER TABLE ... MODIFY TTL ...`` on the target table."""
    current = await current_ttl(sink, table)
    if current is None:
        logger.warning(f"[{table}] no TTL found; skipping")
        return
    if current.upper().startswith(TARGET_TTL.upper()):
        logger.info(f"[{table}] already at target TTL ({current}); no-op")
        return
    logger.info(f"[{table}] current TTL: {current}")
    logger.info(f"[{table}] target  TTL: TTL timestamp + {TARGET_TTL}")
    if dry_run:
        logger.info(f"[{table}] dry-run; not applying")
        return
    await sink._execute(
        f"ALTER TABLE {sink.config.database}.{table} "
        f"MODIFY TTL timestamp + {TARGET_TTL}"
    )
    logger.info(f"[{table}] TTL updated to {TARGET_TTL}")


def make_sink() -> ClickHouseSink:
    s = get_settings()
    return ClickHouseSink(
        ClickHouseConfig(
            url=s.clickhouse_url,
            database=s.clickhouse_database,
            user=s.clickhouse_user,
            password=s.clickhouse_password,
        )
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", default=True)
    parser.add_argument("--no-dry-run", dest="dry_run", action="store_false")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    sink = make_sink()
    asyncio.run(apply(sink, "telemetry_events_ch", dry_run=args.dry_run))
    return 0


if __name__ == "__main__":
    sys.exit(main())
