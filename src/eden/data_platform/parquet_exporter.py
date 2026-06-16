"""Parquet+zstd-7 cold-tier export to Backblaze B2.

The ``StorageLifecycleManager`` already moves data Postgres → S3 Standard
(day 7) → S3 IA (day 30) → S3 Glacier (day 90). This module adds a
*fourth* tier for high-volume observability data: Postgres → Parquet on
Backblaze B2 (day 90+). Parquet+zstd is typically 6-9× smaller than the
equivalent NDJSON on JSONB-heavy rows, and B2 at $6/TB-mo is
~4× cheaper than S3 Standard.

Why B2 over S3 Glacier Deep Archive
-----------------------------------
- $6/TB-mo vs $10/TB-mo + per-request retrieval fees.
- S3-compatible API; same boto3 client.
- Free egress via the Cloudflare bandwidth alliance (vs $90/TB egress on
  S3 Standard). The cold tier is read for analytics, not serving user
  traffic, so egress cost matters.
- Single-region replication not needed for telemetry that's already
  aggregated.

Why Parquet over the existing NDJSON
------------------------------------
- Per-column zstd compression (level 7 is the sweet spot — 9.39× on
  real OTel traces, 6.13× on logs per the Victoria Lakehouse 2025
  benchmark).
- Column pruning + predicate pushdown via DuckDB read path lets us
  scan only the columns we need.
- Schema evolution is awkward (column add/remove requires file
  rewrite), so we partition by year/month — old files are
  immutable in practice; new schema lands in new files.
"""
from __future__ import annotations

import asyncio
import io
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import pyarrow as pa
import pyarrow.parquet as pq

from eden.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


# Compression level for the Parquet+zstd codec. Level 7 is the
# sweet-spot (Victoria Lakehouse benchmark: 9.39× on traces at 250-335
# MB/s write, 53-74 MB/s read). Level 11 adds < 3% ratio for 4× the
# CPU; level 1 saves 50% CPU for ~10% ratio loss.
_PARQUET_COMPRESSION_LEVEL = 7

# Default batch size for streaming export. Larger batches are more
# efficient on the parquet write side; smaller batches reduce peak
# memory and let us checkpoint more often.
_DEFAULT_BATCH_ROWS = 100_000


@dataclass
class ParquetExportResult:
    """Outcome of a single Parquet cold-tier export run."""

    table: str
    rows_exported: int = 0
    files_written: int = 0
    bytes_uploaded: int = 0
    duration_ms: float = 0.0
    errors: list[str] = field(default_factory=list)


