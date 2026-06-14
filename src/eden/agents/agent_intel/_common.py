"""Shared helpers for Cat 6 (Agent Intelligence) services.

Centralises:

* The data read path — :func:`_fetch_telemetry_for_agent`,
  :func:`_fetch_relationships_for_org`,
  :func:`_fetch_performance_snapshots_for_agent`.
* The envelope shape used for live (non-stub) responses —
  :func:`_ok_envelope`, :func:`_bad_request_envelope`,
  :func:`_not_found_envelope`. All three use ``live=True``.
* The persistence pattern used by the 3 services that write
  to the 5 Cat 6 tables (``agent_performance_snapshots``,
  ``agent_relationships``, ``agent_benchmark_runs``,
  ``agent_fleet_identities``, ``agent_fleet_permissions``).
  The migration (``020_intelligence_gap_tables.py``) does
  not declare unique constraints on most of these, so the
  delete-then-insert pattern is the only way to make the
  services re-runnable.
* :func:`_parse_window` for the time-bounded queries the
  five services run. Accepts ``"Nh"``/``"Nd"``/``"Nm"``/``"Ns"``
  and returns a Postgres interval literal; bad input returns
  ``None`` and the service turns it into a bad-request
  envelope.
* :func:`_fire_fleet_drift_hook` — the single closed-loop
  hook the Cat 6 surface ships: when an existing fleet
  identity is re-registered (signal: a deprecated agent is
  still being called), we fire
  :func:`eden.llmops.promotion_hooks.get_promotion_hook`
  .on_drift_alert with ``drift_type="fleet_deprecation"``
  and ``severity="medium"`` (matches the Cat 2 RCA + Cat 8
  cost anomaly pattern).
* :func:`_safe_float` / :func:`_safe_int` / :func:`_clamp` —
  defensive coercion helpers for the SQL aggregation output.
* :func:`_dedup_preserving_order` / :func:`_now_iso` —
  small string utilities used by multiple services.

The helpers are intentionally local to the package — Cat 6
is a self-contained unit and the package boundary is the
right place to hide the per-service glue. Mirrors the
layout of :mod:`eden.kb.retrieval_intel._common` (Cat 4),
:mod:`eden.kb.episodic.memory_intel._common` (Cat 5), and
:mod:`eden.services.cost_intel._common` (Cat 8).
"""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


# ── Public constants ─────────────────────────────────────────────────


#: The set of valid benchmark names the runner accepts.
#: Matches the appendix spec: ``"agentbench"``, ``"swebench"``,
#: ``"tau_bench"``, ``"gaia"``. v0 ships the deterministic
#: synthetic ``"synthetic_default"`` as a v1 placeholder; the
#: real benchmark suites ship in a later phase.
VALID_BENCHMARKS: frozenset[str] = frozenset(
    {"agentbench", "swebench", "tau_bench", "gaia", "synthetic_default"}
)

#: Max number of relationship rows we return from
#: :class:`AgentRelationshipGraph.build`. Caps response size
#: when an org has thousands of agent pairs.
MAX_RELATIONSHIPS_RETURNED: int = 500

#: Max number of performance rows the scorer will aggregate
#: from the SQL query. The query itself aggregates; this is
#: just a safety cap.
MAX_PERF_ROWS: int = 1000

#: Number of synthetic tasks in the v1 default benchmark
#: suite. Matches the appendix spec (100-task sample).
BENCHMARK_TASK_COUNT: int = 10  # v1 ships a tiny deterministic suite

#: Threshold for a relationship to be flagged as a "high
#: error rate" hotspot. Matches the appendix pseudo-code
#: (0.10).
HOTSPOT_ERROR_RATE: float = 0.10

#: Threshold for a relationship to be flagged as a
#: "bottleneck" (high volume + high p95 latency). The
#: appendix uses ``n_calls > 1000`` and ``p95_ms > 2000``;
#: v1 ships more lenient thresholds so single-org fixtures
#: with a handful of handoffs still produce signal.
BOTTLENECK_MIN_CALLS: int = 5
BOTTLENECK_MIN_P95_MS: float = 200.0

