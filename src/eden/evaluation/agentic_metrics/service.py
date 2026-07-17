"""F64 — packaged agentic metrics rollup for Home + Fleet."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Galileo-style pack axes → Layer A judge_scores names
_AXIS_MAP = {
    "tool_selection": "tool_selection_quality",
    "action_completion": "action_completion",
    "flow_adherence": "efficiency",
    "intent_change": "groundedness",
}

_INVESTIGATOR_COST_USD = 0.03


class AgenticMetricsService:
    """Aggregate Layer A / judge_scores into an agentic metrics pack."""

    async def summary(
        self,
        org_id: str,
        *,
        agent_id: str | None = None,
        window_hours: int = 24,
    ) -> dict[str, Any]:
        """Return pack averages + sample counts (org-scoped)."""
        try:
            from eden.config import get_settings

            if not getattr(get_settings(), "agentic_metrics_v1", True):
                return {
                    "status": "disabled",
                    "feature": "agentic_metrics_v1",
                    "metrics": {},
                    "trace_count": 0,
                }
        except Exception:
            pass

        metrics = await self._avg_axes(org_id, agent_id=agent_id, window_hours=window_hours)
        by_agent = await self._by_agent(org_id, window_hours=window_hours)
        return {
            "status": "ok",
            "feature": "f64_agentic_metrics",
            "window_hours": window_hours,
            "metrics": metrics,
            "by_agent": by_agent,
            "trace_count": int(metrics.get("_trace_count") or 0),
            "axes": list(_AXIS_MAP.keys()),
        }

    async def _avg_axes(
        self,
        org_id: str,
        *,
        agent_id: str | None,
        window_hours: int,
    ) -> dict[str, Any]:
        try:
            from eden.storage.postgres import get_postgres_client

            pg = await get_postgres_client()
        except Exception:
            return self._empty_metrics()
        if pg is None:
            return self._empty_metrics()

        judge_names = list(_AXIS_MAP.values())
        try:
            if agent_id:
                rows = await pg.fetch(
                    """
                    SELECT judge_name,
                           AVG(score)::float AS avg_score,
                           COUNT(*)::int AS n
                    FROM judge_scores
                    WHERE tenant_id = $1
                      AND judge_name = ANY($2::text[])
                      AND scored_at > NOW() - ($3 || ' hours')::interval
                      AND trace_id IN (
                        SELECT id FROM agent_traces
                        WHERE org_id = $1 AND agent_id = $4
                        LIMIT 5000
                      )
                    GROUP BY judge_name
                    """,
                    org_id,
                    judge_names,
                    str(window_hours),
                    agent_id,
                )
            else:
                rows = await pg.fetch(
                    """
                    SELECT judge_name,
                           AVG(score)::float AS avg_score,
                           COUNT(DISTINCT trace_id)::int AS n
                    FROM judge_scores
                    WHERE tenant_id = $1
                      AND judge_name = ANY($2::text[])
                      AND scored_at > NOW() - ($3 || ' hours')::interval
                    GROUP BY judge_name
                    """,
                    org_id,
                    judge_names,
                    str(window_hours),
                )
        except Exception as exc:
            logger.debug("agentic_metrics: query failed: %s", exc)
            # Soft fallback without agent_traces join
            try:
                rows = await pg.fetch(
                    """
                    SELECT judge_name,
                           AVG(score)::float AS avg_score,
                           COUNT(DISTINCT trace_id)::int AS n
                    FROM judge_scores
                    WHERE tenant_id = $1
                      AND judge_name = ANY($2::text[])
                      AND scored_at > NOW() - ($3 || ' hours')::interval
                    GROUP BY judge_name
                    """,
                    org_id,
                    judge_names,
                    str(window_hours),
                )
            except Exception as exc2:
                logger.debug("agentic_metrics: fallback query failed: %s", exc2)
                return self._empty_metrics()

        by_judge = {
            str(r["judge_name"]): {
                "avg": round(float(r["avg_score"] or 0), 4),
                "n": int(r["n"] or 0),
            }
            for r in rows
        }
        out: dict[str, Any] = {}
        max_n = 0
        for axis, judge in _AXIS_MAP.items():
            cell = by_judge.get(judge) or {"avg": None, "n": 0}
            out[axis] = {
                "score": cell["avg"],
                "sample_count": cell["n"],
                "source_judge": judge,
            }
            max_n = max(max_n, int(cell["n"] or 0))
        out["_trace_count"] = max_n
        return out

    async def _by_agent(self, org_id: str, *, window_hours: int) -> list[dict[str, Any]]:
        try:
            from eden.storage.postgres import get_postgres_client

            pg = await get_postgres_client()
        except Exception:
            return []
        if pg is None:
            return []
        try:
            # Fleet pack: org-level axes (per-agent join optional / soft).
            rows = await pg.fetch(
                """
                SELECT '(fleet)' AS agent_id,
                       AVG(CASE WHEN judge_name = 'action_completion'
                                THEN score END)::float AS action_completion,
                       AVG(CASE WHEN judge_name = 'tool_selection_quality'
                                THEN score END)::float AS tool_selection,
                       AVG(CASE WHEN judge_name = 'efficiency'
                                THEN score END)::float AS flow_adherence,
                       AVG(CASE WHEN judge_name = 'groundedness'
                                THEN score END)::float AS intent_change,
                       COUNT(DISTINCT trace_id)::int AS trace_count
                FROM judge_scores
                WHERE tenant_id = $1
                  AND judge_name = ANY($2::text[])
                  AND scored_at > NOW() - ($3 || ' hours')::interval
                """,
                org_id,
                list(_AXIS_MAP.values()),
                str(window_hours),
            )
        except Exception as exc:
            logger.debug("agentic_metrics: by_agent failed: %s", exc)
            return []
        return [
            {
                "agent_id": str(r["agent_id"]),
                "action_completion": _round(r["action_completion"]),
                "tool_selection": _round(r["tool_selection"]),
                "flow_adherence": _round(r["flow_adherence"]),
                "intent_change": _round(r["intent_change"]),
                "trace_count": int(r["trace_count"] or 0),
            }
            for r in rows
            if int(r["trace_count"] or 0) > 0
        ]

    @staticmethod
    def _empty_metrics() -> dict[str, Any]:
        return {
            axis: {"score": None, "sample_count": 0, "source_judge": judge}
            for axis, judge in _AXIS_MAP.items()
        } | {"_trace_count": 0}


def _round(v: Any) -> float | None:
    if v is None:
        return None
    try:
        return round(float(v), 4)
    except (TypeError, ValueError):
        return None


def investigator_unit_cost_usd() -> float:
    return _INVESTIGATOR_COST_USD
