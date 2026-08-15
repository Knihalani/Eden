"""CRUD for improvement_runs (N23 watermark ledger)."""

from __future__ import annotations

import contextlib
import json
import uuid
from datetime import UTC, datetime
from typing import Any

from eden.storage.postgres import get_postgres_client


def _ts(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _row(row: Any) -> dict[str, Any]:
    d = dict(row)
    for key in (
        "started_at",
        "finished_at",
        "last_run_at",
    ):
        if key in d:
            d[key] = _ts(d[key])
    if isinstance(d.get("metadata"), str):
        try:
            d["metadata"] = json.loads(d["metadata"])
        except Exception:
            d["metadata"] = {}
    for num in ("llm_cost_usd",):
        if num in d and d[num] is not None:
            d[num] = float(d[num])
    return d


async def get_watermark(org_id: str) -> datetime:
    """Return last successful sweep watermark, or epoch if none."""
    client = await get_postgres_client()
    if client is None:
        return datetime(1970, 1, 1, tzinfo=UTC)
    row = await client.fetchrow(
        """
        SELECT last_run_at FROM improvement_runs
        WHERE org_id = $1 AND status = 'completed'
        ORDER BY finished_at DESC NULLS LAST
        LIMIT 1
        """,
        org_id,
    )
    if row is None or row.get("last_run_at") is None:
        return datetime(1970, 1, 1, tzinfo=UTC)
    dt = row["last_run_at"]
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt


async def create_run(
    org_id: str,
    *,
    last_run_at: datetime,
    agent_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    run_id = str(uuid.uuid4())
    client = await get_postgres_client()
    if client is None:
        return {
            "id": run_id,
            "org_id": org_id,
            "status": "failed",
            "error": "postgres_unavailable",
        }
    await client.execute(
        """
        INSERT INTO improvement_runs (
            id, org_id, agent_id, status, last_run_at, metadata
        ) VALUES ($1::uuid, $2, $3, 'running', $4, $5::jsonb)
        """,
        run_id,
        org_id,
        agent_id,
        last_run_at,
        json.dumps(metadata or {}),
    )
    return await get_run(org_id, run_id) or {"id": run_id, "org_id": org_id}


async def finish_run(
    org_id: str,
    run_id: str,
    *,
    status: str,
    plans_created: int = 0,
    plans_skipped_dedup: int = 0,
    llm_cost_usd: float = 0.0,
    error: str | None = None,
    metadata_patch: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    client = await get_postgres_client()
    if client is None:
        return None
    await client.execute(
        """
        UPDATE improvement_runs SET
            status = $3,
            finished_at = NOW(),
            plans_created = $4,
            plans_skipped_dedup = $5,
            llm_cost_usd = $6,
            error = $7
        WHERE org_id = $1 AND id = $2::uuid
        """,
        org_id,
        run_id,
        status,
        plans_created,
        plans_skipped_dedup,
        llm_cost_usd,
        error,
    )
    if metadata_patch:
        await merge_run_metadata(org_id, run_id, metadata_patch)
    return await get_run(org_id, run_id)


async def merge_run_metadata(
    org_id: str,
    run_id: str,
    patch: dict[str, Any],
) -> None:
    """M13 (§6.1): merge keys into improvement_runs.metadata without finishing."""
    if not patch:
        return
    client = await get_postgres_client()
    if client is None:
        return
    with contextlib.suppress(Exception):
        await client.execute(
            """
            UPDATE improvement_runs SET
                metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
            WHERE org_id = $1 AND id = $2::uuid
            """,
            org_id,
            run_id,
            json.dumps(patch),
        )


async def get_run(org_id: str, run_id: str) -> dict[str, Any] | None:
    client = await get_postgres_client()
    if client is None:
        return None
    row = await client.fetchrow(
        "SELECT * FROM improvement_runs WHERE org_id = $1 AND id = $2::uuid",
        org_id,
        run_id,
    )
    return _row(row) if row else None


async def list_runs(org_id: str, *, limit: int = 50) -> list[dict[str, Any]]:
    client = await get_postgres_client()
    if client is None:
        return []
    rows = await client.fetch(
        """
        SELECT * FROM improvement_runs
        WHERE org_id = $1
        ORDER BY started_at DESC
        LIMIT $2
        """,
        org_id,
        limit,
    )
    return [_row(r) for r in rows]
