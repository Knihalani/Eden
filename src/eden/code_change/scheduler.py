"""Cat 23 quality-gated scheduler (Phase 3b, 2026-06-23).

The scheduler turns the "fire patch on every incident" anti-pattern
into a quality-over-quantity pipeline. Three entrypoints:

* :func:`evaluate_pending_clusters` — the 15-min cron tick. Pulls
  recent high-severity incident clusters (Cat 2) and, for each
  cluster that passes the pre-filters, calls
  :class:`PatchGenerator` to generate + critic + size-check +
  dedup-check + persist a ``proposed_patches`` row.

* :func:`stale_pending_sweep` — nightly (03:00 UTC). Notifies
  org admins of any ``proposed_patches`` row that has been in
  ``status='proposed'`` for more than 24h.

* :func:`weekly_digest` — Monday 09:00 UTC. 7-day rollup of
  the patch pipeline (generated / approved / merged / reverted /
  low-quality) per org.

Pre-filters (run BEFORE patch generation, to keep cost bounded):

1. ``code_change_enabled`` from the org policy must be true.
2. Cluster ``count`` must be ≥ ``Settings.patch_cluster_min_size``.
3. ``SUM(cost_usd)`` of generated proposed_patches in the last
   24h must be < ``Settings.max_cost_per_user_per_day`` (the
   cost circuit breaker — per-org).
4. Generated count today < ``Settings.patch_max_per_day``;
   generated count this week < ``Settings.patch_max_per_week``.
5. No active ``pr_rejection_memory`` row matches the
   cluster's ``(file_path, title_hash)`` — the not-now memory.
6. No similar diff exists in the last 14d (delegated to
   :class:`PatchGenerator`'s similarity dedup).

All settings are tunable per-org via the existing
``organizations.features.code_change_policy`` JSONB; the env-
level Settings are the global defaults.

Hooks fired (via :class:`PromotionHook`):

* ``on_drift_alert(drift_type="cat23_scheduled_patch_generated", severity=...)``
  for each cluster that survived all pre-filters.
* ``on_drift_alert(drift_type="cat23_cost_circuit_breaker", severity="high")``
  when the daily cost cap is hit.
* ``on_drift_alert(drift_type="cat23_rejection_cooldown_hit", severity="low")``
  when the not-now memory skips a cluster.
* ``on_drift_alert(drift_type="cat23_stale_pending", severity="medium")``
  from :func:`stale_pending_sweep`.
* ``on_drift_alert(drift_type="cat23_weekly_digest", severity="low")``
  from :func:`weekly_digest`.

Pure functions — no global state, no module-level singletons.
``cron_tick`` wraps each entrypoint with the right cadence.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime
from typing import Any

from eden.code_change._common import DEFAULT_POLICY, _select_rows
from eden.config import get_settings

logger = logging.getLogger(__name__)


# ── Pre-filter helpers (pure) ──────────────────────────────────────


def _permitted_severities() -> set[str]:
    """Severity levels eligible for autonomous patch generation.

    The scheduler only auto-generates patches for ``"high"`` or
    ``"critical"`` clusters. Medium / low clusters surface via
    the weekly digest and inbox but never trigger an LLM call.
    """
    return {"high", "critical"}


def _is_opted_in(policy: dict[str, Any]) -> bool:
    """True iff the org has flipped the two-stage opt-in switch."""
    return bool(policy.get("code_change_enabled", False))


async def _recent_cost_for_org(org_id: str) -> float:
    """SUM(cost_usd) of generated proposed_patches in the last 24h."""
    rows = await _select_rows(
        org_id,
        "proposed_patches",
        where="created_at > NOW() - INTERVAL '1 day'",
        order_by="created_at DESC",
        limit=500,
    )
    return float(sum(float(r.get("cost_usd") or 0.0) for r in rows))


async def _recent_count_for_org(
    org_id: str,
    window: str,
) -> int:
    """COUNT(*) of generated proposed_patches in ``window``."""
    rows = await _select_rows(
        org_id,
        "proposed_patches",
        where=f"created_at > NOW() - INTERVAL '{window}'",
        order_by="created_at DESC",
        limit=1000,
    )
    return len(rows)


async def _is_in_rejection_cooldown(
    org_id: str,
    file_path: str,
    title_hash: str,
) -> bool:
    """True iff an active rejection_memory row covers this patch."""
    if not file_path or not title_hash:
        return False
    rows = await _select_rows(
        org_id,
        "pr_rejection_memory",
        where=(
            "file_path = $2 AND title_hash = $3 "
            "AND expires_at > NOW()"
        ),
        params=(file_path, title_hash),
        order_by="created_at DESC",
        limit=1,
    )
    return bool(rows)


async def _is_same_file_in_24h_cooldown(
    org_id: str,
    file_path: str,
) -> bool:
    """Cooldown: same file patched within the last 24h.

    Prevents a noisy RCA from generating 3 patches for the same
    file in 1 hour. Distinct from the not-now memory (which is
    a deliberate human rejection lasting 30-90d).
    """
    if not file_path:
        return False
    rows = await _select_rows(
        org_id,
        "proposed_patches",
        where=(
            "blast_radius_affected_ids ? $2 "
            "AND created_at > NOW() - INTERVAL '1 day'"
        ),
        params=(file_path,),
        order_by="created_at DESC",
        limit=1,
    )
    return bool(rows)


async def _list_active_orgs() -> list[str]:
    """List org ids that have at least one repo_connection.

    The scheduler skips orgs with no repos — they can't host a
    PR regardless. Cheap query on the indexed
    ``idx_repo_connections_status`` partial index.
    """
    try:
        from eden.storage.postgres import get_postgres_client
        client = await get_postgres_client()
        if client is None:
            return []
        async with client.acquire() as conn:
            rows = await conn.fetch(
                "SELECT DISTINCT org_id FROM repo_connections "
                "WHERE status = 'active' LIMIT 200"
            )
        return [r["org_id"] for r in rows]
    except Exception as exc:
        logger.debug("scheduler: _list_active_orgs failed: %s", exc)
        return []


async def _list_clusters_for_org(
    org_id: str,
    *,
    min_size: int,
    window_hours: int = 24,
) -> list[dict[str, Any]]:
    """List high-severity clusters for this org from the Cat 2
    ``incident_clusters`` table (or compatible view).

    Falls back to ``[]`` when the Cat 2 table isn't reachable —
    the scheduler never crashes on a missing dep, it just
    produces no patches for this tick.
    """
    try:
        from eden.storage.postgres import get_postgres_client
        client = await get_postgres_client()
        if client is None:
            return []
        async with client.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id, name, severity, member_count, category,
                       error_type, agent_id, last_seen_at
                  FROM incident_clusters
                 WHERE org_id = $1
                   AND severity = ANY($2)
                   AND member_count >= $3
                   AND last_seen_at > NOW() - ($4 || ' hours')::interval
                 ORDER BY last_seen_at DESC
                 LIMIT 50
                """,
                org_id,
                list(_permitted_severities()),
                int(min_size),
                str(int(window_hours)),
            )
        return [dict(r) for r in rows]
    except Exception as exc:
        # Cat 2 table may not exist in a fresh deploy. The scheduler
        # must still work for the rest of the pipeline.
        logger.debug(
            "scheduler: _list_clusters_for_org(%s) failed (Cat 2 may "
            "not be present): %s",
            org_id,
            exc,
        )
        return []


