"""Cat 22 — Three new agent-specific metrics (v1.4).

The v1.4 ship adds three derived metrics that close the
gap between Eden's LLM-specific observability and the
2026 general-purpose APM stack (Datadog, Honeycomb,
Grafana):

* :class:`DecisionPathDepthMetric` — the count of reasoning
  steps in a trace. Sudden increases (especially
  ``p95 > 20``) signal a loop. The Cat 16 trajectory
  analyzer already produces the step counts; this service
  rolls them up to ``(median, p95)`` per org per
  window.

* :class:`ToolCallSuccessRateMetric` — per-tool, per-tenant
  tool call success rate. Reads from ``tool_attributions``
  (Cat 7) + ``incident_cluster_members`` (Cat 2) for the
  failure-side signal. Alerts at < 80% over a 30-min
  window.

* :class:`CostPerStepMetric` — per-step, per-agent cost.
  Derived from ``usage_events`` joined to
  ``telemetry_events`` on ``step_index``. The Cat 8 cost
  forecast already consumes ``usage_events``; this is a
  join + rollup.

Each service returns the live ``ok`` envelope; the
:class:`AgentMetricsCollector.aggregate` rolls them up
into a single dashboard payload.
"""

from __future__ import annotations

import logging
import math
import statistics
from datetime import UTC, datetime, timedelta
from typing import Any

from ._common import _ok_envelope

logger = logging.getLogger(__name__)


# ─── Postgres helpers (per-service; no shared util churn) ──────


