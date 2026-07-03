"""Agent Intelligence services (Cat 6) — real implementations.

Five services:

* :class:`AgentPerformanceScorer` — per-agent success / cost /
  latency / judge averages over a time window. Reads from
  ``telemetry_events`` (trace count, latency percentiles,
  success rate), ``usage_events`` (cost_usd), and
  ``judge_scores`` (mean judge score). Persists one
  ``agent_performance_snapshots`` row per
  ``(org, agent, window)`` tuple.

* :class:`AgentRelationshipGraph` — builds the multi-agent
  handoff graph by counting ``parent_agent_id → agent_id``
  pairs in ``telemetry_events`` for the requested window.
  Persists one row per pair to
  ``agent_relationships``. Idempotent: clear-then-insert.

* :class:`HandoffAnalyzer` — reads the persisted
  ``agent_relationships`` table and classifies each edge as
  one of: ``bottleneck`` (high volume + high implicit
  latency — note: v0 doesn't have per-edge latency, so the
  "high latency" criterion is met by a high ``handoff_count``
  + the appendix's volume threshold), ``error_hotspot``
  (success_rate below the threshold), or
  ``drift_indicator`` (current 7d volume vs. previous 7d
  baseline, recomputed on the fly from
  ``telemetry_events``). The Cat 6 HandoffAnalyzer does NOT
  persist its analysis (the data lives in
  ``agent_relationships`` already; the analyzer is a view,
  not a sink).

* :class:`AgentBenchmarkRunner` — runs a tiny deterministic
  synthetic benchmark for the requested ``agent_id`` and
  ``dataset_id``. Persists one row to
  ``agent_benchmark_runs`` per ``(org, agent, dataset)``
  tuple. v0 ships a synthetic_default suite of
  ``BENCHMARK_TASK_COUNT`` tasks; the real AgentBench /
  SWE-bench / τ-bench / GAIA suites ship in a later phase.

* :class:`AgentFleetService` — LangSmith-Fleet-style
  identity + permissions for agents. Two endpoints:
  ``register_agent_identity`` (insert or update
  ``agent_fleet_identities``) and ``assign_permissions``
  (insert one ``agent_fleet_permissions`` row per
  permission). When a re-registration hits an existing
  identity, the closed-loop
  :func:`_fire_fleet_drift_hook` fires
  ``PromotionHook.on_drift_alert(drift_type="fleet_deprecation:...",
  severity="medium")`` — matches the Cat 2 RCA + Cat 8 cost
  anomaly pattern.

All five services degrade gracefully when their dependencies
are missing or empty (see :mod:`._common` for the helper
that fetches the Postgres client and swallows errors).

See ``docs/observability-gap/06-agent-intelligence.md``.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from ._common import (
    BENCHMARK_TASK_COUNT,
    BOTTLENECK_MIN_CALLS,
    DISPLAY_NAME_MAX_LEN,
    DRIFT_DELTA_PCT,
    DRIFT_MIN_BASELINE_CALLS,
    HOTSPOT_ERROR_RATE,
    MAX_PERMISSIONS_PER_AGENT,
    SLACK_IDENTITY_MAX_LEN,
    VALID_BENCHMARKS,
    _bad_request_envelope,
    _delete_then_insert_benchmark_run,
    _delete_then_insert_perf_snapshot,
    _delete_then_insert_relationships,
    _fetch_existing_fleet_identity,
    _fetch_handoff_counts_in_window,
    _fetch_relationships_for_org,
    _fetch_telemetry_rollup_for_agent,
    _fire_fleet_drift_hook,
    _insert_fleet_permissions,
    _not_found_envelope,
    _now_iso,
    _ok_envelope,
    _parse_window,
    _round2,
    _safe_float,
    _safe_float_or_none,
    _safe_int,
    _upsert_fleet_identity,
)

logger = logging.getLogger(__name__)


# ── 1. AgentPerformanceScorer ────────────────────────────────────────


class AgentPerformanceScorer:
    """Per-agent success / cost / latency / judge averages
    over a time window.

    Reads from ``telemetry_events`` + ``usage_events`` +
    ``judge_scores`` for the requested ``agent_id`` and
    ``window``, and persists one
    ``agent_performance_snapshots`` row per
    ``(org, agent, window)`` tuple (delete-then-insert for
    re-runnability).

    The :attr:`name` is ``"agent_performance"``.
    """

    name = "agent_performance"

    async def score(
        self,
        org_id: str,
        agent_id: str,
        *,
        window: str = "24h",
    ) -> dict[str, Any]:
        if not agent_id or not str(agent_id).strip():
            return _bad_request_envelope(
                self.name, "agent_id must be a non-empty string"
            )
        agent_id = str(agent_id).strip()[:128]

        interval = _parse_window(window)
        if interval is None:
            return _bad_request_envelope(
                self.name,
                f"invalid window {window!r}; expected e.g. '24h', '7d'",
            )

        rollup = await _fetch_telemetry_rollup_for_agent(
            org_id, agent_id, interval
        )

        # The cost-per-call is the live response's "per-trace"
        # view; the persisted snapshot keeps the total.
        n_traces = _safe_int(rollup.get("n_traces"))
        cost_total = _safe_float(rollup.get("cost_usd"))
        cost_per_call = (
            round(cost_total / n_traces, 4) if n_traces > 0 else 0.0
        )

        # Persist (best-effort).
        await _delete_then_insert_perf_snapshot(
            org_id,
            agent_id,
            window,
            success_rate=_safe_float_or_none(rollup.get("success_rate")),
            cost_usd=cost_total,
            latency_p50_ms=_safe_float_or_none(rollup.get("latency_p50_ms")),
            latency_p95_ms=_safe_float_or_none(rollup.get("latency_p95_ms")),
            judge_avg=_safe_float_or_none(rollup.get("judge_avg")),
        )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "agent_id": agent_id,
                "window": window,
                "n_traces": n_traces,
                "success_rate": _round2(
                    _safe_float_or_none(rollup.get("success_rate"))
                ),
                "latency_p50_ms": _round2(
                    _safe_float_or_none(rollup.get("latency_p50_ms"))
                ),
                "latency_p95_ms": _round2(
                    _safe_float_or_none(rollup.get("latency_p95_ms"))
                ),
                "cost_total_usd": _round2(cost_total) or 0.0,
                "cost_per_call_usd": _round2(cost_per_call) or 0.0,
                "judge_avg": _round2(
                    _safe_float_or_none(rollup.get("judge_avg"))
                ),
            },
        )


# ── 2. AgentRelationshipGraph ────────────────────────────────────────


class AgentRelationshipGraph:
    """Build the multi-agent handoff graph for an org over
    a time window.

    Groups ``telemetry_events`` by
    ``(parent_agent_id, agent_id)`` and persists one row per
    pair to ``agent_relationships``. Idempotent: clear-then-
    insert per org.

    The :attr:`name` is ``"agent_relationships"``.
    """

    name = "agent_relationships"

    async def build(
        self,
        org_id: str,
        *,
        window: str = "7d",
    ) -> dict[str, Any]:
        interval = _parse_window(window)
        if interval is None:
            return _bad_request_envelope(
                self.name,
                f"invalid window {window!r}; expected e.g. '7d', '30d'",
            )

        handoffs = await _fetch_handoff_counts_in_window(org_id, interval)
        if not handoffs:
            # No handoffs in the window — persist an empty
            # graph (clear-then-insert) and return the empty
            # result with a hint message. The HandoffAnalyzer
            # will short-circuit on the empty list.
            await _delete_then_insert_relationships(org_id, [])
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "window": window,
                    "n_relationships": 0,
                    "n_nodes": 0,
                    "nodes": [],
                    "relationships": [],
                    "message": "no handoffs in window",
                },
            )

        # Persist the rows (clear-then-insert).
        await _delete_then_insert_relationships(org_id, handoffs)

        # Build the response. The graph is a list of edges;
        # nodes are the union of parent + child IDs.
        relationships: list[dict[str, Any]] = []
        for h in handoffs:
            relationships.append(
                {
                    "parent_agent_id": h["parent_agent_id"],
                    "child_agent_id": h["child_agent_id"],
                    "handoff_count": int(h["handoff_count"]),
                    "success_rate": _round2(h.get("success_rate")),
                }
            )
        # Node set: every distinct agent that appears as
        # either parent or child.
        node_set: set[str] = set()
        for r in relationships:
            node_set.add(r["parent_agent_id"])
            node_set.add(r["child_agent_id"])
        nodes = sorted(node_set)

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "window": window,
                "n_relationships": len(relationships),
                "n_nodes": len(nodes),
                "nodes": nodes,
                "relationships": relationships,
            },
        )


# ── 3. HandoffAnalyzer ───────────────────────────────────────────────


class HandoffAnalyzer:
    """Read the persisted ``agent_relationships`` table and
    classify each edge as one of: ``bottleneck`` (high
    volume + low success rate OR high volume alone when
    latency signal is missing), ``error_hotspot``
    (``success_rate`` below :data:`HOTSPOT_ERROR_RATE`), or
    ``drift_indicator`` (current 7-day volume vs. previous
    7-day baseline).

    The v0 analyzer does NOT persist its analysis (the
    source-of-truth lives in ``agent_relationships`` already;
    the analyzer is a read-only view). The output is a
    per-edge label so the operator can pivot the response
    into the four categories from the appendix:

    * ``bottleneck_handoffs`` — high volume + (low success OR
      — in v0, which doesn't have per-edge latency in
      ``agent_relationships`` — volume alone above the
      ``BOTTLENECK_MIN_CALLS`` threshold).
    * ``error_hotspots`` — ``success_rate`` below
      :data:`HOTSPOT_ERROR_RATE`.
    * ``drift_indicators`` — current 7d volume dropped
      >= ``DRIFT_DELTA_PCT`` from the previous 7d baseline.

    The :attr:`name` is ``"agent_handoffs"``.
    """

    name = "agent_handoffs"

    async def analyze(
        self,
        org_id: str,
        *,
        from_agent: str = "",
        to_agent: str = "",
    ) -> dict[str, Any]:
        # No window parsing for v0 — the analyzer reads the
        # whole-org relationship graph. Filtering on
        # from_agent / to_agent is optional.
        rows = await _fetch_relationships_for_org(org_id)
        if not rows:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "from_agent": from_agent or None,
                    "to_agent": to_agent or None,
                    "bottleneck_handoffs": [],
                    "error_hotspots": [],
                    "drift_indicators": [],
                    "message": (
                        "no relationships — run "
                        "/intelligence/agents/relationships first"
                    ),
                },
            )

        # Filter on the optional from/to.
        from_filter = str(from_agent or "").strip()
        to_filter = str(to_agent or "").strip()
        if from_filter or to_filter:
            rows = [
                r
                for r in rows
                if (not from_filter or r["parent_agent_id"] == from_filter)
                and (not to_filter or r["child_agent_id"] == to_filter)
            ]

        # Drift signal: for each (parent, child) pair, compare
        # current 7d handoffs to the previous 7d baseline.
        # We read the current+previous counts from
        # ``telemetry_events`` on the fly so the analyzer
        # doesn't need a separate table.
        current_baseline = await _fetch_handoff_volume_buckets(org_id)
        drift: list[dict[str, Any]] = []
        for r in rows:
            key = (r["parent_agent_id"], r["child_agent_id"])
            cb = current_baseline.get(key)
            if cb is None:
                continue
            baseline = cb.get("previous", 0)
            current = cb.get("current", 0)
            if baseline < DRIFT_MIN_BASELINE_CALLS:
                continue
            if baseline <= 0:
                continue
            delta_pct = (current - baseline) / baseline
            if delta_pct <= DRIFT_DELTA_PCT:
                drift.append(
                    {
                        "parent_agent_id": r["parent_agent_id"],
                        "child_agent_id": r["child_agent_id"],
                        "n_baseline": baseline,
                        "n_current": current,
                        "delta_pct": _round2(delta_pct),
                        "alert": "volume_drop",
                    }
                )

        # Bottleneck: high volume + (low success rate OR —
        # when success_rate is missing — volume above the
        # threshold alone, so the heuristic still fires on
        # fixtures that don't have a success column).
        bottlenecks: list[dict[str, Any]] = []
        for r in rows:
            count = int(r["handoff_count"])
            sr = r.get("success_rate")
            if count < BOTTLENECK_MIN_CALLS:
                continue
            if sr is not None and sr < (1.0 - HOTSPOT_ERROR_RATE):
                bottlenecks.append(
                    {
                        "parent_agent_id": r["parent_agent_id"],
                        "child_agent_id": r["child_agent_id"],
                        "handoff_count": count,
                        "success_rate": _round2(sr),
                        "alert": "high_volume_low_success",
                    }
                )
            elif sr is None and count >= (BOTTLENECK_MIN_CALLS * 2):
                # No success-rate signal in the table — fall
                # back to a volume-only heuristic. The
                # threshold is intentionally higher so this
                # path doesn't generate noise on tiny handoffs.
                bottlenecks.append(
                    {
                        "parent_agent_id": r["parent_agent_id"],
                        "child_agent_id": r["child_agent_id"],
                        "handoff_count": count,
                        "success_rate": None,
                        "alert": "high_volume",
                    }
                )

        # Error hotspots: success_rate below threshold.
        hotspots: list[dict[str, Any]] = []
        for r in rows:
            sr = r.get("success_rate")
            if sr is None:
                continue
            if sr < (1.0 - HOTSPOT_ERROR_RATE):
                hotspots.append(
                    {
                        "parent_agent_id": r["parent_agent_id"],
                        "child_agent_id": r["child_agent_id"],
                        "handoff_count": int(r["handoff_count"]),
                        "success_rate": _round2(sr),
                        "alert": "low_success_rate",
                    }
                )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "from_agent": from_filter or None,
                "to_agent": to_filter or None,
                "bottleneck_handoffs": bottlenecks,
                "error_hotspots": hotspots,
                "drift_indicators": drift,
                "edges_analyzed": len(rows),
            },
        )


async def _fetch_handoff_volume_buckets(
    org_id: str,
) -> dict[tuple[str, str], dict[str, int]]:
    """For :class:`HandoffAnalyzer`'s drift heuristic: pull
    the per-edge current-7d and previous-7d handoff counts
    from ``telemetry_events`` in a single query. Returns a
    dict ``{(parent, child): {"current": int, "previous": int}}``.

    Best-effort: returns ``{}`` on any failure so the
    analyzer still produces a (drift-less) response.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("agent_intel: postgres import failed: %s", exc)
        return {}
    try:
        client = await get_postgres_client()
    except Exception as exc:
        logger.debug("agent_intel: get_postgres_client failed: %s", exc)
        return {}
    if client is None:
        return {}
    try:
        rows = await client.fetch(
            """
            SELECT parent_agent_id,
                   agent_id AS child_agent_id,
                   SUM(
                       CASE WHEN created_at > NOW() - INTERVAL '7 days'
                            THEN 1 ELSE 0 END
                   )::int AS current_count,
                   SUM(
                       CASE WHEN created_at <= NOW() - INTERVAL '7 days'
                            AND created_at > NOW() - INTERVAL '14 days'
                            THEN 1 ELSE 0 END
                   )::int AS previous_count
              FROM telemetry_events
             WHERE org_id = $1
               AND parent_agent_id IS NOT NULL
               AND agent_id IS NOT NULL
               AND created_at > NOW() - INTERVAL '14 days'
             GROUP BY parent_agent_id, agent_id
            """,
            org_id,
        )
    except Exception as exc:
        logger.debug("agent_intel: handoff volume buckets failed: %s", exc)
        return {}
    out: dict[tuple[str, str], dict[str, int]] = {}
    for r in rows:
        d = dict(r) if not isinstance(r, dict) else r
        parent = str(d.get("parent_agent_id") or "")
        child = str(d.get("child_agent_id") or "")
        if not parent or not child:
            continue
        out[(parent, child)] = {
            "current": int(d.get("current_count") or 0),
            "previous": int(d.get("previous_count") or 0),
        }
    return out


