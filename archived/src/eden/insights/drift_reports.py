"""F42 behavioral drift pinpoint reports."""

from __future__ import annotations

import logging
import math
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

logger = logging.getLogger(__name__)

PSI_THRESHOLD = 0.2
DRIFT_DIMENSIONS = (
    "tool_distribution",
    "model_mix",
    "prompt_version_mix",
    "avg_steps",
    "cost_per_trace",
    "stumble_rate",
    "mcp_error_rate",
)


def compute_psi(
    baseline_counts: list[float],
    current_counts: list[float],
    *,
    epsilon: float = 1e-6,
) -> float:
    """Population Stability Index between two aligned histograms."""
    if not baseline_counts or not current_counts:
        return 0.0
    n = min(len(baseline_counts), len(current_counts))
    baseline = baseline_counts[:n]
    current = current_counts[:n]
    base_total = sum(baseline) or epsilon
    cur_total = sum(current) or epsilon
    base_pct = [max(c / base_total, epsilon) for c in baseline]
    cur_pct = [max(c / cur_total, epsilon) for c in current]
    return sum((c - b) * math.log(c / b) for b, c in zip(base_pct, cur_pct, strict=False))


class DriftReportBuilder:
    """Build drift reports from baseline vs current histograms."""

    def build_dimension(
        self,
        dimension: str,
        baseline: list[float],
        current: list[float],
        *,
        sample_count: int = 0,
    ) -> dict[str, Any]:
        psi = compute_psi(baseline, current)
        flagged = psi > PSI_THRESHOLD
        base_mean = sum(baseline) / len(baseline) if baseline else 0.0
        cur_mean = sum(current) / len(current) if current else 0.0
        delta_pct = ((cur_mean - base_mean) / base_mean * 100) if base_mean else 0.0
        return {
            "dimension": dimension,
            "psi": round(psi, 4),
            "flagged": flagged,
            "delta_pct": round(delta_pct, 2),
            "sample_count": sample_count,
            "baseline_histogram": baseline,
            "current_histogram": current,
            "summary": (
                f"{dimension} shifted (PSI={psi:.3f})"
                if flagged
                else f"{dimension} stable (PSI={psi:.3f})"
            ),
        }

    async def compute_report(
        self,
        org_id: str,
        agent_id: str,
        *,
        baselines: dict[str, dict[str, Any]] | None = None,
        currents: dict[str, list[float]] | None = None,
    ) -> dict[str, Any] | None:
        baselines = baselines or await self._load_baselines(org_id, agent_id)
        currents = currents or self._mock_currents(baselines)
        dimensions: list[dict[str, Any]] = []
        for dim in DRIFT_DIMENSIONS:
            base_hist = (baselines.get(dim) or {}).get("baseline_histogram") or {}
            base_counts = list(base_hist.get("counts") or [1.0] * 10)
            cur_counts = currents.get(dim) or base_counts
            dimensions.append(
                self.build_dimension(
                    dim,
                    base_counts,
                    cur_counts,
                    sample_count=int((baselines.get(dim) or {}).get("sample_count") or 0),
                )
            )
        flagged = [d for d in dimensions if d["flagged"]]
        flagged.sort(key=lambda d: d["psi"], reverse=True)
        top = [d["dimension"] for d in flagged[:3]]
        now = datetime.now(UTC)
        period_start = now - timedelta(days=1)
        summary = (
            f"Top drift: {', '.join(top)}"
            if top
            else "No significant behavioral drift detected."
        )
        report_id = await self._persist(
            org_id,
            agent_id,
            period_start=period_start,
            period_end=now,
            dimensions=dimensions,
            top_dimensions=top,
            summary=summary,
        )
        return {
            "id": report_id,
            "org_id": org_id,
            "agent_id": agent_id,
            "dimensions": dimensions,
            "top_dimensions": top,
            "plain_english_summary": summary,
            "report_period_start": period_start.isoformat(),
            "report_period_end": now.isoformat(),
        }

    def _mock_currents(self, baselines: dict[str, dict[str, Any]]) -> dict[str, list[float]]:
        """Derive current histograms from baselines (shift last bin for demo)."""
        currents: dict[str, list[float]] = {}
        for dim, base in baselines.items():
            hist = base.get("baseline_histogram") or {}
            counts = list(hist.get("counts") or [1.0] * 10)
            shifted = counts[:]
            if shifted:
                shifted[-1] = shifted[-1] * 1.5
            currents[dim] = shifted
        return currents

    async def _load_baselines(
        self, org_id: str, agent_id: str
    ) -> dict[str, dict[str, Any]]:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return self._default_baselines()
            rows = await client.fetch(
                """
                SELECT dimension, baseline_histogram, sample_count
                FROM drift_baselines
                WHERE org_id = $1 AND agent_id = $2
                """,
                org_id,
                agent_id,
            )
            if not rows:
                return self._default_baselines()
            return {str(r["dimension"]): dict(r) for r in rows}
        except Exception:
            return self._default_baselines()

    @staticmethod
    def _default_baselines() -> dict[str, dict[str, Any]]:
        base = {"counts": [10.0] * 10, "bins": list(range(11))}
        return {dim: {"baseline_histogram": base, "sample_count": 100} for dim in DRIFT_DIMENSIONS}

    async def _persist(
        self,
        org_id: str,
        agent_id: str,
        *,
        period_start: datetime,
        period_end: datetime,
        dimensions: list[dict[str, Any]],
        top_dimensions: list[str],
        summary: str,
    ) -> str:
        rid = str(uuid4())
        try:
            import json

            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return rid
            await client.execute(
                """
                INSERT INTO drift_reports
                    (id, org_id, agent_id, report_period_start, report_period_end,
                     dimensions, top_dimensions, plain_english_summary)
                VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
                """,
                rid,
                org_id,
                agent_id,
                period_start,
                period_end,
                json.dumps(dimensions),
                top_dimensions,
                summary,
            )
        except Exception as exc:
            logger.debug("drift report persist failed: %s", exc)
        return rid

    async def get_latest(self, org_id: str, agent_id: str) -> dict[str, Any] | None:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return None
            row = await client.fetchrow(
                """
                SELECT id, dimensions, top_dimensions, plain_english_summary,
                       report_period_start, report_period_end, created_at
                FROM drift_reports
                WHERE org_id = $1 AND agent_id = $2
                ORDER BY created_at DESC LIMIT 1
                """,
                org_id,
                agent_id,
            )
            return dict(row) if row else None
        except Exception as exc:
            logger.debug("drift get_latest failed: %s", exc)
            return None

    async def upsert_baseline(
        self,
        org_id: str,
        agent_id: str,
        dimension: str,
        counts: list[float],
        *,
        sample_count: int = 100,
    ) -> None:
        try:
            import json

            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return
            await client.execute(
                """
                INSERT INTO drift_baselines
                    (org_id, agent_id, dimension, baseline_histogram, sample_count)
                VALUES ($1, $2, $3, $4::jsonb, $5)
                ON CONFLICT (org_id, agent_id, dimension)
                DO UPDATE SET baseline_histogram = EXCLUDED.baseline_histogram,
                              sample_count = EXCLUDED.sample_count,
                              computed_at = now()
                """,
                org_id,
                agent_id,
                dimension,
                json.dumps({"counts": counts, "bins": list(range(len(counts) + 1))}),
                sample_count,
            )
        except Exception as exc:
            logger.debug("drift upsert_baseline failed: %s", exc)