async def _fetch_rows(query: str, *args: Any) -> list[dict[str, Any]]:
    """Run ``query`` and return rows as dicts. Best-effort."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception:
        return []
    try:
        client = await get_postgres_client()
    except Exception:
        return []
    if client is None:
        return []
    try:
        rows = await client.fetch(query, *args)
    except Exception as exc:
        logger.debug("apm_depth: fetch failed: %s", exc)
        return []
    return [dict(r) if not isinstance(r, dict) else r for r in (rows or [])]


# ─── DecisionPathDepthMetric ──────────────────────────────────────


class DecisionPathDepthMetric:
    """The (median, p95) decision-path depth per org per window.

    The Cat 16 trajectory analyzer produces the per-trace
    step count. The v1.4 rollup reads from
    ``decision_paths`` (created in migration 020) and
    computes the per-window percentiles.
    """

    name = "decision_path_depth"

    async def compute(
        self,
        org_id: str,
        *,
        window_hours: int = 24,
    ) -> dict[str, Any]:
        """Compute the depth metric for the org's last
        ``window_hours`` window.

        Returns ``data: {"window_hours": N, "sample_size": M,
        "median": float, "p95": float, "max": int,
        "loop_alert": bool}``.
        """
        if window_hours < 1 or window_hours > 24 * 30:
            window_hours = 24
        since = datetime.now(UTC) - timedelta(hours=window_hours)
        # The step count per trace = max(step_index)+1
        # from decision_paths (Cat 16). Group by trace_id.
        rows = await _fetch_rows(
            """
            SELECT trace_id, MAX(step_index) AS max_step
            FROM decision_paths
            WHERE org_id = $1 AND created_at >= $2
            GROUP BY trace_id
            """,
            org_id, since,
        )
        depths: list[int] = []
        for r in rows:
            v = r.get("max_step")
            if v is None:
                continue
            try:
                depths.append(int(v) + 1)
            except (TypeError, ValueError):
                continue
        return _ok_envelope(
            self.name, _aggregate_depth(depths, window_hours=window_hours)
        )


def _aggregate_depth(
    depths: list[int], *, window_hours: int
) -> dict[str, Any]:
    """Compute (median, p95) of ``depths`` and flag the loop alert."""
    if not depths:
        return {
            "window_hours": window_hours,
            "sample_size": 0,
            "median": 0.0,
            "p95": 0.0,
            "max": 0,
            "loop_alert": False,
        }
    depths_sorted = sorted(depths)
    n = len(depths_sorted)
    median = statistics.median(depths_sorted) if n else 0.0
    # p95 — index = ceil(0.95 * n) - 1
    p95_idx = max(0, min(n - 1, int(math.ceil(0.95 * n)) - 1))
    p95 = float(depths_sorted[p95_idx])
    max_v = depths_sorted[-1]
    # Loop alert: p95 > 20 (per the doc)
    loop_alert = p95 > 20.0
    return {
        "window_hours": window_hours,
        "sample_size": n,
        "median": round(float(median), 2),
        "p95": round(p95, 2),
        "max": int(max_v),
        "loop_alert": bool(loop_alert),
    }


# ─── ToolCallSuccessRateMetric ────────────────────────────────────


class ToolCallSuccessRateMetric:
    """Per-tool, per-tenant tool call success rate.

    Reads from ``tool_attributions`` (Cat 7) for the
    total-tool-call count + from
    ``incident_cluster_members`` for the
    tool-failure contribution. The v0 ship uses a
    simpler approximation: rows in ``tool_attributions``
    with ``outcome='failure'`` are the failure count;
    the rest are the success count.

    Alert: < 80% over a 30-min window (per the doc).
    """

    name = "tool_call_success_rate"

    async def compute(
        self,
        org_id: str,
        *,
        window_minutes: int = 30,
    ) -> dict[str, Any]:
        """Compute the success rate per tool for the last
        ``window_minutes`` window.

        Returns ``data: {"window_minutes": N, "per_tool": {
        "tool_name": {"total": N, "failures": M,
        "success_rate": 0..1, "alert": bool}}, "alert": bool}``.
        """
        if window_minutes < 1 or window_minutes > 24 * 60:
            window_minutes = 30
        since = datetime.now(UTC) - timedelta(minutes=window_minutes)
        rows = await _fetch_rows(
            """
            SELECT tool_name,
                   COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE outcome = 'failure') AS failures
            FROM tool_attributions
            WHERE org_id = $1 AND created_at >= $2
            GROUP BY tool_name
            """,
            org_id, since,
        )
        per_tool: dict[str, dict[str, Any]] = {}
        any_alert = False
        for r in rows:
            tool = str(r.get("tool_name") or "unknown")
            try:
                total = int(r.get("total") or 0)
            except (TypeError, ValueError):
                total = 0
            try:
                failures = int(r.get("failures") or 0)
            except (TypeError, ValueError):
                failures = 0
            rate = (1.0 - (failures / total)) if total > 0 else 1.0
            alert = bool(total > 0 and rate < 0.80)
            per_tool[tool] = {
                "total": total,
                "failures": failures,
                "success_rate": round(rate, 4),
                "alert": alert,
            }
            if alert:
                any_alert = True
        return _ok_envelope(
            self.name,
            {
                "window_minutes": window_minutes,
                "per_tool": per_tool,
                "alert": any_alert,
            },
        )


# ─── CostPerStepMetric ────────────────────────────────────────────


class CostPerStepMetric:
    """Per-step, per-agent cost attribution.

    Reads from ``usage_events`` joined to
    ``telemetry_events`` on ``step_index``. The v0 ship
    uses a simpler path: counts ``usage_events`` rows
    per (agent, step_index) and rolls up the
    ``cost_usd`` column (which Cat 8 already populates
    on each ``usage_events`` insert).

    Alert: > 3× baseline (per the doc). The baseline is
    the median cost per step for the org in the last
    7 days.
    """

    name = "cost_per_step"

    async def compute(
        self,
        org_id: str,
        *,
        window_hours: int = 1,
    ) -> dict[str, Any]:
        """Compute the cost-per-step metric for the last
        ``window_hours`` window.

        Returns ``data: {"window_hours": N, "per_agent": {
        "agent_id": {"step_count": M, "total_cost_usd": ...,
        "avg_cost_per_step_usd": ..., "baseline_usd": ...,
        "alert": bool}}, "alert": bool}``.
        """
        if window_hours < 1 or window_hours > 24 * 7:
            window_hours = 1
        since = datetime.now(UTC) - timedelta(hours=window_hours)
        # Per-agent per-step rollup
        rows = await _fetch_rows(
            """
            SELECT agent_id,
                   COUNT(*) AS step_count,
                   COALESCE(SUM(cost_usd), 0) AS total_cost
            FROM usage_events
            WHERE org_id = $1
              AND timestamp >= $2
              AND agent_id IS NOT NULL
            GROUP BY agent_id
            """,
            org_id, since,
        )
        # Baseline: median per-step cost over the last 7 days
        baseline_since = datetime.now(UTC) - timedelta(days=7)
        baseline_rows = await _fetch_rows(
            """
            SELECT agent_id,
                   COALESCE(AVG(cost_usd), 0) AS avg_cost
            FROM usage_events
            WHERE org_id = $1
              AND timestamp >= $2
              AND agent_id IS NOT NULL
            GROUP BY agent_id
            """,
            org_id, baseline_since,
        )
        baseline_by_agent: dict[str, float] = {}
        for r in baseline_rows:
            try:
                baseline_by_agent[str(r.get("agent_id") or "")] = float(
                    r.get("avg_cost") or 0
                )
            except (TypeError, ValueError):
                continue
        per_agent: dict[str, dict[str, Any]] = {}
        any_alert = False
        for r in rows:
            agent = str(r.get("agent_id") or "")
            try:
                step_count = int(r.get("step_count") or 0)
            except (TypeError, ValueError):
                step_count = 0
            try:
                total_cost = float(r.get("total_cost") or 0)
            except (TypeError, ValueError):
                total_cost = 0.0
            avg = (total_cost / step_count) if step_count > 0 else 0.0
            baseline = baseline_by_agent.get(agent, 0.0)
            ratio = (avg / baseline) if baseline > 0 else 0.0
            alert = bool(baseline > 0 and ratio > 3.0)
            per_agent[agent] = {
                "step_count": step_count,
                "total_cost_usd": round(total_cost, 6),
                "avg_cost_per_step_usd": round(avg, 6),
                "baseline_usd": round(baseline, 6),
                "ratio": round(ratio, 2),
                "alert": alert,
            }
            if alert:
                any_alert = True
        return _ok_envelope(
            self.name,
            {
                "window_hours": window_hours,
                "per_agent": per_agent,
                "alert": any_alert,
            },
        )


# ─── AgentMetricsCollector (dashboard) ───────────────────────────


class AgentMetricsCollector:
    """Dashboard rollup: 3 metrics in one call.

    Returns the live ``ok`` envelope with
    ``data: {"decision_path_depth": {...}, "tool_call_success_rate": {...},
    "cost_per_step": {...}}``.
    """

    name = "agent_metrics"

    async def aggregate(
        self,
        org_id: str,
        *,
        window_hours: int = 24,
    ) -> dict[str, Any]:
        depth = await DecisionPathDepthMetric().compute(
            org_id, window_hours=window_hours
        )
        # Tool call success uses a 30-minute window (per doc)
        tool = await ToolCallSuccessRateMetric().compute(org_id)
        # Cost per step uses a 1-hour window
        cost = await CostPerStepMetric().compute(org_id)
        # Unwrap the per-metric envelopes so the rollup
        # ``data`` block is flat (the dashboard reads
        # ``data.decision_path_depth.sample_size`` etc.).
        return _ok_envelope(
            self.name,
            {
                "decision_path_depth": (depth.get("data") or {}),
                "tool_call_success_rate": (tool.get("data") or {}),
                "cost_per_step": (cost.get("data") or {}),
            },
        )
