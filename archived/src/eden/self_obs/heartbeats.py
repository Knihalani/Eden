"""F84 component heartbeats (SOTA Wave 9)."""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

logger = logging.getLogger(__name__)

#: Indirection so tests can freeze time without patching the global
#: ``time`` module.
_monotonic = time.monotonic

# TODO(config): promote to Settings
_KEEPALIVE_ENV = "EDEN_HEARTBEAT_KEEPALIVE_S"
_KEEPALIVE_DEFAULT_S = 21600.0


def _keepalive_seconds() -> float:
    """Rewrite an *unchanged* status this often anyway (default 6h).

    The keepalive bounds ``checked_at`` staleness: without it, a
    component whose status never changes would never write again and
    liveness dashboards could not distinguish "healthy and quiet" from
    "process gone".
    """
    try:
        return float(os.environ.get(_KEEPALIVE_ENV, _KEEPALIVE_DEFAULT_S))
    except (TypeError, ValueError):
        return _KEEPALIVE_DEFAULT_S


#: Last status actually written per ``(component, org_id)``:
#: ``{(component, org_id): (status, last_write_monotonic)}``.
#:
#: Process-local on purpose. The scheduled tick is leader-gated, so one
#: process does all the batch writes; a restart/failover just clears the
#: map, which fails toward writing (never toward suppressing a write).
_last_written: dict[tuple[str, str | None], tuple[str, float]] = {}


def _reset_write_gate_for_tests() -> None:
    _last_written.clear()


def _should_write(
    component: str, org_id: str | None, status: str, now: float
) -> bool:
    """Write when the status CHANGED since the last written value, when
    we have never written this key, or when the keepalive interval has
    elapsed since the last write."""
    prev = _last_written.get((component, org_id))
    if prev is None:
        return True
    prev_status, written_at = prev
    if prev_status != status:
        return True
    return (now - written_at) >= _keepalive_seconds()


def _note_written(
    component: str, org_id: str | None, status: str, now: float
) -> None:
    _last_written[(component, org_id)] = (status, now)


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
        # Not gated (an explicit single-row call always writes), but the
        # write still updates the change-gate state so the batch path
        # never re-writes a status this call just persisted.
        _note_written(component, org_id, status, _monotonic())
        return True
    except Exception as exc:
        logger.debug("heartbeat persist skipped: %s", exc)
        return False


async def record_heartbeats_batch(
    rows: list[tuple[str, str | None, str, dict[str, Any] | None]],
) -> bool:
    """Persist many heartbeats in a single multi-row INSERT.

    ``rows`` is ``(component, org_id, status, meta)``.

    The scheduled probe tick writes three heartbeats per org. Doing that
    with one :func:`record_heartbeat` call each meant 3*N serial round
    trips per tick — at the old 500-org limit, >=1,500 sequential
    statements, which by itself is long enough that Postgres never
    reaches Neon's autosuspend window no matter how the loop is phased.
    One statement per tick instead.

    Change-gated: a row is only written when its status differs from the
    last value actually written for that ``(component, org_id)`` — or on
    the ``EDEN_HEARTBEAT_KEEPALIVE_S`` keepalive cadence (default 6h) so
    ``checked_at`` still proves liveness. In steady state (every status
    unchanged) a tick writes nothing at all instead of 3*N rows.
    Returns True when the write succeeded *or* nothing needed writing;
    False only on a failed write, exactly as before. The gate state is
    updated only after a successful INSERT, so a failed flush retries in
    full on the next tick.
    """
    if not rows:
        return True
    now = _monotonic()
    due = [row for row in rows if _should_write(row[0], row[1], row[2], now)]
    if not due:
        return True
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return False
        params: list[Any] = []
        values: list[str] = []
        for component, org_id, status, meta in due:
            base = len(params)
            values.append(
                f"(${base + 1}, ${base + 2}, ${base + 3}, ${base + 4}::jsonb, NOW())"
            )
            params.extend(
                [component, org_id, status, json.dumps(meta or {})]
            )
        await client.execute(
            "INSERT INTO eden_component_heartbeats "
            "(component, org_id, status, meta, checked_at) VALUES "
            + ", ".join(values),
            *params,
        )
        for component, org_id, status, _meta in due:
            _note_written(component, org_id, status, now)
        return True
    except Exception as exc:
        logger.debug("heartbeat batch persist skipped: %s", exc)
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
    org_id: str | None,
    workers_result: dict[str, Any],
    *,
    sink: list[tuple[str, str | None, str, dict[str, Any] | None]] | None = None,
) -> None:
    """Persist the once-per-tick worker snapshot for ``org_id``.

    When ``sink`` is provided the rows are appended to it instead of
    being written immediately, so a caller sweeping many orgs can flush
    them all through :func:`record_heartbeats_batch` as one statement —
    that flush applies the status-change/keepalive write gate, so
    unchanged rows appended here cost nothing.

    The immediate path applies the same gate before each write: an
    unchanged status is only rewritten on the keepalive cadence.
    """
    status = workers_result.get("status", "unknown")
    meta = workers_result.get("meta") or {}
    if sink is not None:
        sink.append(("background_workers", org_id, status, meta))
        sink.append(("api", org_id, "healthy", {"ts": time.time()}))
        return
    now = _monotonic()
    if _should_write("background_workers", org_id, status, now):
        await record_heartbeat(
            "background_workers", org_id=org_id, status=status, meta=meta
        )
    if _should_write("api", org_id, "healthy", now):
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

