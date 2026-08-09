"""Data retention & GDPR compliance manager.

Automated purging of data across hot/warm/cold tiers. Supports:
- PII field redaction (30-day window)
- Bronze/Silver event archival (>90 days)
- GDPR right-to-be-forgotten (full tenant purge)
- Debug dump cleanup (>7 days)
- Error log cleanup (>90 days)
- Audit log preservation (7 years)

Usage:
    from eden.data_platform.retention import DataRetentionManager
    manager = DataRetentionManager()
    await manager.purge_pii_fields(before_date=datetime.now() - timedelta(days=30))
    await manager.delete_tenant_data(tenant_id="...")
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from eden.config import get_settings
from eden.data_platform.pii import PIIMasker

logger = logging.getLogger(__name__)
settings = get_settings()

# Chunk size for cold-archive SELECTs — never load an unbounded table.
ARCHIVE_CHUNK_SIZE = 1000


@dataclass
class RetentionPolicy:
    """Retention policy for a specific data type."""

    data_type: str
    hot_days: int
    warm_days: int
    cold_days: int
    delete_after_days: int
    scrub_pii_after_days: int | None = None


DEFAULT_POLICIES: list[RetentionPolicy] = [
    # warm_days=90 matches Team-tier Postgres hot window; cold archive
    # moves rows older than warm_days to object storage.
    # OPT-58: no ``derived_metrics`` entry — no table of that name exists
    # (real analogs live under different names and are not retention-managed here).
    RetentionPolicy("raw_traces", 7, 90, 2555, 90, scrub_pii_after_days=30),
    RetentionPolicy("user_feedback", 7, 90, 2555, 2555),
    # OPT-39: no ``training_datasets`` table — follow-up should add policies for
    # real tables: ``datasets``, ``dataset_items``, ``dataset_snapshots``, and/or
    # ``fine_tuning_runs`` / ``dataset_trace_lineage``.
    # OPT-29: ``audit_logs`` was a phantom name — real table is
    # ``agent_audit_ledger``. 7-year retention matches prior intent;
    # compliance/legal-hold enforcement dispatch is a follow-up (OPT-29).
    RetentionPolicy("agent_audit_ledger", 7, 90, 2555, 2555),
    # OPT-57: no ``error_logs`` table — phantom policy removed.
    RetentionPolicy("debug_dumps", 7, 0, 0, 7),
    RetentionPolicy("quarantine_events", 7, 30, 90, 90),
    RetentionPolicy("checkpoint_blobs", 7, 0, 0, 30),
    RetentionPolicy("trace_replay_sessions", 7, 0, 0, 30),
    RetentionPolicy("replay_sessions", 7, 0, 0, 30),
]

# data_type → hot table eligible for cold archival. Policies without an
# entry must not call archive_to_cold("silver_events") or they will wipe
# unrelated telemetry (e.g. debug_dumps with warm_days=0).
_ARCHIVE_TABLE_BY_TYPE: dict[str, str] = {
    "raw_traces": "silver_events",
}


@dataclass
class RetentionReport:
    """Report from a retention run."""

    pii_redacted_rows: int = 0
    archived_rows: int = 0
    deleted_rows: int = 0
    deleted_s3_objects: int = 0
    deleted_clickhouse_rows: int = 0
    errors: list[str] = field(default_factory=list)
    duration_ms: float = 0.0


class DataRetentionManager:
    """Manages data retention policies across all storage tiers."""

    def __init__(
        self,
        policies: list[RetentionPolicy] | None = None,
        dry_run: bool = False,
    ) -> None:
        self.policies = policies or DEFAULT_POLICIES
        self.dry_run = dry_run
        self._masker = PIIMasker()
        self._postgres_client: Any | None = None

    async def _get_postgres(self) -> Any:
        if self._postgres_client is None:
            from eden.storage.postgres import get_postgres_client
            self._postgres_client = await get_postgres_client()
        return self._postgres_client

    async def purge_pii_fields(self, before_date: datetime) -> int:
        """Redact PII from Silver traces older than the given date.

        Returns the number of rows redacted.
        """
        client = await self._get_postgres()
        # asyncpg timestamptz params must be datetime objects, not ISO strings.
        cutoff = before_date
        if self.dry_run:
            query = """
                SELECT COUNT(*) FROM silver_events
                WHERE timestamp < $1 AND pii_detected = TRUE
            """
            count = await client.fetchval(query, cutoff) or 0
            logger.info(f"[DRY RUN] Would redact PII from {count} silver_events rows")
            return count

        # Redact metadata JSONB fields for old traces
        query = """
            UPDATE silver_events
            SET metadata = $2::jsonb,
                pii_detected = FALSE
            WHERE timestamp < $1 AND pii_detected = TRUE
            RETURNING silver_event_id
        """
        redacted_meta = json.dumps({"_pii_redacted": True})
        rows = await client.fetch(query, cutoff, redacted_meta)
        count = len(rows)
        logger.info(f"Redacted PII from {count} silver_events rows before {before_date.isoformat()}")
        return count

    async def archive_to_cold(
        self,
        before_date: datetime,
        table: str = "silver_events",
        *,
        chunk_size: int = ARCHIVE_CHUNK_SIZE,
    ) -> tuple[int, int]:
        """Move warm PostgreSQL data to cold S3 storage and delete from hot.

        Uses keyset pagination (``timestamp``, ``silver_event_id``) with a
        hard ``LIMIT`` so archival never issues an unbounded ``SELECT *``.

        Hot rows are deleted only after a successful S3 write; a failed or
        skipped archive never drops data.

        Returns (rows_archived, s3_objects_created).
        """
        client = await self._get_postgres()
        limit = max(1, int(chunk_size))
        archived = 0
        s3_objects = 0
        last_ts: Any = None
        last_id: Any = None
        # asyncpg rejects ISO strings for timestamptz comparisons.
        cutoff = before_date

        while True:
            if last_ts is None:
                query = f"""
                    SELECT * FROM {table}
                    WHERE timestamp < $1
                    ORDER BY timestamp ASC, silver_event_id ASC
                    LIMIT $2
                """
                rows = await client.fetch(query, cutoff, limit)
            else:
                query = f"""
                    SELECT * FROM {table}
                    WHERE timestamp < $1
                      AND (timestamp, silver_event_id) > ($2::timestamptz, $3::uuid)
                    ORDER BY timestamp ASC, silver_event_id ASC
                    LIMIT $4
                """
                rows = await client.fetch(query, cutoff, last_ts, last_id, limit)

            if not rows:
                break

            if self.dry_run:
                archived += len(rows)
                logger.info(
                    f"[DRY RUN] Would archive chunk of {len(rows)} rows from {table}"
                )
            else:
                written = await self._write_s3_archive(rows, table)
                if written <= 0:
                    logger.error(
                        "S3 archive write produced 0 objects; "
                        f"skipping DELETE of {len(rows)} rows from {table}"
                    )
                    break
                s3_objects += written
                ids = [r["silver_event_id"] for r in rows]
                placeholders = ", ".join(f"${j + 2}" for j in range(len(ids)))
                del_query = f"""
                    DELETE FROM {table}
                    WHERE timestamp < $1 AND silver_event_id IN ({placeholders})
                """
                await client.execute(del_query, cutoff, *ids)
                archived += len(rows)

            last_row = rows[-1]
            last_ts = last_row["timestamp"]
            last_id = last_row["silver_event_id"]
            if len(rows) < limit:
                break

        if archived and not self.dry_run:
            logger.info(
                f"Archived {archived} rows from {table} to S3 cold storage, "
                f"created {s3_objects} objects"
            )
        return archived, s3_objects

    async def _write_s3_archive(self, rows: list[dict], table: str) -> int:
        """Write archived rows to S3, preferring Parquet+zstd (via
        pyarrow) and falling back to NDJSON when pyarrow is not
        installed or the batch fails to convert. Returns the number of
        S3 objects written (0 on any failure — the caller in
        :meth:`archive_to_cold` treats 0 as "verify write before
        DELETE" failed and skips the DELETE of the hot rows).
        """
        bucket = getattr(settings, "bronze_s3_bucket", "")
        if not bucket:
            logger.warning("S3 archiving skipped: bronze_s3_bucket not configured")
            return 0

        try:
            import boto3

            from eden.storage.cold_archive import serialize_rows

            s3 = boto3.client("s3")
            prefix = f"cold/{table}"
            ts = datetime.now(UTC)

            payload = await asyncio.to_thread(
                serialize_rows, [dict(r) for r in rows]
            )
            key = (
                f"{prefix}/year={ts.year}/month={ts.month:02d}/day={ts.day:02d}"
                f"/{ts.isoformat()}.{payload.file_extension}"
            )

            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                lambda: s3.put_object(
                    Bucket=bucket,
                    Key=key,
                    Body=payload.body,
                    ContentType=payload.content_type,
                    StorageClass="GLACIER_IR",
                ),
            )
            logger.info(
                f"S3 archive written: s3://{bucket}/{key} "
                f"({len(rows)} rows, {payload.format})"
            )
            return 1
        except Exception as exc:
            logger.error(f"S3 archive write failed: {exc}")
            return 0

    async def delete_tenant_data(self, tenant_id: str) -> RetentionReport:
        """Delete **all data for an entire tenant**. Not a per-user operation.

        Renamed from ``delete_user_data`` in the 2026-07 remediation. The old
        name caused ``rtbf_fanout._fanout_s3`` to call this with an ``org_id``
        while discarding the ``user_id`` it had been given, so a single user's
        right-to-be-forgotten request destroyed the whole organisation —
        including ``usage_events`` (billing) — and reported success.

        Deliberately **no backwards-compatible alias**: the old call site
        guarded on ``hasattr(mgr, "delete_user_data")``, so the rename is what
        makes that branch unreachable. Do not add one.

        Removes from:
        - bronze (usage_events)
        - silver (silver_events)
        - quarantine (quarantine_events)
        - ClickHouse (metrics)
        - S3 (cold archive markers)
        """
        report = RetentionReport()
        client = await self._get_postgres()

        tables = [
            ("usage_events", "org_id"),
            ("silver_events", "org_id"),
            ("quarantine_events", "org_id"),
            ("jobs", "org_id"),
            ("specs", "org_id"),
            # Wave 6 GDPR completeness — telemetry tables were previously
            # only swept by the periodic retention cron, not on explicit
            # user delete. Schema uses tenant_id (not org_id) on the
            # telemetry event / stream tables; archive index uses org_id.
            ("telemetry_events", "tenant_id"),
            ("trace_archive_index", "org_id"),
            ("telemetry_stream_chunks", "tenant_id"),
        ]

        for table, col in tables:
            try:
                if self.dry_run:
                    query = f"SELECT COUNT(*) FROM {table} WHERE {col} = $1"
                    count = await client.fetchval(query, tenant_id) or 0
                    logger.info(f"[DRY RUN] Would delete {count} rows from {table}")
                    report.deleted_rows += count
                else:
                    query = f"DELETE FROM {table} WHERE {col} = $1 RETURNING id"
                    # Use RETURNING COUNT equivalent
                    count_query = f"SELECT COUNT(*) FROM {table} WHERE {col} = $1"
                    before = await client.fetchval(count_query, tenant_id) or 0
                    await client.execute(f"DELETE FROM {table} WHERE {col} = $1", tenant_id)
                    report.deleted_rows += before
                    logger.info(f"Deleted {before} rows from {table} for tenant {tenant_id}")
            except Exception as exc:
                msg = f"Failed to delete from {table}: {exc}"
                logger.error(msg)
                report.errors.append(msg)

        # Delete from ClickHouse
        try:
            report.deleted_clickhouse_rows = await self._delete_from_clickhouse(tenant_id)
        except Exception as exc:
            msg = f"ClickHouse deletion failed: {exc}"
            logger.error(msg)
            report.errors.append(msg)

        # Mark for S3 deletion (actual deletion via lifecycle policy)
        try:
            report.deleted_s3_objects = await self._mark_s3_for_deletion(tenant_id)
        except Exception as exc:
            msg = f"S3 deletion marking failed: {exc}"
            logger.error(msg)
            report.errors.append(msg)

        logger.info(
            f"GDPR deletion for tenant {tenant_id}: "
            f"{report.deleted_rows} PG rows, "
            f"{report.deleted_clickhouse_rows} CH rows, "
            f"{report.deleted_s3_objects} S3 objects"
        )
        return report

    async def _delete_from_clickhouse(self, tenant_id: str) -> int:
        """Delete tenant data from ClickHouse / Tinybird analytics tables.

        Delegates to ``ClickHouseSink.delete_tenant_rows``:
        - Self-hosted: ``ALTER TABLE … DELETE`` on ``qualified_table`` names
        - Tinybird: ``POST /v0/datasources/{name}/delete`` Jobs API
          (same as ``tb datasource delete`` — not ``/v0/sql`` ALTER)
        """
        clickhouse_url = getattr(settings, "clickhouse_url", "")
        if not clickhouse_url:
            return 0

        try:
            from eden.data_platform.clickhouse_sink import get_clickhouse_sink

            sink = await get_clickhouse_sink()
            return await sink.delete_tenant_rows(tenant_id)
        except RuntimeError:
            raise
        except Exception as exc:
            logger.warning("ClickHouse GDPR delete failed: %s", exc)
            return 0

    async def _mark_s3_for_deletion(self, tenant_id: str) -> int:
        """Tag S3 objects for tenant deletion (lifecycle handles actual removal)."""
        bucket = getattr(settings, "bronze_s3_bucket", "")
        if not bucket:
            return 0
        try:
            import boto3
            s3 = boto3.client("s3")
            # Write a deletion marker object
            key = f"gdpr-deletion-requests/{tenant_id}/{datetime.now(UTC).isoformat()}.json"
            body = json.dumps({"tenant_id": tenant_id, "requested_at": datetime.now(UTC).isoformat()})
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                lambda: s3.put_object(Bucket=bucket, Key=key, Body=body),
            )
            return 1
        except Exception:
            return 0

    async def cleanup_debug_dumps(self, before_date: datetime) -> int:
        """Delete debug dump objects older than the given date.

        Debug dumps live under the ``debug/`` prefix of the bronze S3
        bucket — the same location the ``eden-debug-cleanup`` lifecycle
        rule and ``StorageLifecycleManager.expire_temporary_data`` cover
        (see :mod:`eden.data_platform.storage_lifecycle`). This purge
        honours the policy's cutoff instead of the lifecycle rule's
        fixed 7 days.

        Returns the number of S3 objects deleted (or, in dry-run, the
        number that would be deleted). Raises on S3 errors so
        :meth:`run_retention_policy` records the failure in the report.
        """
        bucket = getattr(settings, "bronze_s3_bucket", "")
        if not bucket:
            logger.warning("Debug dump cleanup skipped: bronze_s3_bucket not configured")
            return 0

        import boto3

        s3 = boto3.client("s3")
        loop = asyncio.get_event_loop()
        paginator = s3.get_paginator("list_objects_v2")
        pages = await loop.run_in_executor(
            None,
            lambda: list(paginator.paginate(Bucket=bucket, Prefix="debug/")),
        )
        to_delete: list[dict[str, str]] = [
            {"Key": obj["Key"]}
            for page in pages
            for obj in page.get("Contents", [])
            if obj["LastModified"].replace(tzinfo=UTC) < before_date
        ]

        if not to_delete:
            logger.info(f"No debug dumps older than {before_date.isoformat()} in s3://{bucket}/debug/")
            return 0

        if self.dry_run:
            logger.info(
                f"[DRY RUN] Would delete {len(to_delete)} debug dumps "
                f"before {before_date.isoformat()} from s3://{bucket}/debug/"
            )
            return len(to_delete)

        deleted = 0

        def _delete_chunk(objs: list[dict[str, str]]) -> Any:
            return s3.delete_objects(
                Bucket=bucket,
                Delete={"Objects": objs},
            )

        # delete_objects accepts at most 1000 keys per request.
        for i in range(0, len(to_delete), 1000):
            chunk = to_delete[i : i + 1000]
            await loop.run_in_executor(
                None, functools.partial(_delete_chunk, chunk)
            )
            deleted += len(chunk)
        logger.info(
            f"Deleted {deleted} debug dumps from s3://{bucket}/debug/ "
            f"before {before_date.isoformat()}"
        )
        return deleted

    async def cleanup_quarantine_events(self, before_date: datetime) -> int:
        """Delete ``quarantine_events`` rows older than the given date.

        This is a backstop delete, independent of ``resolution`` status.
        :meth:`eden.data_platform.silver_etl.reprocess_quarantine` already
        deletes a row immediately after it is *successfully* reprocessed,
        but rows that are unparseable or never reprocessed (``resolution``
        left as ``pending``, ``discarded``, or ``false_positive``) would
        otherwise accumulate forever with no retention enforcement. This
        method deletes purely on age, regardless of ``resolution``.

        Returns the number of rows deleted (or, in dry-run, the number
        that would be deleted).
        """
        client = await self._get_postgres()

        if self.dry_run:
            count = await client.fetchval(
                "SELECT COUNT(*) FROM quarantine_events WHERE quarantined_at < $1",
                before_date,
            )
            logger.info(
                f"[DRY RUN] Would delete {count or 0} quarantine_events rows "
                f"before {before_date.isoformat()}"
            )
            return int(count or 0)

        result = await client.execute(
            "DELETE FROM quarantine_events WHERE quarantined_at < $1",
            before_date,
        )
        # asyncpg returns status string like "DELETE 42"
        try:
            deleted = int(str(result).split()[-1])
        except (ValueError, IndexError):
            deleted = 0
        logger.info(
            f"Deleted {deleted} quarantine_events rows before {before_date.isoformat()}"
        )
        return deleted

    async def cleanup_user_feedback(self, before_date: datetime) -> int:
        """Delete ``user_feedback`` rows older than the given date.

        Returns the number of rows deleted (or, in dry-run, the number
        that would be deleted).
        """
        client = await self._get_postgres()

        if self.dry_run:
            count = await client.fetchval(
                "SELECT COUNT(*) FROM user_feedback WHERE created_at < $1",
                before_date,
            )
            logger.info(
                f"[DRY RUN] Would delete {count or 0} user_feedback rows "
                f"before {before_date.isoformat()}"
            )
            return int(count or 0)

        result = await client.execute(
            "DELETE FROM user_feedback WHERE created_at < $1",
            before_date,
        )
        # asyncpg returns status string like "DELETE 42"
        try:
            deleted = int(str(result).split()[-1])
        except (ValueError, IndexError):
            deleted = 0
        logger.info(
            f"Deleted {deleted} user_feedback rows before {before_date.isoformat()}"
        )
        return deleted

    async def cleanup_checkpoint_blobs(self, before_date: datetime) -> int:
        """Delete ``checkpoint_blobs`` rows older than the given date.

        Returns the number of rows deleted (or, in dry-run, the number
        that would be deleted).
        """
        client = await self._get_postgres()

        if self.dry_run:
            count = await client.fetchval(
                "SELECT COUNT(*) FROM checkpoint_blobs WHERE created_at < $1",
                before_date,
            )
            logger.info(
                f"[DRY RUN] Would delete {count or 0} checkpoint_blobs rows "
                f"before {before_date.isoformat()}"
            )
            return int(count or 0)

        result = await client.execute(
            "DELETE FROM checkpoint_blobs WHERE created_at < $1",
            before_date,
        )
        # asyncpg returns status string like "DELETE 42"
        try:
            deleted = int(str(result).split()[-1])
        except (ValueError, IndexError):
            deleted = 0
        logger.info(
            f"Deleted {deleted} checkpoint_blobs rows before {before_date.isoformat()}"
        )
        return deleted

    async def cleanup_trace_replay_sessions(self, before_date: datetime) -> int:
        """Delete ``trace_replay_sessions`` rows older than the given date.

        Returns the number of rows deleted (or, in dry-run, the number
        that would be deleted).
        """
        client = await self._get_postgres()

        if self.dry_run:
            count = await client.fetchval(
                "SELECT COUNT(*) FROM trace_replay_sessions WHERE updated_at < $1",
                before_date,
            )
            logger.info(
                f"[DRY RUN] Would delete {count or 0} trace_replay_sessions rows "
                f"before {before_date.isoformat()}"
            )
            return int(count or 0)

        result = await client.execute(
            "DELETE FROM trace_replay_sessions WHERE updated_at < $1",
            before_date,
        )
        try:
            deleted = int(str(result).split()[-1])
        except (ValueError, IndexError):
            deleted = 0
        logger.info(
            f"Deleted {deleted} trace_replay_sessions rows before {before_date.isoformat()}"
        )
        return deleted

    async def cleanup_replay_sessions(self, before_date: datetime) -> int:
        """Delete ``replay_sessions`` rows older than the given date.

        Returns the number of rows deleted (or, in dry-run, the number
        that would be deleted).
        """
        client = await self._get_postgres()

        if self.dry_run:
            count = await client.fetchval(
                "SELECT COUNT(*) FROM replay_sessions WHERE created_at < $1",
                before_date,
            )
            logger.info(
                f"[DRY RUN] Would delete {count or 0} replay_sessions rows "
                f"before {before_date.isoformat()}"
            )
            return int(count or 0)

        result = await client.execute(
            "DELETE FROM replay_sessions WHERE created_at < $1",
            before_date,
        )
        try:
            deleted = int(str(result).split()[-1])
        except (ValueError, IndexError):
            deleted = 0
        logger.info(
            f"Deleted {deleted} replay_sessions rows before {before_date.isoformat()}"
        )
        return deleted

    async def run_retention_policy(self, policy: RetentionPolicy) -> RetentionReport:
        """Run a single retention policy end-to-end."""
        report = RetentionReport()
        now = datetime.now(UTC)

        # PII scrubbing (only meaningful for trace/silver policies)
        if (
            policy.scrub_pii_after_days is not None
            and policy.data_type in _ARCHIVE_TABLE_BY_TYPE
        ):
            pii_before = now - timedelta(days=policy.scrub_pii_after_days)
            try:
                report.pii_redacted_rows = await self.purge_pii_fields(pii_before)
            except Exception as exc:
                report.errors.append(f"PII purge failed: {exc}")

        # Archival to cold — only for policies that own a hot table, and
        # never when warm_days <= 0 (would archive "everything older than now").
        archive_table = _ARCHIVE_TABLE_BY_TYPE.get(policy.data_type)
        if archive_table is not None and policy.warm_days > 0:
            archive_before = now - timedelta(days=policy.warm_days)
            try:
                archived, _ = await self.archive_to_cold(
                    archive_before, table=archive_table
                )
                report.archived_rows = archived
            except Exception as exc:
                report.errors.append(f"Archival failed: {exc}")
        elif policy.data_type == "debug_dumps":
            try:
                dump_before = now - timedelta(days=max(policy.delete_after_days, 1))
                report.deleted_rows = await self.cleanup_debug_dumps(dump_before)
            except Exception as exc:
                report.errors.append(f"Debug dump cleanup failed: {exc}")
        elif policy.data_type == "quarantine_events":
            try:
                quarantine_before = now - timedelta(days=max(policy.delete_after_days, 1))
                report.deleted_rows = await self.cleanup_quarantine_events(quarantine_before)
            except Exception as exc:
                report.errors.append(f"Quarantine cleanup failed: {exc}")
        elif policy.data_type == "user_feedback":
            try:
                feedback_before = now - timedelta(days=max(policy.delete_after_days, 1))
                report.deleted_rows = await self.cleanup_user_feedback(feedback_before)
            except Exception as exc:
                report.errors.append(f"User feedback cleanup failed: {exc}")
        elif policy.data_type == "checkpoint_blobs":
            try:
                blobs_before = now - timedelta(days=max(policy.delete_after_days, 1))
                report.deleted_rows = await self.cleanup_checkpoint_blobs(blobs_before)
            except Exception as exc:
                report.errors.append(f"Checkpoint blobs cleanup failed: {exc}")
        elif policy.data_type == "trace_replay_sessions":
            try:
                replay_before = now - timedelta(days=max(policy.delete_after_days, 1))
                report.deleted_rows = await self.cleanup_trace_replay_sessions(
                    replay_before
                )
            except Exception as exc:
                report.errors.append(f"Trace replay sessions cleanup failed: {exc}")
        elif policy.data_type == "replay_sessions":
            try:
                sessions_before = now - timedelta(days=max(policy.delete_after_days, 1))
                report.deleted_rows = await self.cleanup_replay_sessions(sessions_before)
            except Exception as exc:
                report.errors.append(f"Replay sessions cleanup failed: {exc}")

        # Deletion — purge rows already in cold archive past retention.
        delete_before = now - timedelta(days=policy.delete_after_days)
        try:
            if policy.data_type == "raw_traces":
                report.deleted_rows = await self.purge_archived_telemetry(
                    delete_before,
                )
            elif policy.delete_after_days <= policy.warm_days:
                logger.info(
                    f"Skipping deletion for {policy.data_type} — handled by archival"
                )
        except Exception as exc:
            report.errors.append(f"Deletion failed: {exc}")

        return report

    async def purge_archived_telemetry(
        self,
        before_date: datetime,
        org_id: str | None = None,
    ) -> int:
        """Delete hot ``telemetry_events`` rows older than ``before_date``
        that already have a ``trace_archive_index`` entry.

        When ``org_id`` is given the purge is scoped to that tenant only,
        so per-org warm windows are honoured and cross-org deletions with
        mismatched cutoffs cannot occur.
        """
        client = await self._get_postgres()
        if org_id is not None:
            org_filter = "AND te.tenant_id = $2"
            params_count = [before_date, org_id]
            params_dry = [before_date, org_id]
        else:
            org_filter = ""
            params_count = [before_date]
            params_dry = [before_date]

        if self.dry_run:
            count = await client.fetchval(
                f"""
                SELECT COUNT(*) FROM telemetry_events te
                 WHERE te.timestamp < $1
                   {org_filter}
                   AND EXISTS (
                     SELECT 1 FROM trace_archive_index tai
                      WHERE tai.trace_id = te.trace_id
                        AND tai.org_id = te.tenant_id
                   )
                """,
                *params_dry,
            )
            logger.info(
                f"[DRY RUN] Would purge {count or 0} archived telemetry_events "
                f"rows before {before_date.isoformat()}"
                + (f" for org {org_id}" if org_id else "")
            )
            return int(count or 0)

        result = await client.execute(
            f"""
            DELETE FROM telemetry_events te
             WHERE te.timestamp < $1
               {org_filter}
               AND EXISTS (
                 SELECT 1 FROM trace_archive_index tai
                  WHERE tai.trace_id = te.trace_id
                    AND tai.org_id = te.tenant_id
               )
            """,
            *params_count,
        )
        # asyncpg returns status string like "DELETE 42"
        try:
            return int(str(result).split()[-1])
        except (ValueError, IndexError):
            return 0

    async def load_org_warm_days(self) -> dict[str, int]:
        """Load per-tenant warm-window overrides from ``org_retention_policies``."""
        client = await self._get_postgres()
        rows = await client.fetch(
            """
            SELECT DISTINCT ON (tenant_id) tenant_id, warm_days
              FROM org_retention_policies
             WHERE table_name IN ('telemetry_events', 'raw_traces')
               AND (effective_until IS NULL OR effective_until > NOW())
             ORDER BY tenant_id, effective_from DESC
            """
        )
        return {r["tenant_id"]: int(r["warm_days"]) for r in rows}

    async def run_all_policies(self) -> dict[str, RetentionReport]:
        """Run all configured retention policies and return per-policy reports."""
        reports: dict[str, RetentionReport] = {}
        for policy in self.policies:
            try:
                reports[policy.data_type] = await self.run_retention_policy(policy)
            except Exception as exc:
                logger.error(f"Retention policy failed for {policy.data_type}: {exc}")
                reports[policy.data_type] = RetentionReport(errors=[str(exc)])
        return reports

    async def export_user_data(self, tenant_id: str) -> dict[str, Any]:
        """GDPR data portability: export all user data as a structured dict.

        Returns a dict ready for JSON serialization, containing all data
        associated with the tenant.
        """
        client = await self._get_postgres()
        export: dict[str, Any] = {
            "tenant_id": tenant_id,
            "exported_at": datetime.now(UTC).isoformat(),
            "tables": {},
        }

        tables = ["usage_events", "silver_events", "jobs", "specs", "invoices"]
        for table in tables:
            try:
                rows = await client.fetch(
                    f"SELECT * FROM {table} WHERE org_id = $1", tenant_id
                )
                export["tables"][table] = [dict(r) for r in rows]
            except Exception as exc:
                export["tables"][table] = {"error": str(exc)}

        return export
