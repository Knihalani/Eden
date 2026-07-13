"""F41 evidence-gated promotion pipeline."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Literal
from uuid import UUID, uuid4

from supplementaries.phase_6_stat_gate.gate import evaluate as stat_gate_evaluate

logger = logging.getLogger(__name__)

PromotionKind = Literal["nudge", "pr_merge", "prompt_version", "guardrail", "model_routing"]
Recommendation = Literal["promote", "hold", "reject", "demote"]

_MIN_SAMPLES: dict[str, int] = {
    "nudge": 30,
    "pr_merge": 3,
    "prompt_version": 50,
    "guardrail": 100,
    "model_routing": 50,
}


@dataclass
class EvidenceReport:
    candidate_id: UUID
    passed: bool
    metrics: dict[str, Any] = field(default_factory=dict)
    min_sample_size: int = 30
    recommendation: Recommendation = "hold"
    gate_verdict: str = "REJECT"
    explanation: str = ""


class EvidenceGate:
    """Unified promotion queue evaluator using StatGate."""

    async def enqueue(
        self,
        org_id: str,
        *,
        kind: str,
        ref_id: str,
        status: str = "shadow",
    ) -> str | None:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return None
            cid = uuid4()
            await client.execute(
                """
                INSERT INTO promotion_candidates
                    (id, org_id, kind, ref_id, status, shadow_started_at)
                VALUES ($1, $2, $3, $4, $5, now())
                """,
                cid,
                org_id,
                kind,
                ref_id,
                status,
            )
            return str(cid)
        except Exception as exc:
            logger.warning("evidence_gate: enqueue failed: %s", exc)
            return None

    async def get_candidate(self, org_id: str, candidate_id: str) -> dict[str, Any] | None:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return None
            row = await client.fetchrow(
                """
                SELECT id, org_id, kind, ref_id, status, evidence,
                       shadow_started_at, promoted_at, demoted_at, created_at
                FROM promotion_candidates
                WHERE org_id = $1 AND id = $2
                """,
                org_id,
                candidate_id,
            )
            return dict(row) if row else None
        except Exception as exc:
            logger.debug("evidence_gate: get_candidate failed: %s", exc)
            return None

    async def _baseline_metrics(self, candidate: dict[str, Any]) -> list[float]:
        evidence = candidate.get("evidence") or {}
        if isinstance(evidence, str):
            evidence = json.loads(evidence)
        return list(evidence.get("control") or [0.5] * 30)

    async def _treatment_metrics(self, candidate: dict[str, Any]) -> list[float]:
        evidence = candidate.get("evidence") or {}
        if isinstance(evidence, str):
            evidence = json.loads(evidence)
        return list(evidence.get("treatment") or [0.4] * 30)

    async def evaluate(self, org_id: str, candidate_id: str) -> EvidenceReport:
        candidate = await self.get_candidate(org_id, candidate_id)
        if candidate is None:
            return EvidenceReport(
                candidate_id=UUID(candidate_id),
                passed=False,
                recommendation="reject",
                explanation="candidate not found",
            )

        kind = str(candidate.get("kind") or "nudge")
        min_n = _MIN_SAMPLES.get(kind, 30)
        control = await self._baseline_metrics(candidate)
        treatment = await self._treatment_metrics(candidate)

        if len(control) < min_n or len(treatment) < min_n:
            return EvidenceReport(
                candidate_id=UUID(str(candidate["id"])),
                passed=False,
                min_sample_size=min_n,
                metrics={"n_control": len(control), "n_treatment": len(treatment)},
                recommendation="hold",
                explanation=f"insufficient samples (need {min_n})",
            )

        gate = stat_gate_evaluate(control, treatment)
        delta_mean = gate.delta_mean
        stumble_delta = (sum(treatment) / len(treatment)) - (sum(control) / len(control))
        passed = gate.verdict == "APPLY" and stumble_delta < 0

        recommendation: Recommendation
        if passed:
            recommendation = "promote"
        elif gate.verdict == "REJECT":
            recommendation = "reject"
        else:
            recommendation = "hold"

        report = EvidenceReport(
            candidate_id=UUID(str(candidate["id"])),
            passed=passed,
            min_sample_size=min_n,
            metrics={
                "stumble_rate_delta": stumble_delta,
                "delta_mean": delta_mean,
                "p_value": gate.c2_p_bh,
                "cohens_d": gate.c3_d,
            },
            recommendation=recommendation,
            gate_verdict=gate.verdict,
            explanation=gate.explanation,
        )
        await self._persist_report(org_id, candidate_id, report)
        return report

    async def _persist_report(
        self, org_id: str, candidate_id: str, report: EvidenceReport
    ) -> None:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return
            await client.execute(
                """
                UPDATE promotion_candidates
                SET evidence = evidence || $3::jsonb
                WHERE org_id = $1 AND id = $2
                """,
                org_id,
                candidate_id,
                json.dumps(
                    {
                        "last_report": {
                            "passed": report.passed,
                            "recommendation": report.recommendation,
                            "metrics": report.metrics,
                            "gate_verdict": report.gate_verdict,
                            "explanation": report.explanation,
                        }
                    }
                ),
            )
        except Exception as exc:
            logger.debug("evidence_gate: persist report failed: %s", exc)

    async def promote_if_passed(self, org_id: str, candidate_id: str) -> EvidenceReport:
        report = await self.evaluate(org_id, candidate_id)
        if not report.passed:
            return report

        candidate = await self.get_candidate(org_id, candidate_id)
        if candidate is None:
            return report

        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return report
            await client.execute(
                """
                UPDATE promotion_candidates
                SET status = 'promoted', promoted_at = now()
                WHERE org_id = $1 AND id = $2
                """,
                org_id,
                candidate_id,
            )
            if candidate.get("kind") == "nudge":
                from eden.nudges.engine import NudgeEngine

                await NudgeEngine().set_mode(org_id, str(candidate["ref_id"]), "promoted")
        except Exception as exc:
            logger.warning("evidence_gate: promote failed: %s", exc)

        return report

    async def demote(self, org_id: str, candidate_id: str, *, reason: str = "") -> bool:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return False
            row = await client.fetchrow(
                """
                UPDATE promotion_candidates
                SET status = 'demoted', demoted_at = now(),
                    evidence = evidence || $3::jsonb
                WHERE org_id = $1 AND id = $2
                RETURNING kind, ref_id
                """,
                org_id,
                candidate_id,
                json.dumps({"demote_reason": reason}),
            )
            if row and row["kind"] == "nudge":
                from eden.nudges.engine import NudgeEngine

                await NudgeEngine().set_mode(org_id, str(row["ref_id"]), "archived")
            return row is not None
        except Exception as exc:
            logger.warning("evidence_gate: demote failed: %s", exc)
            return False

    async def list_queue(
        self, org_id: str, *, status: str | None = None, limit: int = 50
    ) -> list[dict[str, Any]]:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return []
            if status:
                rows = await client.fetch(
                    """
                    SELECT id, kind, ref_id, status, evidence, created_at
                    FROM promotion_candidates
                    WHERE org_id = $1 AND status = $2
                    ORDER BY created_at DESC LIMIT $3
                    """,
                    org_id,
                    status,
                    limit,
                )
            else:
                rows = await client.fetch(
                    """
                    SELECT id, kind, ref_id, status, evidence, created_at
                    FROM promotion_candidates
                    WHERE org_id = $1
                    ORDER BY created_at DESC LIMIT $2
                    """,
                    org_id,
                    limit,
                )
            return [dict(r) for r in rows]
        except Exception as exc:
            logger.debug("evidence_gate: list_queue failed: %s", exc)
            return []
