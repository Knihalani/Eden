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


async def snapshot_worker_liveness() -> dict[str, Any]:
    """Compute worker liveness without writing heartbeats.

    Status is process-scoped (same for every org). The scheduled tick
    snapshots once, then fans out per-org heartbeat writes + transition
    notifies — avoiding O(orgs) re-probes of the same signal.
    """
    meta: dict[str, Any] = {"ts": time.time()}
    status = "unknown"
    try:
        from eden.workers.background import (
            background_evolution_loop_running,
            background_workers_running,
        )
        from eden.workers.main import worker_loops_running

        running = worker_loops_running()
        signal_source = "eden_worker_loops"
        if running is None:
            # Not the eden-worker process (or it hasn't reached
            # _run_forever yet) — fall back to the API-lifespan flag.
            running = background_workers_running()
            signal_source = "api_background_workers_flag"
        meta["background_workers_running"] = running
        meta["signal_source"] = signal_source
        meta["evolution_loop_running"] = background_evolution_loop_running()
        status = "healthy" if running else "degraded"
    except Exception as exc:
        meta["error"] = str(exc)
        status = "degraded"
    return {"status": status, "meta": meta}


async def record_worker_heartbeats(
    org_id: str | None, workers_result: dict[str, Any]
) -> None:
    """Persist the once-per-tick worker snapshot for ``org_id``."""
    status = workers_result.get("status", "unknown")
    meta = workers_result.get("meta") or {}
    await record_heartbeat(
        "background_workers", org_id=org_id, status=status, meta=meta
    )
    await record_heartbeat(
        "api", org_id=org_id, status="healthy", meta={"ts": time.time()}
    )


async def probe_and_record_workers(org_id: str | None = None) -> dict[str, Any]:
    """Snapshot background worker liveness and write heartbeats.

    ``eden.self_obs.scheduler``'s scheduled tick (the only caller in
    production) runs inside ``eden.workers.main`` — the dedicated
    ``eden-worker`` process — not the API. That process never calls
    ``eden.workers.background.start_background_workers()`` (that's
    called only from the API's lifespan, gated by
    ``settings.run_background_workers``), so
    ``background_workers_running()`` is structurally always ``False``
    there: checking it here used to guarantee a false "degraded"
    transition on the very first scheduled tick of every deploy, one
    that could never resolve back to healthy.

    ``eden.workers.main.worker_loops_running()`` reports the real
    liveness of the loops that process actually hosts and returns
    ``None`` when this process never hosted any of them (e.g. this ran
    from the API's admin-status route instead of the scheduler) — only
    then do we fall back to the API-only flag, preserving that route's
    prior behaviour.
    """
    result = await snapshot_worker_liveness()
    await record_worker_heartbeats(org_id, result)
    return result

