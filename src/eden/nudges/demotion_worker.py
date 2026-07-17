"""Demotion worker — 7d rolling regression archives weak Artifacts."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


class ArtifactDemotionWorker:
    """Scan promoted Artifacts with negative lift over 7d and demote."""

    async def run_once(self, *, limit: int = 50) -> dict[str, Any]:
        demoted = 0
        scanned = 0
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return {"scanned": 0, "demoted": 0}

            rows = await client.fetch(
                """
                SELECT n.id, n.org_id, n.agent_id, n.name, n.content,
                       AVG(CASE WHEN no.outcome_success THEN 0.0 ELSE 1.0 END)
                           AS stumble_rate,
                       MIN(no.recorded_at) AS first_applied
                FROM nudges n
                JOIN nudge_outcomes no ON no.nudge_id = n.id
                WHERE n.mode = 'promoted'
                  AND no.recorded_at >= now() - interval '7 days'
                  AND no.applied = true
                GROUP BY n.id, n.org_id, n.agent_id, n.name, n.content
                HAVING COUNT(*) >= 10
                   AND AVG(CASE WHEN no.outcome_success THEN 0.0 ELSE 1.0 END)
                       > 0.5
                ORDER BY stumble_rate DESC
                LIMIT $1
                """,
                limit,
            )
            from eden.nudges.cost_estimator import CostEstimator
            from eden.promotion.evidence_gate import EvidenceGate
            from eden.kb.ledger.generator import LedgerGenerator

            gate = EvidenceGate()
            ledger = LedgerGenerator()
            estimator = CostEstimator()
            from datetime import UTC, datetime

            for row in rows or []:
                scanned += 1
                org_id = str(row["org_id"])
                nudge_id = str(row["id"])
                stumble_rate = float(row["stumble_rate"] or 0)
                lift_pp = max(0.0, (0.5 - stumble_rate) * 100)
                value = estimator.estimate(str(row["content"] or ""), success_lift_pp=lift_pp)
                first_applied = row.get("first_applied")
                burn_in = (
                    first_applied
                    and (datetime.now(UTC) - first_applied).total_seconds() <= 3600
                )
                if burn_in and not estimator.passes_value_floor(value.value_score):
                    continue
                if stumble_rate <= 0.5 and estimator.passes_value_floor(value.value_score):
                    continue
                candidates = await gate.list_queue(org_id, status="promoted", limit=20)
                cid = next(
                    (c for c in candidates if str(c.get("ref_id")) == nudge_id),
                    None,
                )
                if cid:
                    await gate.demote(org_id, str(cid["id"]), reason="7d_regression")
                else:
                    from eden.nudges.engine import NudgeEngine

                    await NudgeEngine().set_mode(org_id, nudge_id, "archived")
                await ledger.upsert_do_not_repeat(
                    org_id,
                    str(row["agent_id"]),
                    text=f"Do not repeat fix `{row['name']}` — 7d regression.",
                    source_ids=[nudge_id],
                )
                demoted += 1
        except Exception as exc:
            logger.warning("artifact demotion worker failed: %s", exc)
        return {"scanned": scanned, "demoted": demoted}