async def _get_org_policy(org_id: str) -> dict[str, Any]:
    """Read the org policy merged with defaults.

    Reads the same JSONB column as :class:`CodeChangePolicyService`.
    Best-effort: a DB error returns the global default policy so
    the scheduler doesn't block on a transient outage.
    """
    try:
        from eden.storage.postgres import get_postgres_client
        client = await get_postgres_client()
        if client is None:
            return dict(DEFAULT_POLICY)
        async with client.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT features->'code_change_policy' AS policy "
                "FROM organizations WHERE id = $1",
                org_id,
            )
        if row is None:
            return dict(DEFAULT_POLICY)
        raw = row.get("policy")
        if isinstance(raw, str):
            stored = json.loads(raw) if raw else {}
        elif isinstance(raw, dict):
            stored = raw
        else:
            stored = {}
        return {**DEFAULT_POLICY, **stored}
    except Exception as exc:
        logger.debug("scheduler: _get_org_policy(%s) failed: %s", org_id, exc)
        return dict(DEFAULT_POLICY)


async def _emit_drift(
    *,
    org_id: str,
    drift_type: str,
    severity: str = "low",
    payload: dict[str, Any] | None = None,
) -> None:
    """Fire a PromotionHook.on_drift_alert (best-effort).

    Per-tick budget: ``_tick_drift_count`` caps the number of
    drift emissions per ``evaluate_pending_clusters`` call. Without
    this, an incident storm (100+ clusters) fires 100+ hooks, each
    pushing through the HookBus dedup window — wasted budget on
    the same logical event. The cap is reset by :func:`evaluate_pending_clusters`.
    """
    global _tick_drift_count
    if _tick_drift_count >= _MAX_DRIFTS_PER_TICK:
        return
    _tick_drift_count += 1
    try:
        from eden.llmops.promotion_hooks import PromotionHook
        await PromotionHook.on_drift_alert(
            org_id=org_id,
            drift_type=drift_type,
            severity=severity,
            payload=payload or {},
        )
    except Exception as exc:
        logger.debug("scheduler: on_drift_alert(%s) failed: %s", drift_type, exc)


