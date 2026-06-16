"""Train a zstd dictionary on a sample of Eden LLM payload data.

Run BEFORE first deploy of migration 032 to populate
``var/zstd_dict.bin``. Re-run quarterly (or whenever prompt templates
change materially — e.g. after a Cat 14 prompt-evolver training run).

Usage:
    uv run python scripts/train_zstd_dict.py \\
        --pg-url postgresql://eden:<pw>@<host>/eden \\
        --output var/zstd_dict.bin \\
        --samples 2000

If ``--pg-url`` is omitted, the script reads from ``.env`` via
``eden.config.get_settings()`` and connects to ``usage_events``-style
settings. Output is the raw zstd dictionary bytes; commit the file to
the repo (or ship via artifact storage) so the Dockerfile COPY line can
install it in the runtime image.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

import asyncpg

from eden.storage.compression import train_dictionary


# Default target column. ``request_body`` is the highest-volume column
# with the most template repetition; if you have time, train on a
# combined sample of request_body + response_body for a more general
# dict.
DEFAULT_COLUMN = "request_body"
DEFAULT_TABLE = "telemetry_events"


async def fetch_samples(
    dsn: str,
    table: str,
    column: str,
    n: int,
) -> list[bytes]:
    """Fetch up to ``n`` non-null values from ``table.column`` as bytes.

    Uses a server-side cursor via ``asyncpg`` so we don't materialise
    the full result set in memory.
    """
    conn = await asyncpg.connect(dsn=dsn)
    try:
        # Use ``quote_ident`` to handle table/column names safely; asyncpg
        # does not auto-quote in parameterised SQL. Cast to text so the
        # JSONB column comes back as a string we can re-encode.
        quoted_table = '"' + table.replace('"', '""') + '"'
        quoted_column = '"' + column.replace('"', '""') + '"'
        query = (
            f"SELECT {quoted_column}::text AS body "
            f"FROM {quoted_table} "
            f"WHERE {quoted_column} IS NOT NULL "
            f"ORDER BY random() LIMIT $1"
        )
        rows = await conn.fetch(query, n)
    finally:
        await conn.close()
    return [r["body"].encode("utf-8") for r in rows]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Train a zstd dictionary on a sample of LLM payloads."
    )
    parser.add_argument(
        "--pg-url",
        default=None,
        help="Postgres DSN. If omitted, uses the configured test DB.",
    )
    parser.add_argument(
        "--table",
        default=DEFAULT_TABLE,
        help=f"Table to sample from (default: {DEFAULT_TABLE}).",
    )
    parser.add_argument(
        "--column",
        default=DEFAULT_COLUMN,
        help=f"Column to sample (default: {DEFAULT_COLUMN}).",
    )
    parser.add_argument(
        "--samples",
        type=int,
        default=2000,
        help="Number of rows to sample (default: 2000).",
    )
    parser.add_argument(
        "--dict-size",
        type=int,
        default=8192,
        help="Dictionary size in bytes (default: 8192).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("var/zstd_dict.bin"),
        help="Output path for the trained dictionary (default: var/zstd_dict.bin).",
    )
    args = parser.parse_args()

    if args.pg_url is None:
        # Fall back to the configured test DB. We deliberately do NOT
        # use the production DB connection — operators should pass
        # --pg-url explicitly when training against prod.
        from eden.config import get_settings

        s = get_settings()
        args.pg_url = (
            f"postgresql://{s.postgres_user}:{s.postgres_password}"
            f"@{s.postgres_host}:{s.postgres_port}/{s.postgres_db}"
        )
        print(
            f"--pg-url not provided; using configured DB "
            f"{s.postgres_host}:{s.postgres_port}/{s.postgres_db}",
            file=sys.stderr,
        )

    if args.samples < 100:
        print(
            f"WARNING: training on only {args.samples} samples. "
            "LoPace 2026 recommends ≥ 1000 for production use.",
            file=sys.stderr,
        )

    print(
        f"Fetching up to {args.samples} samples from "
        f"{args.table}.{args.column}...",
        file=sys.stderr,
    )
    samples = asyncio.run(
        fetch_samples(args.pg_url, args.table, args.column, args.samples)
    )
    if len(samples) < 100:
        print(
            f"ERROR: only {len(samples)} samples found; need at least 100.",
            file=sys.stderr,
        )
        return 1

    print(
        f"Training dictionary on {len(samples)} samples "
        f"(target size: {args.dict_size} bytes)...",
        file=sys.stderr,
    )
    trained = train_dictionary(samples, dict_size=args.dict_size)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(trained)
    print(
        f"Wrote {len(trained)} bytes to {args.output}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
