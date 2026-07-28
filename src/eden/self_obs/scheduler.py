"""F84 — scheduled self-observability probe scan + degraded-state alerts.

``eden.self_obs.heartbeats.probe_and_record_workers`` and
``eden.self_obs.synthetics.run_golden_probes`` used to only run
on-demand (an admin dashboard route, an MCP tool call): nothing ran
them on a schedule, and even when they were invoked a degraded/fail
status only landed in a Postgres table and a JSON response — no
email/Slack/PagerDuty anywhere.

``run_scheduled_probes`` is the tick body a leader-gated loop in
``eden.workers.main`` calls (via ``run_if_leader``, same pattern as
the EQL watchdog / maintenance loops): for every org it runs both
probe sets and, only on a *transition* into degraded/fail (never on
every tick while already degraded — see ``_is_new_degradation``),
sends a rate-limited email the same way NL real_incident / budget
alerts already do (``eden.services.alert_email``).

The previous-status lookup is a Postgres read, not an in-memory
cache, so the "only notify on transition" behaviour survives leader
failover and process restarts.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_HEALTHY_STATUSES = {"ok", "healthy"}


async def _list_org_ids(limit: int = 500) -> list[str]:
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return []
        rows = await client.fetch(
            "SELECT id FROM organizations LIMIT $1", limit
        )
        return [str(r["id"]) for r in rows]
    except Exception as exc:
        logger.debug("self_obs.scheduler: list orgs failed: %s", exc)
        return []


async def _previous_status(component: str, org_id: str) -> str | None:
    """Last-persisted status for ``component`` before this tick writes
    a new one, so a transition can be detected without any in-memory
    cache (safe across leader failover / process restarts).
    """
    try:
        from eden.self_obs.heartbeats import latest_heartbeats

        rows = await latest_heartbeats(org_id=org_id, limit=200)
        for row in rows:
            if row.get("component") == component:
                return row.get("status")
        return None
    except Exception as exc:
        logger.debug(
            "self_obs.scheduler: previous status lookup failed component=%s: %s",
            component,
            exc,
        )
        return None


async def _previous_statuses_batch(
    org_ids: list[str],
    components: tuple[str, ...] = ("background_workers", "golden_probes"),
) -> dict[str, dict[str, str | None]]:
    """One PG round-trip for prior statuses across all orgs in the tick.

    Returns ``{org_id: {component: status}}``. Missing rows mean
    ``None`` (same as ``_previous_status`` when no prior heartbeat).
    """
    out: dict[str, dict[str, str | None]] = {
        oid: {c: None for c in components} for oid in org_ids
    }
    if not org_ids or not components:
        return out
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return out
        rows = await client.fetch(
            """
            SELECT DISTINCT ON (org_id, component)
                   org_id, component, status
              FROM eden_component_heartbeats
             WHERE org_id = ANY($1::text[])
               AND component = ANY($2::text[])
             ORDER BY org_id, component, checked_at DESC
            """,
            org_ids,
            list(components),
        )
        for r in rows:
            oid = str(r["org_id"])
            comp = str(r["component"])
            if oid in out and comp in out[oid]:
                out[oid][comp] = r["status"]
        return out
    except Exception as exc:
        logger.debug(
            "self_obs.scheduler: batched previous status lookup failed: %s", exc
        )
        return out


def _is_new_degradation(previous: str | None, current: str) -> bool:
    """True only on a transition into degraded/fail.

    Never true while already degraded on the previous tick too — that
    would page every ~10 minutes for the duration of an outage instead
    of once at the start of it.
    """
    was_healthy = previous is None or previous in _HEALTHY_STATUSES
    is_bad = current not in _HEALTHY_STATUSES
    return was_healthy and is_bad


async def _notify_degraded(
    *, org_id: str, component: str, status: str, detail: dict[str, Any]
) -> None:
    try:
        from eden.services.alert_email import send_self_obs_degraded_email

        await send_self_obs_degraded_email(
            org_id=org_id,
            component=component,
            status=status,
            detail=detail,
        )
    except Exception as exc:
        logger.warning(
            "self_obs.scheduler: degraded-state email failed org=%s component=%s: %s",
            org_id,
            component,
            exc,
        )


async def probe_org(
    org_id: str,
    *,
    shared_probes: dict[str, Any] | None = None,
    workers_result: dict[str, Any] | None = None,
    previous_by_component: dict[str, str | None] | None = None,
) -> dict[str, Any]:
    """Run both probe sets for a single org; alert on new degradation.

    ``shared_probes`` (from :func:`eden.self_obs.synthetics.run_org_independent_probes`,
    computed once per tick by ``run_scheduled_probes``) supplies the
    org-independent golden-probe results so this doesn't re-run them
    per org.

    ``workers_result`` (from :func:`eden.self_obs.heartbeats.snapshot_worker_liveness`)
    is process-scoped — when supplied, this org only persists heartbeats
    and checks transitions (no re-probe). ``previous_by_component`` is the
    batched prior-status map from the same tick.
    """
    from eden.self_obs.heartbeats import (
        probe_and_record_workers,
        record_heartbeat,
        record_worker_heartbeats,
    )
    from eden.self_obs.synthetics import run_golden_probes

    if previous_by_component is not None:
        previous_workers = previous_by_component.get("background_workers")
        previous_golden = previous_by_component.get("golden_probes")
    else:
        previous_workers = await _previous_status("background_workers", org_id)
        previous_golden = await _previous_status("golden_probes", org_id)

    if workers_result is None:
        workers_result = await probe_and_record_workers(org_id)
    else:
        await record_worker_heartbeats(org_id, workers_result)

    workers_status = workers_result.get("status", "unknown")
    workers_bad = workers_status not in _HEALTHY_STATUSES
    if _is_new_degradation(previous_workers, workers_status):
        await _notify_degraded(
            org_id=org_id,
            component="background_workers",
            status=workers_status,
            detail=workers_result.get("meta", {}),
        )

    golden_result = await run_golden_probes(org_id, shared_results=shared_probes)
    golden_status = "fail" if golden_result.get("failed") else "ok"
    if _is_new_degradation(previous_golden, golden_status):
        await _notify_degraded(
            org_id=org_id,
            component="golden_probes",
            status=golden_status,
            detail={
                "failed": golden_result.get("failed"),
                "probes": golden_result.get("probes"),
            },
        )
    # golden_probes has no heartbeat writer of its own (unlike
    # background_workers, which probe_and_record_workers persists) —
    # write one here so next tick's _previous_status lookup above has
    # something to compare against.
    try:
        await record_heartbeat(
            "golden_probes",
            org_id=org_id,
            status=golden_status,
            meta={"failed": golden_result.get("failed")},
        )
    except Exception as exc:
        logger.debug(
            "self_obs.scheduler: golden_probes heartbeat persist failed: %s", exc
        )

    return {
        "workers": workers_result,
        "golden_probes": golden_result,
        "degraded": workers_bad or bool(golden_result.get("failed")),
    }


async def run_scheduled_probes(*, org_ids: list[str] | None = None) -> dict[str, Any]:
    """Tick body: probe every org. Caller (``eden.workers.main``) leader-gates this."""
    orgs = org_ids if org_ids is not None else await _list_org_ids()

    shared_probes: dict[str, Any] = {}
    workers_result: dict[str, Any] | None = None
    previous_map: dict[str, dict[str, str | None]] = {}
    if orgs:
        # sign_in_home / gateway_health are org-independent (same fixed
        # URL every call) — run them once per tick, not once per org,
        # so HTTP + Postgres-write load stays O(1) instead of O(orgs).
        from eden.self_obs.heartbeats import snapshot_worker_liveness
        from eden.self_obs.synthetics import run_org_independent_probes

        try:
            shared_probes = await run_org_independent_probes()
        except Exception as exc:
            logger.error(
                "self_obs.scheduler: org-independent probe run failed: %s",
                exc,
                exc_info=True,
            )
            shared_probes = {}

        # Worker liveness is process-scoped — snapshot once, fan out writes.
        try:
            workers_result = await snapshot_worker_liveness()
        except Exception as exc:
            logger.error(
                "self_obs.scheduler: worker liveness snapshot failed: %s",
                exc,
                exc_info=True,
            )
            workers_result = {"status": "unknown", "meta": {"error": str(exc)}}

        previous_map = await _previous_statuses_batch(orgs)

    degraded_orgs: list[str] = []
    for org_id in orgs:
        try:
            result = await probe_org(
                org_id,
                shared_probes=shared_probes,
                workers_result=workers_result,
                previous_by_component=previous_map.get(org_id),
            )
            if result.get("degraded"):
                degraded_orgs.append(org_id)
        except Exception as exc:
            logger.error(
                "self_obs.scheduler: probe failed org=%s: %s",
                org_id,
                exc,
                exc_info=True,
            )
    return {"orgs_scanned": len(orgs), "degraded_orgs": degraded_orgs}