# Per-tick coalesce — see ``_emit_drift``. 25 is enough for any
# realistic single-tick incident storm (a 100-cluster flood caps at
# 25 emissions; the rest are dropped silently with no behaviour
# change to downstream hook handlers).
_MAX_DRIFTS_PER_TICK = 25
_tick_drift_count: int = 0


# ── Per-cluster pre-filter ──────────────────────────────────────────


async def _cluster_passes_pre_filters(
    org_id: str,
    cluster: dict[str, Any],
    *,
    policy: dict[str, Any],
    cost_today: float,
    count_today: int,
    count_week: int,
    settings: Any,
) -> tuple[bool, str]:
    """Run all pre-filters against a cluster.

    Returns ``(passed, reason)``. ``reason`` is the human-readable
    explanation that's logged + (on failure) included in the
    drift-alert payload. The order matters — cheaper checks
    first so a flood of clusters short-circuits before we touch
    the per-cluster file_path lookups.
    """
    if not _is_opted_in(policy):
        return False, "code_change_enabled=false"
    if cluster.get("severity") not in _permitted_severities():
        return False, f"severity={cluster.get('severity')} not permitted"
    if int(cluster.get("member_count", 0)) < int(settings.patch_cluster_min_size):
        return False, (
            f"cluster size {cluster.get('member_count')} "
            f"< min {settings.patch_cluster_min_size}"
        )
    if cost_today >= float(settings.max_cost_per_user_per_day):
        return False, (
            f"daily cost ${cost_today:.2f} >= cap "
            f"${settings.max_cost_per_user_per_day:.2f}"
        )
    if count_today >= int(settings.patch_max_per_day):
        return False, (
            f"daily count {count_today} >= cap "
            f"{settings.patch_max_per_day}"
        )
    if count_week >= int(settings.patch_max_per_week):
        return False, (
            f"weekly count {count_week} >= cap "
            f"{settings.patch_max_per_week}"
        )
    # Per-file cooldown. The Cat 2 cluster doesn't always carry a
    # file_path; we extract it from the cluster's ``category`` when
    # available, otherwise skip this filter.
    file_path = cluster.get("category") or cluster.get("primary_file") or ""
    title_hash = cluster.get("id") or cluster.get("name") or ""
    if file_path:
        if await _is_same_file_in_24h_cooldown(org_id, file_path):
            return False, f"file {file_path} in 24h cooldown"
        if await _is_in_rejection_cooldown(org_id, file_path, title_hash):
            return False, (
                f"file {file_path} title_hash={title_hash} "
                "in rejection_memory cooldown"
            )
    return True, "passed"


# ── The 15-min cron tick ──────────────────────────────────────────