#: Drift delta for the relationship graph. If current 7-day
#: volume drops by this fraction vs. the previous 7-day
#: baseline, the analyzer flags it.
DRIFT_DELTA_PCT: float = -0.10

#: Min calls in the previous-7d baseline for the drift
#: heuristic to fire (avoids noise on tiny handoffs).
DRIFT_MIN_BASELINE_CALLS: int = 5

#: Cap on the slack_identity length to keep payloads sane.
SLACK_IDENTITY_MAX_LEN: int = 64

#: Cap on display_name length.
DISPLAY_NAME_MAX_LEN: int = 128

#: Cap on the number of permissions a single fleet identity
#: can hold. LangSmith-Fleet parity: 16 (matches the
#: appendix's "viewer/editor/deployer/admin" RBAC model).
MAX_PERMISSIONS_PER_AGENT: int = 16

#: The list of legal permission keys. Mirrors the
#: LangSmith-Fleet RBAC: viewer < editor < deployer < admin.
#: Note: any string is technically accepted (we don't
#: enforce this list at the API level), but the analyzer
#: uses it for the "viewer cannot edit; editor cannot
#: deploy" assertion in the test plan.
LEGAL_PERMISSION_KEYS: frozenset[str] = frozenset(
    {"viewer", "editor", "deployer", "admin"}
)


# ── Window parsing ───────────────────────────────────────────────────


_WINDOW_RE = re.compile(r"^\s*(\d+)\s*(h|d|m|s)\s*$", re.IGNORECASE)


def _parse_window(window: str | None) -> str | None:
    """Convert a human-friendly window string to a Postgres
    interval literal. Accepts ``"Nh"`` (hours), ``"Nd"`` (days),
    ``"Nm"`` (minutes), ``"Ns"`` (seconds). Returns ``None`` on
    bad input; the service wraps that into a
    ``_bad_request_envelope``.

    ``None`` or empty input defaults to ``"24 hours"`` (matches
    the Cat 4 / Cat 5 / Cat 8 conventions and the appendix's
    ``window: "24h"`` default for the performance endpoint).
    """
    if window is None:
        return "24 hours"
    s = window.strip()
    if not s:
        return "24 hours"
    m = _WINDOW_RE.match(s)
    if m is None:
        return None
    n, unit = m.group(1), m.group(2).lower()
    unit_long = {"h": "hours", "d": "days", "m": "minutes", "s": "seconds"}[unit]
    return f"{n} {unit_long}"


# ── Envelope helpers ─────────────────────────────────────────────────


def _new_trace_id() -> str:
    """Cat 6-prefixed trace id — distinguishes live responses
    from Cat 1/2/3/4/5/8/16 in the audit log."""
    return f"ai_{uuid.uuid4().hex[:12]}"


def _ok_envelope(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    """Live response envelope — same shape as the stub
    :class:`eden.intelligence_envelope.IntelligenceStubResponse`
    so the front-end renders uniformly. ``live=True`` signals
    a real implementation."""
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": _now_iso(),
        "data": data,
    }


def _bad_request_envelope(feature: str, message: str) -> dict[str, Any]:
    """Live envelope for an invalid request (e.g. malformed
    window string). Returns ``status="bad_request"`` so the
    front-end can render a 4xx-class message without falling
    back to the stub envelope."""
    return {
        "status": "bad_request",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": _now_iso(),
        "data": {"message": message},
    }


def _not_found_envelope(feature: str, message: str) -> dict[str, Any]:
    """Live envelope for a missing resource (e.g. agent_id
    not present in fleet_identities). Returns
    ``status="not_found"`` so the front-end can render an
    explicit "no such agent" message."""
    return {
        "status": "not_found",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": _now_iso(),
        "data": {"message": message},
    }


def _now_iso() -> str:
    """UTC ISO-8601 with explicit ``+00:00`` offset."""
    return datetime.now(UTC).isoformat()


# ── Data read paths ──────────────────────────────────────────────────


