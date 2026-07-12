"""Metrics-only rows for N16 sampled-out traces.

Fleet dashboards (N05) can still show volume/cost when full spans are
dropped. Persistence is best-effort: in-memory always; Postgres when the
``trace_sampling_summaries`` table exists.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class TraceSamplingSummary:
    org_id: str
    trace_id: str
    agent_id: str | None = None
    duration_ms: int = 0
    cost_usd: float = 0.0
    span_count: int = 0
    drop_reason: str = "sampled_out"


@dataclass
class SamplingSummaryStore:
    """In-process buffer + optional Postgres upsert."""

    _rows: list[TraceSamplingSummary] = field(default_factory=list)
    max_buffered: int = 10_000

    def record(self, summary: TraceSamplingSummary) -> None:
        if len(self._rows) >= self.max_buffered:
            self._rows.pop(0)
        self._rows.append(summary)

    def buffered(self) -> list[TraceSamplingSummary]:
        return list(self._rows)

    def clear(self) -> None:
        self._rows.clear()

    async def persist(self, summary: TraceSamplingSummary) -> bool:
        """Upsert into ``trace_sampling_summaries`` when Postgres is up."""
        self.record(summary)
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
        except Exception as exc:
            logger.debug("sampling summary: postgres unavailable: %s", exc)
            return False
        if client is None:
            return False
        try:
            await client.execute(
                """
                INSERT INTO trace_sampling_summaries (
                    org_id, trace_id, agent_id, duration_ms, cost_usd,
                    span_count, drop_reason
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (org_id, trace_id) DO UPDATE SET
                    agent_id = EXCLUDED.agent_id,
                    duration_ms = EXCLUDED.duration_ms,
                    cost_usd = EXCLUDED.cost_usd,
                    span_count = EXCLUDED.span_count,
                    drop_reason = EXCLUDED.drop_reason,
                    dropped_at = now()
                """,
                summary.org_id,
                summary.trace_id,
                summary.agent_id,
                summary.duration_ms,
                summary.cost_usd,
                summary.span_count,
                summary.drop_reason,
            )
            return True
        except Exception as exc:
            logger.debug("sampling summary persist failed: %s", exc)
            return False


_store: SamplingSummaryStore | None = None


def get_sampling_summary_store() -> SamplingSummaryStore:
    global _store
    if _store is None:
        _store = SamplingSummaryStore()
    return _store


def signals_from_attributes(attrs: dict[str, Any] | None) -> dict[str, bool]:
    """Best-effort boolean extraction from span/trace attributes."""
    if not isinstance(attrs, dict):
        return {}
    def _truthy(key: str) -> bool:
        v = attrs.get(key)
        if isinstance(v, bool):
            return v
        if v is None:
            return False
        return str(v).lower() in ("1", "true", "yes", "error")

    return {
        "has_error": _truthy("error") or attrs.get("otel.status_code") == "ERROR",
        "is_loop": _truthy("eden.loop_verdict") or _truthy("eden.is_loop"),
        "has_tool_error": _truthy("eden.tool_error"),
        "has_stumble": _truthy("eden.stumble"),
        "has_judge_failure": _truthy("eden.judge_failure"),
        "has_stat_gate_fail": _truthy("eden.stat_gate_fail"),
        "has_mcp_auth_failure": _truthy("eden.mcp_auth_failure"),
        "is_high_cost": _truthy("eden.high_cost"),
        "force_trace": _truthy("eden.force_trace"),
    }