# ── 4. AgentBenchmarkRunner ──────────────────────────────────────────


class AgentBenchmarkRunner:
    """Run a small, deterministic benchmark for an agent.

    v0 ships a synthetic_default suite of
    :data:`BENCHMARK_TASK_COUNT` tasks. Each task is a
    fixed (input, expected_output) pair; the v0 runner
    doesn't actually invoke the agent (that requires the
    multi-agent executor to be on the hot path; deferred to
    v2). The score is a deterministic function of the
    ``agent_id`` + ``dataset_id`` strings so the same input
    produces the same output (idempotent, testable).

    Persists one ``agent_benchmark_runs`` row per
    ``(org, agent, dataset)`` tuple with ``status="completed"``
    and a JSON ``metrics`` payload. Re-runnable via
    DELETE+INSERT.

    The :attr:`name` is ``"agent_benchmark"``.
    """

    name = "agent_benchmark"

    async def run(
        self,
        org_id: str,
        agent_id: str,
        *,
        dataset_id: str = "synthetic_default",
    ) -> dict[str, Any]:
        if not agent_id or not str(agent_id).strip():
            return _bad_request_envelope(
                self.name, "agent_id must be a non-empty string"
            )
        agent_id = str(agent_id).strip()[:128]
        dataset_id = str(dataset_id or "synthetic_default").strip()[:128]
        if not dataset_id:
            dataset_id = "synthetic_default"

        # v0 ships a single synthetic benchmark name. Any
        # name not in VALID_BENCHMARKS is rejected so the
        # API doesn't silently accept typos.
        benchmark_name = dataset_id
        if benchmark_name not in VALID_BENCHMARKS:
            return _bad_request_envelope(
                self.name,
                f"unknown benchmark {benchmark_name!r}; "
                f"valid: {sorted(VALID_BENCHMARKS)}",
            )

        # Deterministic score: hash(agent_id + dataset_id) →
        # 0.50..0.99. Pure-Python, no RNG, no LLM. This is
        # the v1 placeholder; the real benchmark suites
        # (AgentBench, SWE-bench, τ-bench, GAIA) ship in
        # a later phase. Documented in the appendix and
        # the v0.5 Open Questions.
        h = abs(hash((agent_id, dataset_id)))
        score = 0.50 + (h % 50) / 100.0  # 0.50 .. 0.99

        # Audit 2026-07-03 B-24 — ``synthetic: True`` flag at both
        # the top level AND inside ``metrics``. The metrics payload
        # is persisted to ``agent_benchmark_runs.metrics_json`` and
        # later surfaced on the operator dashboard; consumers use
        # the in-metrics flag (NOT the response-only one) to decide
        # whether the row counts toward downstream ROI / regression
        # calculations. Without the in-metrics flag, real ops
        # decisions will end up trained on a synthetic fixture.
        metrics = {
            "benchmark": benchmark_name,
            "task_count": BENCHMARK_TASK_COUNT,
            "tasks_passed": int(score * BENCHMARK_TASK_COUNT),
            "tasks_failed": BENCHMARK_TASK_COUNT
            - int(score * BENCHMARK_TASK_COUNT),
            "score": round(score, 4),
            "ran_at": _now_iso(),
            "synthetic": True,
        }
        metrics_json = json.dumps(metrics, sort_keys=True)

        await _delete_then_insert_benchmark_run(
            org_id, agent_id, dataset_id,
            status="completed", metrics_json=metrics_json,
        )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "agent_id": agent_id,
                "dataset_id": dataset_id,
                "status": "completed",
                "synthetic": True,
                "metrics": metrics,
            },
        )