class ParquetColdExporter:
    """Exports a Postgres table to Parquet+zstd-7 on Backblaze B2.

    The exporter streams rows from the source table in batches, groups
    them into Parquet files partitioned by year/month, and uploads each
    file to ``$B2_COLD_BUCKET/cold/<table>/year=YYYY/month=MM/<uuid>.parquet``.

    Use ``export_table_window()`` for the standard "rows older than N
    days" archive operation. Use ``query_cold()`` to read back via
    DuckDB over the S3-compatible API.

    Public API
    ----------
    - ``export_table_window(table, before, dest_prefix) -> ParquetExportResult``
    - ``query_cold(table, start, end, sql_filter='1=1') -> list[dict]``

    The class is a no-op when the B2 env vars are unset, so it can be
    imported and instantiated freely in dev / CI.
    """

    def __init__(self) -> None:
        self._s3 = None

    def _get_s3(self):
        """Lazily construct the boto3 S3 client pointed at Backblaze B2."""
        if self._s3 is not None:
            return self._s3
        if not (
            settings.b2_endpoint_url
            and settings.b2_cold_bucket
            and settings.b2_access_key_id
            and settings.b2_secret_access_key
        ):
            logger.warning(
                "B2 cold tier not configured (b2_endpoint_url / b2_cold_bucket / "
                "b2_access_key_id / b2_secret_access_key); exports are no-ops"
            )
            return None
        import boto3

        self._s3 = boto3.client(
            "s3",
            endpoint_url=settings.b2_endpoint_url,
            aws_access_key_id=settings.b2_access_key_id,
            aws_secret_access_key=settings.b2_secret_access_key,
        )
        return self._s3

    async def export_table_window(
        self,
        table: str,
        before: datetime,
        dest_prefix: str | None = None,
        batch_rows: int = _DEFAULT_BATCH_ROWS,
        timestamp_column: str = "timestamp",
    ) -> ParquetExportResult:
        """Export all rows in ``table`` with ``timestamp_column < before``
        to Parquet+zstd-7 on B2, partitioned by year/month.

        Returns a ``ParquetExportResult`` with the row count, file
        count, and bytes uploaded. Source rows are NOT deleted from
        Postgres — that is the caller's responsibility (the cold tier
        is additive; the storage lifecycle manager decides when to
        detach the live partition).
        """
        result = ParquetExportResult(table=table)
        start = datetime.now(timezone.utc)

        s3 = self._get_s3()
        if s3 is None:
            result.errors.append("B2 not configured")
            return result

        dest_prefix = dest_prefix or f"cold/{table}"
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        cutoff_iso = before.isoformat()
        last_seen: Optional[datetime] = None
        try:
            while True:
                # Server-side cursor pagination. ``(timestamp, event_id)``
                # is the dedup key — equal timestamps are common on bulk
                # inserts, so we tie-break on event_id.
                if last_seen is None:
                    rows = await client.fetch(
                        f"""
                        SELECT * FROM {table}
                         WHERE {timestamp_column} < $1
                         ORDER BY {timestamp_column} ASC, event_id ASC
                         LIMIT $2
                        """,
                        cutoff_iso,
                        batch_rows,
                    )
                else:
                    rows = await client.fetch(
                        f"""
                        SELECT * FROM {table}
                         WHERE ({timestamp_column} < $1)
                            OR ({timestamp_column} = $2 AND event_id > $3)
                         ORDER BY {timestamp_column} ASC, event_id ASC
                         LIMIT $4
                        """,
                        cutoff_iso,
                        last_seen,
                        last_event_id,
                        batch_rows,
                    )
                if not rows:
                    break
                last_seen = rows[-1][timestamp_column]
                last_event_id = rows[-1].get("event_id")
                # Group the batch by (year, month) so each Parquet file
                # covers one partition. Within a batch, sort by
                # timestamp to maximise compression ratio.
                by_month: dict[tuple[int, int], list[dict]] = {}
                for r in rows:
                    ts = r[timestamp_column]
                    key = (ts.year, ts.month)
                    by_month.setdefault(key, []).append(dict(r))
                for (year, month), month_rows in by_month.items():
                    upload_ok, upload_bytes = await self._upload_parquet_partition(
                        s3, table, dest_prefix, year, month, month_rows
                    )
                    if upload_ok:
                        result.files_written += 1
                        result.bytes_uploaded += upload_bytes
                    else:
                        result.errors.append(
                            f"Failed to upload {table}/{year}/{month}"
                        )
                result.rows_exported += len(rows)
                logger.info(
                    "Exported %d rows from %s (total: %d, files: %d)",
                    len(rows),
                    table,
                    result.rows_exported,
                    result.files_written,
                )
                if len(rows) < batch_rows:
                    break
        except Exception as exc:  # noqa: BLE001
            logger.error("Parquet export failed for %s: %s", table, exc)
            result.errors.append(str(exc))

        result.duration_ms = (datetime.now(timezone.utc) - start).total_seconds() * 1000
        return result

    async def _upload_parquet_partition(
        self,
        s3: Any,
        table: str,
        dest_prefix: str,
        year: int,
        month: int,
        rows: list[dict],
    ) -> tuple[bool, int]:
        """Convert ``rows`` to a Parquet file and upload to B2.

        Returns ``(success, bytes_uploaded)``.
        """
        try:
            table_obj = pa.Table.from_pylist(rows)
            buf = io.BytesIO()
            pq.write_table(
                table_obj,
                buf,
                compression="zstd",
                compression_level=_PARQUET_COMPRESSION_LEVEL,
                use_dictionary=True,
                write_statistics=True,
            )
            data = buf.getvalue()
            key = (
                f"{dest_prefix}/year={year:04d}/month={month:02d}/"
                f"{datetime.now(timezone.utc).isoformat()}-{len(rows):08d}.parquet"
            )
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                lambda: s3.put_object(
                    Bucket=settings.b2_cold_bucket,
                    Key=key,
                    Body=data,
                    ContentType="application/vnd.apache.parquet",
                ),
            )
            return True, len(data)
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "Failed to write Parquet partition %s/%04d/%02d: %s",
                table,
                year,
                month,
                exc,
            )
            return False, 0

    async def query_cold(
        self,
        table: str,
        start: datetime,
        end: datetime,
        sql_filter: str = "1=1",
    ) -> list[dict[str, Any]]:
        """Query cold-tier Parquet files on B2 via DuckDB.

        Read-only. Returns the rows as a list of dicts. Useful for
        ad-hoc analytics over the full telemetry history.
        """
        if not self._get_s3():
            return []
        import duckdb

        prefix = (
            f"s3://{settings.b2_cold_bucket}/cold/{table}/"
            f"year={start.year:04d}/month={start.month:02d}/*.parquet"
        )
        con = duckdb.connect()
        try:
            con.execute("INSTALL httpfs; LOAD httpfs;")
            con.execute(f"SET s3_endpoint = '{settings.b2_endpoint_url}';")
            con.execute(f"SET s3_access_key_id = '{settings.b2_access_key_id}';")
            con.execute(
                f"SET s3_secret_access_key = '{settings.b2_secret_access_key}';"
            )
            result = con.execute(
                f"SELECT * FROM read_parquet('{prefix}') WHERE {sql_filter}"
            )
            return [dict(row) for row in result.fetchall()]
        finally:
            con.close()