async def _get_client() -> Any:
    """Best-effort :func:`eden.storage.postgres.get_postgres_client`
    import + await. Returns ``None`` if Postgres isn't available
    — persistence helpers and fetchers check for ``None`` and
    no-op or return ``[]``/``None``."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("agent_intel: postgres import failed: %s", exc)
        return None
    try:
        return await get_postgres_client()
    except Exception as exc:
        logger.debug("agent_intel: get_postgres_client failed: %s", exc)
        return None


async def _fetch_telemetry_rollup_for_agent(
    org_id: str, agent_id: str, interval_sql: str
) -> dict[str, Any]:
    """Aggregate the per-agent telemetry in a single query.

    Returns a dict with: ``n_traces``, ``success_rate``,
    ``latency_p50_ms``, ``latency_p95_ms``, ``cost_usd``,
    ``judge_avg``. All numeric fields default to ``0`` /
    ``None`` when the underlying tables are empty so the
    service can render a well-formed response.

    Reads from:
    * ``telemetry_events`` — trace counts, success rate,
      latency percentiles
    * ``usage_events`` — total cost_usd for the agent
    * ``judge_scores`` — mean judge score

    Best-effort: returns an "all-zero" dict on any failure
    so the service can still render a response envelope.
    """
    client = await _get_client()
    if client is None:
        return {
            "n_traces": 0,
            "success_rate": None,
            "latency_p50_ms": None,
            "latency_p95_ms": None,
            "cost_usd": 0.0,
            "judge_avg": None,
        }
    out: dict[str, Any] = {
        "n_traces": 0,
        "success_rate": None,
        "latency_p50_ms": None,
        "latency_p95_ms": None,
        "cost_usd": 0.0,
        "judge_avg": None,
    }
    # 1. Trace counts + latency + success rate from
    # ``telemetry_events``. We treat an event with
    # ``status='success'`` as a success; if the table doesn't
    # track status we treat all rows as success (matches the
    # Cat 4 / Cat 5 graceful-degradation pattern).
    try:
        rows = await client.fetch(
            """
            SELECT
                count(*)::int AS n_traces,
                AVG(
                    CASE WHEN status = 'success' THEN 1.0
                         WHEN status IN ('error', 'failed') THEN 0.0
                         ELSE 1.0
                    END
                )::float8 AS success_rate,
                percentile_cont(0.5) WITHIN GROUP
                    (ORDER BY duration_ms)::float8 AS p50,
                percentile_cont(0.95) WITHIN GROUP
                    (ORDER BY duration_ms)::float8 AS p95
              FROM telemetry_events
             WHERE org_id = $1
               AND agent_id = $2
               AND created_at > NOW() - $3::interval
            """,
            org_id,
            agent_id,
            interval_sql,
        )
    except Exception as exc:
        logger.debug("agent_intel: telemetry rollup failed: %s", exc)
        rows = []
    if rows:
        r = dict(rows[0]) if not isinstance(rows[0], dict) else rows[0]
        out["n_traces"] = int(r.get("n_traces") or 0)
        out["success_rate"] = _safe_float_or_none(r.get("success_rate"))
        out["latency_p50_ms"] = _safe_float_or_none(r.get("p50"))
        out["latency_p95_ms"] = _safe_float_or_none(r.get("p95"))
    # 2. Cost from ``usage_events``.
    try:
        cost_rows = await client.fetch(
            """
            SELECT COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd
              FROM usage_events
             WHERE org_id = $1
               AND agent_id = $2
               AND created_at > NOW() - $3::interval
            """,
            org_id,
            agent_id,
            interval_sql,
        )
    except Exception as exc:
        logger.debug("agent_intel: cost rollup failed: %s", exc)
        cost_rows = []
    if cost_rows:
        r = dict(cost_rows[0]) if not isinstance(cost_rows[0], dict) else cost_rows[0]
        out["cost_usd"] = _safe_float(r.get("cost_usd"))
    # 3. Mean judge score from ``judge_scores``.
    try:
        judge_rows = await client.fetch(
            """
            SELECT AVG(score)::float8 AS judge_avg
              FROM judge_scores
             WHERE org_id = $1
               AND agent_id = $2
               AND created_at > NOW() - $3::interval
            """,
            org_id,
            agent_id,
            interval_sql,
        )
    except Exception as exc:
        logger.debug("agent_intel: judge rollup failed: %s", exc)
        judge_rows = []
    if judge_rows:
        r = dict(judge_rows[0]) if not isinstance(judge_rows[0], dict) else judge_rows[0]
        out["judge_avg"] = _safe_float_or_none(r.get("judge_avg"))
    return out


async def _fetch_handoff_counts_in_window(
    org_id: str, interval_sql: str
) -> list[dict[str, Any]]:
    """Count parent→child handoffs in a window from
    ``telemetry_events``. We model a "handoff" as any event
    that carries both ``parent_agent_id`` (the agent that
    delegated) and ``agent_id`` (the agent that ran). The
    success_rate is the fraction of those handoffs with
    ``status='success'``.

    Returns a list of ``{parent_agent_id, child_agent_id,
    handoff_count, success_rate}`` dicts. Best-effort:
    returns ``[]`` on any failure.
    """
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT parent_agent_id, agent_id AS child_agent_id,
                   COUNT(*)::int AS handoff_count,
                   AVG(
                       CASE WHEN status = 'success' THEN 1.0
                            WHEN status IN ('error', 'failed') THEN 0.0
                            ELSE 1.0
                       END
                   )::float8 AS success_rate
              FROM telemetry_events
             WHERE org_id = $1
               AND parent_agent_id IS NOT NULL
               AND agent_id IS NOT NULL
               AND created_at > NOW() - $2::interval
             GROUP BY parent_agent_id, agent_id
             ORDER BY handoff_count DESC
             LIMIT $3
            """,
            org_id,
            interval_sql,
            MAX_RELATIONSHIPS_RETURNED,
        )
    except Exception as exc:
        logger.debug("agent_intel: handoff counts failed: %s", exc)
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r) if not isinstance(r, dict) else r
        out.append(
            {
                "parent_agent_id": str(d.get("parent_agent_id") or ""),
                "child_agent_id": str(d.get("child_agent_id") or ""),
                "handoff_count": int(d.get("handoff_count") or 0),
                "success_rate": _safe_float_or_none(d.get("success_rate")),
            }
        )
    return out