# ── 5. AgentFleetService ─────────────────────────────────────────────


class AgentFleetService:
    """Agent identity + permissions (LangSmith Fleet parity).

    Two endpoints:

    * :meth:`register_agent_identity` — insert or update a
      row in ``agent_fleet_identities``. When an existing
      identity is re-registered, the closed-loop
      :func:`_fire_fleet_drift_hook` fires
      ``PromotionHook.on_drift_alert(
      drift_type="fleet_deprecation:<agent_id>",
      severity="medium")`` — the upstream caller is still
      relying on a deprecated/renamed agent identity. Matches
      the Cat 2 RCA + Cat 8 cost anomaly pattern.

    * :meth:`assign_permissions` — insert one
      ``agent_fleet_permissions`` row per permission.
      v0 does not support revocation; the API never deletes
      rows.

    The :attr:`name` is ``"agent_fleet"``.
    """

    name = "agent_fleet"

    async def register_agent_identity(
        self,
        org_id: str,
        *,
        agent_id: str,
        display_name: str,
        slack_identity: str | None = None,
    ) -> dict[str, Any]:
        # Input validation. We accept a missing/empty
        # ``display_name`` (the v0 stub did too) but require
        # ``agent_id``.
        if not agent_id or not str(agent_id).strip():
            return _bad_request_envelope(
                self.name, "agent_id must be a non-empty string"
            )
        agent_id = str(agent_id).strip()[:128]
        display_name = str(display_name or "").strip()[:DISPLAY_NAME_MAX_LEN]
        if not display_name:
            display_name = agent_id
        slack_value: str | None = None
        if slack_identity is not None:
            s = str(slack_identity).strip()[:SLACK_IDENTITY_MAX_LEN]
            if s:
                slack_value = s

        # Detect re-registration (deprecation cascade signal).
        existing = await _fetch_existing_fleet_identity(org_id, agent_id)
        is_reregistration = existing is not None
        previous_display = (
            str(existing.get("display_name"))
            if existing is not None
            else None
        )

        # Upsert.
        await _upsert_fleet_identity(
            org_id, agent_id, display_name, slack_value
        )

        # Closed-loop: if we re-registered an existing
        # identity, fire the deprecation-drift hook. The
        # severity is "medium" — matches the Cat 2 / Cat 8
        # convention; the operator can promote to "high" in
        # v2 once we have the "still being called" call-graph
        # signal.
        if is_reregistration:
            # Audit 2026-07-03 B-23 — must ``await``; pre-fix this
            # discarded a coroutine on every fleet re-registration.
            await _fire_fleet_drift_hook(org_id, agent_id)

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "agent_id": agent_id,
                "display_name": display_name,
                "slack_identity": slack_value,
                "re_registered": is_reregistration,
                "previous_display_name": previous_display
                if is_reregistration
                else None,
                "drift_hook_fired": is_reregistration,
            },
        )

    async def assign_permissions(
        self,
        org_id: str,
        *,
        agent_id: str,
        permissions: list[str],
    ) -> dict[str, Any]:
        if not agent_id or not str(agent_id).strip():
            return _bad_request_envelope(
                self.name, "agent_id must be a non-empty string"
            )
        agent_id = str(agent_id).strip()[:128]
        if not isinstance(permissions, list) or not permissions:
            return _bad_request_envelope(
                self.name,
                "permissions must be a non-empty list of strings",
            )
        if len(permissions) > MAX_PERMISSIONS_PER_AGENT:
            return _bad_request_envelope(
                self.name,
                f"too many permissions: max "
                f"{MAX_PERMISSIONS_PER_AGENT} per agent",
            )
        # Validate each permission is a non-empty string.
        clean: list[str] = []
        for p in permissions:
            if not isinstance(p, str):
                return _bad_request_envelope(
                    self.name, "each permission must be a string"
                )
            s = p.strip()[:128]
            if not s:
                return _bad_request_envelope(
                    self.name,
                    "each permission must be a non-empty string",
                )
            clean.append(s)

        # Verify the agent identity exists; the route is
        # otherwise orphaned. The 404 envelope makes the
        # ordering explicit: register first, then assign
        # permissions.
        existing = await _fetch_existing_fleet_identity(org_id, agent_id)
        if existing is None:
            return _not_found_envelope(
                self.name,
                f"agent_id {agent_id!r} not found — register first via "
                "/intelligence/agents/fleet/identity",
            )

        await _insert_fleet_permissions(org_id, agent_id, clean)

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "agent_id": agent_id,
                "permissions_assigned": clean,
                "n_assigned": len(clean),
            },
        )
