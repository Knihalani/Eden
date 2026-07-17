"""F84 component heartbeats (SOTA Wave 9)."""

from __future__ import annotations

import json
import logging
import time
from typing import Any

logger = logging.getLogger(__name__)


async def record_heartbeat(
    component: str,
    *,
    org_id: str | None = None,
    status: str = "healthy",
    meta: dict[str, Any] | None = None,
) -> bool:
    """Persist a heartbeat row. Returns False when PG unavailable."""
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return False
        await client.execute(
            """
            INSERT INTO eden_component_heartbeats (component, org_id, status, meta, checked_at)
            VALUES ($1, $2, $3, $4::jsonb, NOW())
            """,
            component,
            org_id,
            status,
            json.dumps(meta or {}),
        )
        return True
    except Exception as exc:
        logger.debug("heartbeat persist skipped: %s", exc)
        return False


async def latest_heartbeats(
    *,
    org_id: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Return newest heartbeat per component (optionally org-scoped)."""
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return []
        rows = await client.fetch(
            """
            SELECT DISTINCT ON (component)
                   component, org_id, status, meta, checked_at
              FROM eden_component_heartbeats
             WHERE ($1::text IS NULL OR org_id = $1 OR org_id IS NULL)
             ORDER BY component, checked_at DESC
             LIMIT $2
            """,
            org_id,
            limit,
        )
        out: list[dict[str, Any]] = []
        for r in rows:
            out.append(
                {
                    "component": r["component"],
                    "org_id": r["org_id"],
                    "status": r["status"],
                    "meta": r["meta"],
                    "checked_at": r["checked_at"].isoformat() if r["checked_at"] else None,
                }
            )
        return out
    except Exception as exc:
        logger.debug("heartbeat read skipped: %s", exc)
        return []


async def probe_and_record_workers(org_id: str | None = None) -> dict[str, Any]:
    """Snapshot background worker flags and write heartbeats."""
    meta: dict[str, Any] = {"ts": time.time()}
    status = "unknown"
    try:
        from eden.workers.background import (
            background_evolution_loop_running,
            background_workers_running,
        )

        running = background_workers_running()
        meta["background_workers_running"] = running
        meta["evolution_loop_running"] = background_evolution_loop_running()
        status = "healthy" if running else "degraded"
    except Exception as exc:
        meta["error"] = str(exc)
        status = "degraded"

    await record_heartbeat("background_workers", org_id=org_id, status=status, meta=meta)
    await record_heartbeat("api", org_id=org_id, status="healthy", meta={"ts": time.time()})
    return {"status": status, "meta": meta}