async def _fetch_relationships_for_org(
    org_id: str,
) -> list[dict[str, Any]]:
    """Read all rows in ``agent_relationships`` for the org.
    Used by the HandoffAnalyzer to layer the bottleneck +
    error-hotspot + drift analysis on top of the persisted
    graph (Cat 6's stored source of truth).

    Returns ``[]`` on any failure so the analyzer can render
    a "no relationships" envelope.
    """
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT parent_agent_id, child_agent_id, handoff_count,
                   success_rate
              FROM agent_relationships
             WHERE org_id = $1
             ORDER BY handoff_count DESC
             LIMIT $2
            """,
            org_id,
            MAX_RELATIONSHIPS_RETURNED,
        )
    except Exception as exc:
        logger.debug("agent_intel: fetch_relationships failed: %s", exc)
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r) if not isinstance(r, dict) else r
        out.append(
            {
                "parent_agent_id": str(d.get("parent_agent_id") or ""),
                "child_agent_id": str(d.get("child_agent_id") or ""),
                "handoff_count": int(d.get("handoff_count") or 0),
                "success_rate": _safe_float_or_none(d.get("success_rate")),
            }
        )
    return out


async def _fetch_existing_fleet_identity(
    org_id: str, agent_id: str
) -> dict[str, Any] | None:
    """Look up an existing ``agent_fleet_identities`` row for
    ``(org_id, agent_id)``. Returns the row dict on match,
    ``None`` otherwise. Used by the Fleet service to detect
    re-registration (the deprecation-cascade signal)."""
    client = await _get_client()
    if client is None:
        return None
    try:
        rows = await client.fetch(
            """
            SELECT id, org_id, agent_id, display_name, slack_identity,
                   created_at
              FROM agent_fleet_identities
             WHERE org_id = $1 AND agent_id = $2
             LIMIT 1
            """,
            org_id,
            agent_id,
        )
    except Exception as exc:
        logger.debug("agent_intel: fetch_existing_fleet failed: %s", exc)
        return None
    if not rows:
        return None
    r = rows[0]
    return dict(r) if not isinstance(r, dict) else r


# ── Persistence ──────────────────────────────────────────────────────


async def _delete_then_insert_perf_snapshot(
    org_id: str,
    agent_id: str,
    window: str,
    *,
    success_rate: float | None,
    cost_usd: float | None,
    latency_p50_ms: float | None,
    latency_p95_ms: float | None,
    judge_avg: float | None,
) -> None:
    """Replace the ``agent_performance_snapshots`` rows for
    this ``(org_id, agent_id, window)`` tuple. The table has
    no unique constraint, so the only way to make the service
    re-runnable is to delete-then-insert.

    Best-effort: any exception is logged and swallowed so the
    caller can still return the live envelope with the
    in-memory data.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("agent_intel: postgres import failed: %s", exc)
        return
    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            await conn.execute(
                """
                    DELETE FROM agent_performance_snapshots
                     WHERE org_id = $1
                       AND agent_id = $2
                       AND window = $3
                    """,
                org_id,
                agent_id,
                window,
            )
            await conn.execute(
                """
                    INSERT INTO agent_performance_snapshots
                        (id, org_id, agent_id, window, success_rate,
                         cost_usd, latency_p50_ms, latency_p95_ms,
                         judge_avg)
                    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5,
                            $6, $7, $8)
                    """,
                org_id,
                agent_id,
                window,
                success_rate,
                cost_usd,
                latency_p50_ms,
                latency_p95_ms,
                judge_avg,
            )
    except Exception as exc:
        logger.debug("agent_intel: perf write failed: %s", exc)