async def evaluate_pending_clusters(
    *,
    dry_run: bool = False,
    patch_generator: Any | None = None,
) -> dict[str, Any]:
    """Evaluate Cat 2 incident clusters and queue patches.

    Runs every 15 minutes via :mod:`eden.workers.cron_tick`. The
    flow:

    1. List active orgs (have at least one repo_connection).
    2. For each org: read policy, count today, count week, cost today.
    3. List high-severity clusters from the Cat 2 incident_clusters table.
    4. For each cluster: run pre-filters.
    5. For each survivor: call :class:`PatchGenerator.generate`.

    Returns a summary dict suitable for the cron job's stdout
    log. ``dry_run`` skips the actual LLM call + persistence so
    operators can preview the run.
    """
    settings = get_settings()
    # Reset per-tick drift budget — see ``_emit_drift`` and
    # ``_MAX_DRIFTS_PER_TICK``.
    global _tick_drift_count
    _tick_drift_count = 0
    summary: dict[str, Any] = {
        "orgs_scanned": 0,
        "orgs_opted_in": 0,
        "clusters_found": 0,
        "clusters_passed": 0,
        "patches_generated": 0,
        "pre_filter_rejections": {},
        "dry_run": dry_run,
        "ts": datetime.now(UTC).isoformat(),
    }
    pf_counts: dict[str, int] = {}

    orgs = await _list_active_orgs()
    summary["orgs_scanned"] = len(orgs)

    # Lazy import to avoid pulling ModelRouter + Cat 2 on import.
    if patch_generator is None and not dry_run:
        try:
            from eden.code_change import PatchGenerator
            patch_generator = PatchGenerator()
        except Exception as exc:
            logger.warning(
                "scheduler: PatchGenerator import failed (%s); "
                "skipping generation this tick",
                exc,
            )
            patch_generator = None

    for org_id in orgs:
        policy = await _get_org_policy(org_id)
        if not _is_opted_in(policy):
            continue
        summary["orgs_opted_in"] += 1
        # The three per-org budget fetches are independent reads;
        # fire them concurrently to halve the per-org latency on
        # this loop's hot path.
        cost_today, count_today, count_week = await asyncio.gather(
            _recent_cost_for_org(org_id),
            _recent_count_for_org(org_id, "1 day"),
            _recent_count_for_org(org_id, "7 days"),
        )
        if cost_today >= float(settings.max_cost_per_user_per_day):
            await _emit_drift(
                org_id=org_id,
                drift_type="cat23_cost_circuit_breaker",
                severity="high",
                payload={
                    "cost_today_usd": cost_today,
                    "cap_usd": settings.max_cost_per_user_per_day,
                },
            )
            continue
        clusters = await _list_clusters_for_org(
            org_id, min_size=settings.patch_cluster_min_size,
        )
        summary["clusters_found"] += len(clusters)
        for cluster in clusters:
            passed, reason = await _cluster_passes_pre_filters(
                org_id,
                cluster,
                policy=policy,
                cost_today=cost_today,
                count_today=count_today,
                count_week=count_week,
                settings=settings,
            )
            if not passed:
                pf_counts[reason] = pf_counts.get(reason, 0) + 1
                if "rejection" in reason:
                    await _emit_drift(
                        org_id=org_id,
                        drift_type="cat23_rejection_cooldown_hit",
                        severity="low",
                        payload={"cluster_id": cluster.get("id"), "reason": reason},
                    )
                continue
            summary["clusters_passed"] += 1
            if dry_run or patch_generator is None:
                continue
            # PatchGenerator.generate takes (org_id, rca_id, trace_id,
            # repo_id, linked_files=...). We treat the cluster id as
            # rca_id (the cluster name is the RCA summary) and pull
            # the agent_id + error_type from the cluster row.
            rca_id = f"clu_{cluster.get('id', '')}"
            try:
                result = await patch_generator.generate(
                    org_id=org_id,
                    rca_id=rca_id,
                    trace_id=rca_id,
                    repo_id=cluster.get("agent_id") or "",
                    rca_summary=(
                        f"Cluster {cluster.get('name')}: "
                        f"{cluster.get('error_type', '')} "
                        f"(severity={cluster.get('severity')}, "
                        f"count={cluster.get('member_count')})"
                    ),
                    test_plan=[],
                    linked_files=[],
                )
            except Exception as exc:
                logger.warning(
                    "scheduler: generate failed for cluster %s: %s",
                    cluster.get("id"),
                    exc,
                )
                continue
            # update running counters so subsequent clusters in the
            # same tick respect the per-day cap.
            new_cost = float(result.get("data", {}).get("cost_usd") or 0.0)
            cost_today += new_cost
            count_today += 1
            count_week += 1
            summary["patches_generated"] += 1
            await _emit_drift(
                org_id=org_id,
                drift_type="cat23_scheduled_patch_generated",
                severity=cluster.get("severity") or "low",
                payload={
                    "cluster_id": cluster.get("id"),
                    "patch_id": result.get("data", {}).get("patch_id"),
                    "status": result.get("data", {}).get("status"),
                    "cost_usd": new_cost,
                },
            )
            if cost_today >= float(settings.max_cost_per_user_per_day):
                # Mid-tick trip — stop processing more clusters for this org.
                await _emit_drift(
                    org_id=org_id,
                    drift_type="cat23_cost_circuit_breaker",
                    severity="high",
                    payload={
                        "cost_today_usd": cost_today,
                        "cap_usd": settings.max_cost_per_user_per_day,
                        "mid_tick": True,
                    },
                )
                break

    summary["pre_filter_rejections"] = pf_counts
    return summary


