"""F42 weekly drift baseline worker."""

from __future__ import annotations

import logging
from typing import Any

from eden.insights.drift_reports import DRIFT_DIMENSIONS, DriftReportBuilder

logger = logging.getLogger(__name__)


class DriftBaselineWorker:
    """Refresh drift_baselines histograms for active agents (weekly)."""

    async def run_once(self, *, limit: int = 100) -> dict[str, Any]:
        updated = 0
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return {"updated": 0}

            rows = await client.fetch(
                """
                SELECT DISTINCT org_id, agent_id
                FROM agent_issues
                WHERE last_seen >= now() - interval '7 days'
                LIMIT $1
                """,
                limit,
            )
            builder = DriftReportBuilder()
            for row in rows or []:
                org_id = str(row["org_id"])
                agent_id = str(row["agent_id"])
                for dim in DRIFT_DIMENSIONS:
                    counts = await self._histogram(org_id, agent_id, dim)
                    if counts:
                        await builder.upsert_baseline(
                            org_id, agent_id, dim, counts, sample_count=sum(counts)
                        )
                        updated += 1
        except Exception as exc:
            logger.warning("drift baseline worker failed: %s", exc)
        return {"updated": updated}

    async def _histogram(
        self, org_id: str, agent_id: str, dimension: str
    ) -> list[float]:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return []
            if dimension == "stumble_rate":
                rate = await client.fetchval(
                    """
                    SELECT AVG(CASE WHEN status = 'open' THEN 1.0 ELSE 0.0 END)
                    FROM agent_issues
                    WHERE org_id = $1 AND agent_id = $2
                      AND last_seen >= now() - interval '7 days'
                    """,
                    org_id,
                    agent_id,
                )
                base = float(rate or 0.1)
                return [base * (1 + i * 0.05) for i in range(10)]
            count = await client.fetchval(
                """
                SELECT COUNT(*) FROM agent_issues
                WHERE org_id = $1 AND agent_id = $2
                  AND last_seen >= now() - interval '7 days'
                """,
                org_id,
                agent_id,
            )
            c = max(int(count or 0), 1)
            return [float(c // 10 + (1 if i < c % 10 else 0)) for i in range(10)]
        except Exception:
            return [10.0] * 10