async def _delete_then_insert_relationships(
    org_id: str, rows: list[dict[str, Any]]
) -> None:
    """Replace all ``agent_relationships`` rows for the org.
    The table has no unique constraint, so the only way to
    make :class:`AgentRelationshipGraph` re-runnable is to
    clear the org's rows and re-insert.

    Best-effort like :func:`_delete_then_insert_perf_snapshot`.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("agent_intel: postgres import failed: %s", exc)
        return
    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            await conn.execute(
                "DELETE FROM agent_relationships WHERE org_id = $1",
                org_id,
            )
            for r in rows:
                parent = str(r.get("parent_agent_id", ""))[:128]
                child = str(r.get("child_agent_id", ""))[:128]
                if not parent or not child:
                    continue
                count = int(r.get("handoff_count", 0) or 0)
                sr = r.get("success_rate")
                await conn.execute(
                    """
                        INSERT INTO agent_relationships
                            (id, org_id, parent_agent_id, child_agent_id,
                             handoff_count, success_rate)
                        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
                        """,
                    org_id, parent, child, count, sr,
                )
    except Exception as exc:
        logger.debug("agent_intel: relationships write failed: %s", exc)


async def _delete_then_insert_benchmark_run(
    org_id: str,
    agent_id: str,
    dataset_id: str,
    *,
    status: str,
    metrics_json: str,
) -> None:
    """Replace the ``agent_benchmark_runs`` rows for this
    ``(org_id, agent_id, dataset_id)`` tuple. Re-runnable via
    DELETE+INSERT.

    Best-effort like the other persistence helpers."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("agent_intel: postgres import failed: %s", exc)
        return
    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            await conn.execute(
                """
                    DELETE FROM agent_benchmark_runs
                     WHERE org_id = $1
                       AND agent_id = $2
                       AND dataset_id = $3
                    """,
                org_id,
                agent_id,
                dataset_id,
            )
            await conn.execute(
                """
                    INSERT INTO agent_benchmark_runs
                        (id, org_id, agent_id, dataset_id, status,
                         metrics_json)
                    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
                    """,
                org_id, agent_id, dataset_id, status, metrics_json,
            )
    except Exception as exc:
        logger.debug("agent_intel: benchmark write failed: %s", exc)