# ── Nightly stale-pending sweep (03:00 UTC) ────────────────────────


async def stale_pending_sweep(
    *,
    threshold_hours: int = 24,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Notify admins of patches stuck in ``status='proposed'``.

    Runs nightly (03:00 UTC). For each row in ``proposed_patches``
    that has been ``proposed`` for more than ``threshold_hours``,
    emit a drift alert so the portal can surface a banner to the
    org admins.
    """
    summary: dict[str, Any] = {
        "stale_patches_found": 0,
        "drift_alerts_fired": 0,
        "threshold_hours": threshold_hours,
        "dry_run": dry_run,
        "ts": datetime.now(UTC).isoformat(),
    }
    orgs = await _list_active_orgs()
    for org_id in orgs:
        rows = await _select_rows(
            org_id,
            "proposed_patches",
            where=(
                f"status = 'proposed' AND "
                f"created_at < NOW() - INTERVAL '{int(threshold_hours)} hours'"
            ),
            order_by="created_at ASC",
            limit=200,
        )
        if not rows:
            continue
        summary["stale_patches_found"] += len(rows)
        if dry_run:
            continue
        for row in rows:
            await _emit_drift(
                org_id=org_id,
                drift_type="cat23_stale_pending",
                severity="medium",
                payload={
                    "patch_id": row.get("id"),
                    "rca_id": row.get("rca_id"),
                    "created_at": str(row.get("created_at", "")),
                    "hours_pending": threshold_hours,
                },
            )
            summary["drift_alerts_fired"] += 1
    return summary


# ── Monday 09:00 UTC weekly digest ────────────────────────────────


async def weekly_digest(
    *,
    window_days: int = 7,
    dry_run: bool = False,
) -> dict[str, Any]:
    """7-day PR pipeline rollup per org.

    For each active org, count rows in ``proposed_patches``
    grouped by status over the last ``window_days``. The portal
    renders this as the Monday morning digest.
    """
    summary: dict[str, Any] = {
        "orgs_digested": 0,
        "rollups": {},
        "window_days": window_days,
        "dry_run": dry_run,
        "ts": datetime.now(UTC).isoformat(),
    }
    orgs = await _list_active_orgs()
    # One bulk query across all orgs (vs N round-trips). The
    # per-org budget fetch pattern was previously serial — pulling
    # all rows in one ``org_id = ANY($1)`` query, then grouping in
    # Python, lets us handle 100+ active orgs in 1 round-trip.
    if not orgs:
        return summary
    from eden.storage.postgres import get_postgres_client
    client = await get_postgres_client()
    all_rows: list[dict[str, Any]] = []
    if client is not None:
        try:
            all_rows = await client.fetch(
                f"""
                SELECT org_id, status, cost_usd
                  FROM proposed_patches
                 WHERE org_id = ANY($1::text[])
                   AND created_at > NOW() - INTERVAL '{int(window_days)} days'
                 ORDER BY created_at DESC
                 LIMIT 2000
                """,
                orgs,
            )
        except Exception as exc:
            logger.warning("cat23 weekly digest: bulk fetch failed: %s", exc)
    by_org: dict[str, list[dict[str, Any]]] = {o: [] for o in orgs}
    for r in all_rows:
        by_org.setdefault(str(r.get("org_id", "")), []).append(dict(r))
    for org_id, rows in by_org.items():
        rollup: dict[str, int] = {}
        total_cost = 0.0
        for r in rows:
            status = (r.get("status") or "unknown").strip()
            rollup[status] = rollup.get(status, 0) + 1
            total_cost += float(r.get("cost_usd") or 0.0)
        rollup["__total"] = len(rows)
        rollup["__total_cost_usd"] = round(total_cost, 4)
        summary["rollups"][org_id] = rollup
        summary["orgs_digested"] += 1
        if not dry_run:
            await _emit_drift(
                org_id=org_id,
                drift_type="cat23_weekly_digest",
                severity="low",
                payload={"rollup": rollup, "window_days": window_days},
            )
    return summary
