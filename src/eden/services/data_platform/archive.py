"""Cold archive service (Phase B3).

:class:`ArchiveService` — moves ``telemetry_events`` rows older than
90 days from Postgres to Impossible Cloud and writes a small
``trace_archive_index`` row so the trace_id lookup stays O(1).

Workflow
--------
1. ``archive_old_rows(org_id, before_date)`` — finds traces whose
   last event is older than ``before_date``, writes each trace's
   rows as one NDJSON to Impossible Cloud, inserts the index row,
   then deletes the Postgres rows. One index row per trace, not
   per row — keeps the index small.

2. ``lookup(trace_id)`` — fast path for the reader; returns the
   ``archive_path`` if the trace is in cold storage, else None.

3. ``rehydrate(trace_id)`` — fetches the NDJSON from Impossible
   Cloud and returns the parsed rows. Read-through cache (in-process
   ``lru_cache``) absorbs hot lookups.

Why per-trace NDJSON
--------------------
A trace is the natural unit for the API (``/observability/trace/{tid}``
returns the full trace tree). Grouping all rows for a trace into
one S3 object means a single GET reconstructs the entire trace.
Grouping by ``event_id`` (one row per S3 object) would require N
GETs per trace view.

Impossible Cloud single-tier
-----------------------------
Unlike AWS S3, Impossible Cloud has one always-hot tier with no
Glacier restore delay. ``rehydrate`` is the same latency as
``storage.transition_to_warm``. The index lives in Postgres for
fast trace_id lookup; the body lives in Impossible Cloud for
storage cost (€7.99/TB/mo, zero egress).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any

from eden.config import get_settings

logger = logging.getLogger(__name__)


#: Default cold-archive age. Matches the user-decided 90d Postgres
#: hot window (Phase B3 / 2026-06-19).
DEFAULT_COLD_AGE_DAYS = 90


class ArchiveService:
    """Move old telemetry_events rows from Postgres to Impossible Cloud."""

    name = "cold_archive"

    async def archive_old_rows(
        self,
        org_id: str,
        before_date: datetime | None = None,
        *,
        batch_traces: int = 100,
        dry_run: bool = False,
    ) -> dict[str, int]:
        """Archive all traces whose last event is older than ``before_date``.

        Returns a summary ``{"traces_archived", "rows_archived", "s3_objects"}``.
        """
        from eden.storage.postgres import get_postgres_client

        if before_date is None:
            before_date = datetime.now(UTC).replace(
                hour=0, minute=0, second=0, microsecond=0
            )

        client = await get_postgres_client()
        if client is None:
            logger.warning("archive_old_rows: Postgres unavailable")
            return {"traces_archived": 0, "rows_archived": 0, "s3_objects": 0}

        # Find candidate trace_ids (group by, distinct).
        candidate_rows = await client.fetch(
            """
            SELECT trace_id, COUNT(*) AS n, MIN(timestamp) AS first_ts
              FROM telemetry_events
             WHERE org_id = $1 AND timestamp < $2
             GROUP BY trace_id
             ORDER BY MIN(timestamp) ASC
             LIMIT $3
            """,
            org_id,
            before_date,
            batch_traces,
        )

        if not candidate_rows:
            logger.info("[%s] no traces eligible for cold archive", org_id)
            return {"traces_archived": 0, "rows_archived": 0, "s3_objects": 0}

        traces_archived = 0
        rows_archived = 0
        s3_objects = 0
        for cand in candidate_rows:
            trace_id = cand["trace_id"]
            try:
                n = await self._archive_one_trace(
                    client,
                    org_id,
                    trace_id,
                    dry_run=dry_run,
                )
                if n > 0:
                    traces_archived += 1
                    rows_archived += n
                    s3_objects += 1
            except Exception as exc:
                logger.error(f"[{org_id}] archive failed for {trace_id}: {exc}")

        return {
            "traces_archived": traces_archived,
            "rows_archived": rows_archived,
            "s3_objects": s3_objects,
        }

    async def _archive_one_trace(
        self,
        client: Any,
        org_id: str,
        trace_id: str,
        *,
        dry_run: bool,
    ) -> int:
        """Archive a single trace. Returns row count (0 on dry-run)."""
        rows = await client.fetch(
            """
            SELECT * FROM telemetry_events
             WHERE org_id = $1 AND trace_id = $2
             ORDER BY timestamp ASC
            """,
            org_id,
            trace_id,
        )
        if not rows:
            return 0

        archive_path = (
            f"cold/telemetry_events/org={org_id}/trace={trace_id}/"
            f"{datetime.now(UTC).isoformat()}.ndjson"
        )

        if dry_run:
            logger.info(
                f"[{org_id}] dry-run: would archive {trace_id} "
                f"({len(rows)} rows) to {archive_path}"
            )
            return len(rows)

        # Serialise to NDJSON.
        body = "\n".join(json.dumps(dict(r), default=str) for r in rows)
        await self._write_impossible_cloud(archive_path, body)

        # Insert the index row + delete Postgres rows in one transaction.
        async with client.transaction():
            await client.execute(
                """
                INSERT INTO trace_archive_index
                  (trace_id, org_id, archive_path, row_count)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (trace_id) DO UPDATE
                  SET archive_path = EXCLUDED.archive_path,
                      row_count = EXCLUDED.row_count,
                      archived_at = NOW()
                """,
                trace_id,
                org_id,
                archive_path,
                len(rows),
            )
            await client.execute(
                "DELETE FROM telemetry_events "
                "WHERE org_id = $1 AND trace_id = $2",
                org_id,
                trace_id,
            )
        # Phase B4 (2026-06-19): also drop the trace's messages from
        # the content-addressed dedup table. The dedup is trace-scoped
        # (PK = (trace_id, msg_hash)) so a trace cleanup is a single
        # DELETE on the trace_id index. Outside the transaction
        # because a failure here is non-fatal — orphaned messages
        # are cleaned up by the daily GC sweep.
        try:
            from eden.observability.message_store import get_message_store
            await get_message_store().delete_trace(trace_id)
        except Exception as exc:
            logger.debug(f"archive dedup cleanup failed (non-fatal): {exc}")

        # Invalidate the read-through cache for this trace.
        _rehydrate_cache.cache_clear()
        logger.info(
            f"[{org_id}] archived trace_id={trace_id} ({len(rows)} rows) "
            f"to {archive_path}"
        )
        return len(rows)

    async def lookup(self, trace_id: str) -> dict[str, Any] | None:
        """Return the archive index row for ``trace_id``, or ``None``."""
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return None
        row = await client.fetchrow(
            """
            SELECT trace_id, org_id, archive_path, row_count, archived_at
              FROM trace_archive_index
             WHERE trace_id = $1
            """,
            trace_id,
        )
        if row is None:
            return None
        return dict(row)

    async def rehydrate(self, trace_id: str) -> list[dict[str, Any]]:
        """Fetch the NDJSON from Impossible Cloud and return parsed rows.

        Read-through cache: identical ``trace_id`` lookups within
        the process lifetime are served from an ``lru_cache``. The
        cache is invalidated whenever ``_archive_one_trace`` writes
        (so a re-archive reflects in subsequent reads).
        """
        cached = _rehydrate_cache(trace_id)
        if cached is not None:
            return cached

        meta = await self.lookup(trace_id)
        if meta is None:
            return []

        body = await self._read_impossible_cloud(meta["archive_path"])
        rows = [json.loads(line) for line in body.splitlines() if line.strip()]
        _rehydrate_cache(trace_id, rows)
        return rows

    async def _write_impossible_cloud(self, key: str, body: str) -> None:
        """Write ``body`` to Impossible Cloud. S3-compatible; boto3.

        Mirrors the StorageLifecycleManager writer. Kept inline
        rather than reusing it because the lifecycle writer
        expects a ``table`` name and generates its own key — this
        path needs an explicit key for the index row to round-trip.
        """
        s = get_settings()
        bucket = getattr(s, "bronze_s3_bucket", "")
        if not bucket:
            raise RuntimeError("bronze_s3_bucket not configured")

        try:
            import boto3

            endpoint = (
                os.environ.get("EDEN_STORAGE_ENDPOINT")
                if os.environ.get("EDEN_STORAGE_BACKEND", "").lower()
                == "impossible_cloud"
                else None
            )
            s3 = boto3.client("s3", endpoint_url=endpoint)
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                lambda: s3.put_object(
                    Bucket=bucket,
                    Key=key,
                    Body=body.encode("utf-8"),
                    ContentType="application/x-ndjson",
                ),
            )
        except Exception as exc:
            logger.error(f"archive write failed: {key}: {exc}")
            raise

    async def _read_impossible_cloud(self, key: str) -> str:
        """Read an object's body as text from Impossible Cloud."""
        s = get_settings()
        bucket = getattr(s, "bronze_s3_bucket", "")
        if not bucket:
            return ""
        try:
            import boto3

            endpoint = (
                os.environ.get("EDEN_STORAGE_ENDPOINT")
                if os.environ.get("EDEN_STORAGE_BACKEND", "").lower()
                == "impossible_cloud"
                else None
            )
            s3 = boto3.client("s3", endpoint_url=endpoint)
            loop = asyncio.get_event_loop()
            resp = await loop.run_in_executor(
                None, lambda: s3.get_object(Bucket=bucket, Key=key)
            )
            return resp["Body"].read().decode("utf-8")
        except Exception as exc:
            logger.error(f"archive read failed: {key}: {exc}")
            return ""


# ── Read-through cache ────────────────────────────────────────────────


@lru_cache(maxsize=256)
def _rehydrate_cache(trace_id: str) -> list[dict[str, Any]] | None:
    """Process-local cache for ``rehydrate``. Returns ``None`` until
    a trace is fetched; the wrapper in :meth:`ArchiveService.rehydrate`
    reads the cache and stores the result on first fetch.

    Cache key is the ``trace_id``; the value is the parsed rows list.
    """
    return None
