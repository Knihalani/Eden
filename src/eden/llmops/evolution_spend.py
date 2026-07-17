"""EvolutionSpendBudget — Eden ops $ cap for background authoring."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


class EvolutionSpendBudget:
    """Track and gate Eden ops spend per org per day via budget_service."""

    def __init__(self, org_id: str) -> None:
        self.org_id = org_id

    async def daily_cap_usd(self) -> float:
        from eden.config import get_settings

        return float(get_settings().max_evolution_ops_usd_per_org_day)

    async def spent_today_usd(self) -> float:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return 0.0
            day_start = datetime.now(UTC).replace(
                hour=0, minute=0, second=0, microsecond=0
            )
            val = await client.fetchval(
                """
                SELECT COALESCE(SUM(cost_usd), 0)
                FROM evolution_ops_spend
                WHERE org_id = $1 AND recorded_at >= $2
                """,
                self.org_id,
                day_start,
            )
            return float(val or 0.0)
        except Exception as exc:
            logger.debug("evolution_spend: spent_today failed: %s", exc)
            return 0.0

    async def may_spend(self, estimated_usd: float = 0.0) -> bool:
        cap = await self.daily_cap_usd()
        spent = await self.spent_today_usd()
        return (spent + estimated_usd) <= cap

    async def record(self, cost_usd: float, *, kind: str, ref_id: str = "") -> None:
        if cost_usd <= 0:
            return
        try:
            from uuid import uuid4

            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return
            await client.execute(
                """
                INSERT INTO evolution_ops_spend
                    (id, org_id, kind, ref_id, cost_usd, recorded_at)
                VALUES ($1, $2, $3, $4, $5, now())
                """,
                uuid4(),
                self.org_id,
                kind,
                ref_id,
                cost_usd,
            )
        except Exception as exc:
            logger.debug("evolution_spend: record failed: %s", exc)
        try:
            from eden.llmops.cost_ledger import CostEvent, record_cost_event

            await record_cost_event(
                CostEvent(
                    org_id=self.org_id,
                    feature="evolution",
                    model="evolution_loop",
                    cost_usd=float(cost_usd),
                    metadata={"kind": kind, "ref_id": ref_id},
                )
            )
        except Exception as exc:
            logger.debug("evolution_spend: CostEvent tag failed: %s", exc)

    async def status(self) -> dict[str, Any]:
        cap = await self.daily_cap_usd()
        spent = await self.spent_today_usd()
        return {
            "cap_usd": cap,
            "spent_usd": spent,
            "remaining_usd": max(0.0, cap - spent),
        }