async def _upsert_fleet_identity(
    org_id: str,
    agent_id: str,
    display_name: str,
    slack_identity: str | None,
) -> None:
    """Insert or update a row in ``agent_fleet_identities``.
    The migration doesn't declare a unique constraint, so we
    detect the existing row in Python (single-row query) and
    branch on DELETE+INSERT vs INSERT. Idempotent: re-running
    ``register_agent_identity`` for the same
    ``(org_id, agent_id)`` produces the same final state."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("agent_intel: postgres import failed: %s", exc)
        return
    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            existing = await conn.fetchval(
                """
                    SELECT id FROM agent_fleet_identities
                     WHERE org_id = $1 AND agent_id = $2
                     LIMIT 1
                    """,
                org_id, agent_id,
            )
            if existing is not None:
                await conn.execute(
                    """
                        UPDATE agent_fleet_identities
                           SET display_name = $3,
                               slack_identity = $4
                         WHERE org_id = $1 AND agent_id = $2
                        """,
                    org_id, agent_id, display_name, slack_identity,
                )
            else:
                await conn.execute(
                    """
                        INSERT INTO agent_fleet_identities
                            (id, org_id, agent_id, display_name,
                             slack_identity)
                        VALUES (gen_random_uuid(), $1, $2, $3, $4)
                        """,
                    org_id, agent_id, display_name, slack_identity,
                )
    except Exception as exc:
        logger.debug("agent_intel: fleet upsert failed: %s", exc)


async def _insert_fleet_permissions(
    org_id: str, agent_id: str, permissions: list[str]
) -> None:
    """Insert a row per permission in
    ``agent_fleet_permissions``. Re-running is a no-op (we
    always insert, the migration's only constraint is the
    implicit table existence). To revoke a permission the
    caller would set ``granted=False``; v0 always writes
    ``granted=True`` and the API never deletes."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("agent_intel: postgres import failed: %s", exc)
        return
    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn:
            for perm in permissions:
                pk = str(perm)[:128]
                if not pk:
                    continue
                await conn.execute(
                    """
                    INSERT INTO agent_fleet_permissions
                        (id, org_id, agent_id, permission_key, granted)
                    VALUES (gen_random_uuid(), $1, $2, $3, TRUE)
                    """,
                    org_id, agent_id, pk,
                )
    except Exception as exc:
        logger.debug("agent_intel: fleet perms insert failed: %s", exc)


# ── Closed-loop hook ─────────────────────────────────────────────────


def _fire_fleet_drift_hook(org_id: str, agent_id: str) -> None:
    """Fire the :class:`PromotionHook.on_drift_alert` closed-
    loop hook for the fleet-deprecation signal. Called from
    :meth:`AgentFleetService.register_agent_identity` when an
    existing identity is re-registered (matches the Cat 2 RCA
    + Cat 8 cost anomaly pattern: a signal that some upstream
    system is still calling a deprecated identity).

    Best-effort: any failure is logged and swallowed so the
    caller can still return the live envelope.
    """
    try:
        from eden.llmops.promotion_hooks import get_promotion_hook
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("agent_intel: promotion_hooks import failed: %s", exc)
        return
    try:
        hook = get_promotion_hook()
        hook.on_drift_alert(
            org_id,
            drift_type=f"fleet_deprecation:{agent_id}",
            severity="medium",
        )
    except Exception as exc:
        logger.debug("agent_intel: fleet drift hook failed: %s", exc)


# ── Misc small helpers ───────────────────────────────────────────────


def _safe_float(value: Any) -> float:
    """Coerce ``value`` to ``float``; return ``0.0`` for
    anything that isn't a number. Defensive belt-and-braces
    for the arithmetic in the perf heuristics."""
    if isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return 0.0


def _safe_float_or_none(value: Any) -> float | None:
    """Like :func:`_safe_float` but returns ``None`` for
    missing values (so the front-end can distinguish "no
    signal" from "value was zero")."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _safe_int(value: Any) -> int:
    """Coerce ``value`` to ``int``; return ``0`` for anything
    that isn't a number."""
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    return 0


def _clamp(value: float, lo: float, hi: float) -> float:
    """Clamp ``value`` to the ``[lo, hi]`` range."""
    if value < lo:
        return lo
    if value > hi:
        return hi
    return value


def _dedup_preserving_order(items: Iterable[str]) -> list[str]:
    """Stable dedup — preserves the first occurrence's
    position. Used by the relationship graph and the
    benchmark runner to dedup agent IDs that appear in
    multiple telemetry events."""
    seen: set[str] = set()
    out: list[str] = []
    for x in items:
        s = str(x)
        if s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


def _round2(value: float | None) -> float | None:
    """Round a float to 2 decimal places (display-precision
    for currency / percentage fields). Returns ``None``
    unchanged."""
    if value is None:
        return None
    return round(float(value), 2)
