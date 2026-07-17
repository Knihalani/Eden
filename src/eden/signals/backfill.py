"""F06 — historical signal backfill (absorbed F08).

Rate-limited re-investigation of finalized traces when a signal is
created or re-enabled.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT_WINDOW_DAYS = 7
_MAX_TRACES_PER_MINUTE = 100
_COST_PER_TRACE_USD = 0.01


def estimate_backfill_cost(trace_count: int) -> float:
    return round(max(0, trace_count) * _COST_PER_TRACE_USD, 4)


async def count_traces_in_window(org_id: str, *, window_days: int) -> int:
    try:
        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()
    except Exception:
        return 0
    if pg is None:
        return 0
    try:
        row = await pg.fetchrow(
            """
            SELECT COUNT(DISTINCT trace_id) AS n
            FROM telemetry_events
            WHERE tenant_id = $1
              AND timestamp >= NOW() - ($2 || ' days')::interval
            """,
            org_id,
            str(window_days),
        )
    except Exception as exc:
        logger.debug("signal_backfill: count traces failed: %s", exc)
        return 0
    if row is None:
        return 0
    try:
        return int(row.get("n") if hasattr(row, "get") else row["n"] or 0)
    except (TypeError, ValueError):
        return 0


async def enqueue_backfill(
    org_id: str,
    signal_id: str,
    *,
    window_days: int = _DEFAULT_WINDOW_DAYS,
) -> dict[str, Any]:
    """Create a backfill job for ``signal_id`` over the last ``window_days``."""
    window_days = max(1, min(30, window_days))
    window_end = datetime.now(UTC)
    window_start = window_end - timedelta(days=window_days)
    traces_total = await count_traces_in_window(org_id, window_days=window_days)
    job_id = str(uuid.uuid4())
    cost = estimate_backfill_cost(traces_total)

    try:
        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()
    except Exception as exc:
        raise RuntimeError("database unavailable") from exc
    if pg is None:
        raise RuntimeError("database unavailable")

    await pg.execute(
        """
        INSERT INTO signal_backfill_jobs
            (id, org_id, signal_id, window_start, window_end, status,
             traces_total, traces_done, estimated_cost_usd)
        VALUES ($1, $2, $3, $4, $5, 'pending', $6, 0, $7)
        """,
        job_id,
        org_id,
        signal_id,
        window_start,
        window_end,
        traces_total,
        cost,
    )
    return {
        "job_id": job_id,
        "signal_id": signal_id,
        "window_days": window_days,
        "traces_total": traces_total,
        "estimated_cost_usd": cost,
        "status": "pending",
    }


async def get_backfill_job(
    org_id: str, signal_id: str, job_id: str
) -> dict[str, Any] | None:
    try:
        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()
    except Exception:
        return None
    if pg is None:
        return None
    try:
        row = await pg.fetchrow(
            """
            SELECT id, signal_id, window_start, window_end, status,
                   traces_total, traces_done, estimated_cost_usd, error,
                   created_at, completed_at
            FROM signal_backfill_jobs
            WHERE org_id = $1 AND signal_id = $2 AND id = $3
            """,
            org_id,
            signal_id,
            job_id,
        )
    except Exception:
        return None
    if row is None:
        return None
    return {
        "job_id": str(row["id"]),
        "signal_id": str(row["signal_id"]),
        "status": str(row["status"]),
        "traces_total": int(row["traces_total"] or 0),
        "traces_done": int(row["traces_done"] or 0),
        "estimated_cost_usd": float(row["estimated_cost_usd"] or 0.0),
        "error": row.get("error"),
        "window_start": row["window_start"].isoformat()
        if hasattr(row["window_start"], "isoformat")
        else str(row["window_start"]),
        "window_end": row["window_end"].isoformat()
        if hasattr(row["window_end"], "isoformat")
        else str(row["window_end"]),
        "created_at": row["created_at"].isoformat()
        if hasattr(row["created_at"], "isoformat")
        else str(row["created_at"]),
        "completed_at": row["completed_at"].isoformat()
        if row.get("completed_at") and hasattr(row["completed_at"], "isoformat")
        else None,
    }


class SignalBackfillWorker:
    """Drain pending backfill jobs with per-org rate limits."""

    async def run_once(self, *, max_jobs: int = 3) -> dict[str, Any]:
        try:
            from eden.storage.postgres import get_postgres_client

            pg = await get_postgres_client()
        except Exception as exc:
            return {"processed": 0, "error": str(exc)}
        if pg is None:
            return {"processed": 0, "error": "no_db"}

        try:
            jobs = await pg.fetch(
                """
                SELECT id, org_id, signal_id, window_start, window_end,
                       traces_total, traces_done
                FROM signal_backfill_jobs
                WHERE status IN ('pending', 'running')
                ORDER BY created_at ASC
                LIMIT $1
                """,
                max_jobs,
            )
        except Exception as exc:
            return {"processed": 0, "error": str(exc)}

        processed = 0
        for job in jobs:
            done = await self._process_job(pg, job)
            if done:
                processed += 1
        return {"processed": processed, "jobs_seen": len(jobs)}

    async def _process_job(self, pg: Any, job: Any) -> bool:
        job_id = str(job["id"])
        org_id = str(job["org_id"])
        signal_id = str(job["signal_id"])
        window_start = job["window_start"]
        window_end = job["window_end"]
        traces_done = int(job["traces_done"] or 0)

        await pg.execute(
            "UPDATE signal_backfill_jobs SET status = 'running' WHERE id = $1",
            job_id,
        )

        try:
            rows = await pg.fetch(
                """
                SELECT DISTINCT trace_id
                FROM telemetry_events
                WHERE tenant_id = $1
                  AND timestamp >= $2
                  AND timestamp <= $3
                ORDER BY trace_id
                OFFSET $4
                LIMIT $5
                """,
                org_id,
                window_start,
                window_end,
                traces_done,
                _MAX_TRACES_PER_MINUTE,
            )
        except Exception as exc:
            await pg.execute(
                """
                UPDATE signal_backfill_jobs
                SET status = 'failed', error = $2, completed_at = NOW()
                WHERE id = $1
                """,
                job_id,
                str(exc)[:500],
            )
            return True

        if not rows:
            await pg.execute(
                """
                UPDATE signal_backfill_jobs
                SET status = 'complete', completed_at = NOW()
                WHERE id = $1
                """,
                job_id,
            )
            return True

        from eden.signals.investigator import investigate_trace

        new_done = traces_done
        for row in rows:
            tid = str(row["trace_id"])
            await investigate_trace(org_id, tid)
            new_done += 1

        total = int(job["traces_total"] or 0)
        status = "complete" if new_done >= total else "running"
        await pg.execute(
            """
            UPDATE signal_backfill_jobs
            SET traces_done = $2, status = $3,
                completed_at = CASE WHEN $3 = 'complete' THEN NOW() ELSE NULL END
            WHERE id = $1
            """,
            job_id,
            new_done,
            status,
        )
        return True
