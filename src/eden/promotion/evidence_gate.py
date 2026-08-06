"""F41 evidence-gated promotion pipeline."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Literal
from uuid import UUID, uuid4

logger = logging.getLogger(__name__)

PromotionKind = Literal[
    "nudge", "pr_merge", "prompt_version", "guardrail", "model_routing", "kb_skill"
]
Recommendation = Literal["promote", "hold", "reject", "demote"]

_MIN_SAMPLES: dict[str, int] = {
    "nudge": 50,
    "pr_merge": 3,
    "prompt_version": 50,
    "guardrail": 100,
    "model_routing": 50,
    "kb_skill": 50,
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
        cid = uuid4()
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return None
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
            # Genuinely transient/environmental failures (connection drop,
            # constraint violation on a bad org_id/status, etc.) are
            # swallowed on purpose — callers treat a `None` return as
            # "gate unavailable, hold/block promotion" rather than crash.
            # promotion_candidates.ref_id is TEXT (migration 149) so this
            # should no longer fire for the composite "agent:version" /
            # skill-id / judge-name refs that used to hit an asyncpg UUID
            # decode error here on every call — if it does fire, log loud
            # enough to notice.
            logger.error(
                "evidence_gate: enqueue failed (org_id=%s kind=%s ref_id=%r): %s",
                org_id,
                kind,
                ref_id,
                exc,
                exc_info=True,
            )
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
        cached = evidence.get("control")
        if cached and len(cached) >= 5:
            return list(cached)
        return await self._metrics_from_outcomes(candidate, applied=False)

    async def _treatment_metrics(self, candidate: dict[str, Any]) -> list[float]:
        evidence = candidate.get("evidence") or {}
        if isinstance(evidence, str):
            evidence = json.loads(evidence)
        cached = evidence.get("treatment")
        if cached and len(cached) >= 5:
            return list(cached)
        return await self._metrics_from_outcomes(candidate, applied=True)

    async def _metrics_from_outcomes(
        self, candidate: dict[str, Any], *, applied: bool
    ) -> list[float]:
        """Dispatch to a per-kind outcome source (1=failure/stumble, 0=success).

        FEAT-31: each PromotionKind gets its own real evidence source rather
        than being lumped into a blanket "not nudge -> no evidence" bucket.
        Kinds that genuinely have no outcome instrumentation yet still
        return [] here, but from their own explicit branch with a comment
        on what's missing -- not as a side effect of a generic kind check.
        """
        kind = str(candidate.get("kind") or "")
        ref_id = str(candidate.get("ref_id") or "")
        org_id = str(candidate.get("org_id") or "")
        if not ref_id:
            return []
        if kind == "nudge":
            return await self._nudge_outcome_metrics(org_id, ref_id, applied=applied)
        if kind == "prompt_version":
            return await self._prompt_version_outcome_metrics(
                org_id, ref_id, applied=applied
            )
        if kind == "guardrail":
            # No ground-truth correctness signal exists for guardrail
            # decisions today. `guardrail_evaluations` and `intervention_log`
            # (see src/eden/guardrails/intervention.py) only record the
            # verdict a policy produced (allow/block/warn/redact), never
            # whether that verdict was *correct* -- there's no
            # false-positive flag, human-review/override table, or
            # reversed-decision tracking anywhere in the schema. Wiring
            # this up for real needs a `guardrail_outcomes`-style table
            # (mirroring `nudge_outcomes.outcome_success`) fed by a
            # reviewer/override action, not a fabricated proxy metric.
            return []
        if kind == "model_routing":
            # `model_routing` is declared as a PromotionKind (with its own
            # _MIN_SAMPLES entry) but nothing in the codebase ever calls
            # enqueue(kind="model_routing", ...), so there's no established
            # ref_id convention either. ModelRouter (eden/optimization/
            # model_router.py) tracks tier/fallback/quality-validation
            # counters purely in-memory on the instance -- none of it is
            # persisted. There's nothing to query yet; this needs a
            # routing_decisions-style outcome table (and a producer) first.
            return []
        if kind == "kb_skill":
            # kb_skill candidates (ref_id = skills.id) are enqueued by
            # KBFlywheelCoordinator (src/eden/kb/flywheel/coordinator.py),
            # but the `skills` table only carries a static confidence_score/
            # quality_metrics set once at draft time plus a human
            # archivist_reviewed flag -- nothing records whether an applied
            # skill actually helped or hurt downstream. A
            # skill_applications/skill_outcomes table (an outcome_success
            # boolean keyed by skill_id) is needed before this kind can be
            # evidence-gated on real data.
            return []
        # kind == "pr_merge" (or anything else): pr_merge is declared as a
        # PromotionKind and given its own _MIN_SAMPLES threshold, but
        # nothing in the codebase ever enqueues a pr_merge candidate and
        # there is no merge/revert outcome table to query (grepped the
        # whole tree for "pr_merge" -- only hit is this file's own kind
        # list). TODO(FEAT-31 follow-up): wire this up once a producer and
        # a merge-outcome source (e.g. "was this PR reverted/hotfixed")
        # exist; until then it stays an honest no-evidence [] rather than
        # a fabricated signal.
        return []

    async def _nudge_outcome_metrics(
        self, org_id: str, ref_id: str, *, applied: bool
    ) -> list[float]:
        """Aggregate stumble indicators from nudge_outcomes (1=stumble, 0=success)."""
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return []
            rows = await client.fetch(
                """
                SELECT outcome_success, matched, applied
                FROM nudge_outcomes no
                JOIN nudges n ON n.id = no.nudge_id
                WHERE n.org_id = $1 AND n.id = $2::uuid
                  AND no.matched = true
                  AND no.applied = $3
                  AND no.outcome_success IS NOT NULL
                ORDER BY no.recorded_at DESC
                LIMIT 200
                """,
                org_id,
                ref_id,
                applied,
            )
            return [0.0 if r["outcome_success"] else 1.0 for r in rows or []]
        except Exception as exc:
            logger.debug("evidence_gate: nudge outcomes metrics failed: %s", exc)
            return []

    async def _prompt_version_outcome_metrics(
        self, org_id: str, ref_id: str, *, applied: bool
    ) -> list[float]:
        """Aggregate agent.run outcomes from telemetry_events for a canary.

        ``ref_id`` is the composite ``"{agent}:{candidate_version}"`` used
        throughout the prompt-canary promotion path (see
        ``eden.llmops.promotion.PromotionLoop._evaluate_one`` and
        ``eden.api.routes.prompt_canary``). This mirrors that same
        control/candidate split rather than inventing a new one:
        ``applied=True`` is the candidate version (treatment), and
        ``applied=False`` is everything else currently serving that
        tenant's traffic (control). ``org_id`` maps directly onto
        ``telemetry_events.tenant_id``.
        """
        if ":" not in ref_id:
            return []
        _agent, _, candidate_version = ref_id.rpartition(":")
        if not candidate_version:
            return []
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return []
            if applied:
                rows = await client.fetch(
                    """
                    SELECT outcome
                    FROM telemetry_events
                    WHERE tenant_id = $1
                      AND event_type = 'agent.run'
                      AND attributes->>'prompt_version' = $2
                    ORDER BY timestamp DESC
                    LIMIT 200
                    """,
                    org_id,
                    candidate_version,
                )
            else:
                rows = await client.fetch(
                    """
                    SELECT outcome
                    FROM telemetry_events
                    WHERE tenant_id = $1
                      AND event_type = 'agent.run'
                      AND (attributes->>'prompt_version' IS NULL
                           OR attributes->>'prompt_version' != $2)
                    ORDER BY timestamp DESC
                    LIMIT 200
                    """,
                    org_id,
                    candidate_version,
                )
            return [0.0 if r["outcome"] == "success" else 1.0 for r in rows or []]
        except Exception as exc:
            logger.debug("evidence_gate: prompt_version outcomes metrics failed: %s", exc)
            return []

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

        try:
            from supplementaries.phase_6_stat_gate.gate import (
                evaluate as stat_gate_evaluate,
            )
        except ImportError as exc:
            # Docker ships PYTHONPATH=/app/src only; supplementaries is
            # research code not in the wheel. Demote/list still work.
            logger.warning("EvidenceGate.evaluate: StatGate unavailable: %s", exc)
            return EvidenceReport(
                candidate_id=UUID(str(candidate["id"])),
                passed=False,
                min_sample_size=min_n,
                metrics={"n_control": len(control), "n_treatment": len(treatment)},
                recommendation="hold",
                explanation="stat_gate unavailable (supplementaries not packaged)",
            )

        gate = stat_gate_evaluate(control, treatment)
        delta_mean = gate.delta_mean
        stumble_delta = (sum(treatment) / len(treatment)) - (sum(control) / len(control))
        value_score = await self._value_score_async(stumble_delta, candidate)
        passed = (
            gate.verdict == "APPLY"
            and stumble_delta < 0
            and value_score >= self._min_value_score()
        )

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
                "value_score": value_score,
                "success_lift_pp": round(-stumble_delta * 100, 2),
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
                report.passed = False
                report.recommendation = "hold"
                report.explanation = (
                    report.explanation or "promote unavailable: no postgres client"
                )
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
            kind = str(candidate.get("kind") or "")
            ref_id = str(candidate.get("ref_id") or "")
            if kind == "nudge":
                from eden.nudges.engine import NudgeEngine

                await NudgeEngine().set_mode(org_id, ref_id, "promoted")
                from eden.kb.flywheel.coordinator import get_flywheel_coordinator

                await get_flywheel_coordinator().on_promotion(org_id, "nudge", ref_id)
                await self._warm_and_meter(org_id, ref_id, kind="nudge")
            elif kind == "guardrail":
                await self._activate_live_guardrail(org_id, ref_id)
                await self._record_promote_spend(org_id, kind="guardrail", ref_id=ref_id)
            elif kind == "prompt_version":
                await self._record_promote_spend(org_id, kind="prompt_version", ref_id=ref_id)
            elif kind == "kb_skill":
                from eden.kb.flywheel.coordinator import get_flywheel_coordinator

                await get_flywheel_coordinator().on_promotion(org_id, "kb_skill", ref_id)
                await self._record_promote_spend(org_id, kind="kb_skill", ref_id=ref_id)
        except Exception as exc:
            logger.warning("evidence_gate: promote failed: %s", exc)
            report.passed = False
            report.recommendation = "hold"
            report.explanation = f"promote failed: {exc}"

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
            if not row:
                return False
            kind = str(row["kind"] or "")
            ref_id = str(row["ref_id"] or "")
            if kind == "nudge":
                from eden.nudges.engine import NudgeEngine

                await NudgeEngine().set_mode(org_id, ref_id, "archived")
                await self._ledger_dnr(org_id, ref_id, reason=reason or "demoted")
            elif kind == "guardrail":
                await self._deactivate_live_guardrail(org_id, ref_id)
            return True
        except Exception as exc:
            logger.warning("evidence_gate: demote failed: %s", exc)
            return False

    async def _warm_and_meter(self, org_id: str, nudge_id: str, *, kind: str) -> None:
        try:
            from eden.llmops.warm_learn import warm_learn_caches
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if not client:
                return
            agent_id = await client.fetchval(
                "SELECT agent_id FROM nudges WHERE id = $1::uuid",
                nudge_id,
            )
            if agent_id:
                proof = await warm_learn_caches(org_id, str(agent_id))
                logger.info(
                    "evidence_gate: warm_cache proof org=%s agent=%s proof=%s",
                    org_id,
                    agent_id,
                    proof,
                )
            await self._record_promote_spend(org_id, kind=kind, ref_id=nudge_id)
        except Exception as exc:
            logger.debug("evidence_gate: warm/meter failed: %s", exc)

    async def _record_promote_spend(
        self, org_id: str, *, kind: str, ref_id: str
    ) -> None:
        try:
            from eden.llmops.cost_ledger import CostEvent, record_cost_event

            await record_cost_event(
                CostEvent(
                    org_id=org_id,
                    feature="promote",
                    model="evidence_gate",
                    cost_usd=0.0,
                    metadata={"kind": kind, "ref_id": ref_id},
                )
            )
        except Exception as exc:
            logger.debug("evidence_gate: promote spend tag failed: %s", exc)

    async def _ledger_dnr(self, org_id: str, nudge_id: str, *, reason: str) -> None:
        try:
            from eden.kb.ledger.generator import LedgerGenerator
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if not client:
                return
            row = await client.fetchrow(
                "SELECT agent_id, name FROM nudges WHERE id = $1::uuid AND org_id = $2",
                nudge_id,
                org_id,
            )
            if not row:
                return
            await LedgerGenerator().upsert_do_not_repeat(
                org_id,
                str(row["agent_id"]),
                text=f"Do not repeat fix `{row['name']}` — {reason}.",
                source_ids=[nudge_id],
            )
        except Exception as exc:
            logger.debug("evidence_gate: ledger DNR failed: %s", exc)

    async def _activate_live_guardrail(self, org_id: str, ref_id: str) -> None:
        """N15 — EvidenceGate promote bumps shadow log → live block."""
        try:
            from eden.llmops.filters.guardrail import get_guardrail_filter
            from eden.llmops.learn_wiring import install_learn_filters

            install_learn_filters()
            filt = get_guardrail_filter()
            policies = list(filt._policies.get(org_id) or [])
            updated = False
            for p in policies:
                if str(p.get("judge_id") or "") == ref_id or str(p.get("id") or "") == ref_id:
                    p["enforcement_level"] = "block"
                    updated = True
            if not updated:
                policies.append(
                    {
                        "judge_id": ref_id,
                        "enforcement_level": "block",
                        "keyword": ref_id,
                    }
                )
            filt.load_policies(org_id, policies)
        except Exception as exc:
            logger.debug("evidence_gate: activate guardrail failed: %s", exc)

    async def _deactivate_live_guardrail(self, org_id: str, ref_id: str) -> None:
        try:
            from eden.llmops.filters.guardrail import get_guardrail_filter

            filt = get_guardrail_filter()
            policies = [
                p
                for p in (filt._policies.get(org_id) or [])
                if str(p.get("judge_id") or "") != ref_id
                and str(p.get("id") or "") != ref_id
            ]
            filt.load_policies(org_id, policies)
        except Exception as exc:
            logger.debug("evidence_gate: deactivate guardrail failed: %s", exc)

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

    def _min_value_score(self) -> float:
        from eden.config import get_settings

        return float(get_settings().min_lift_per_100_tokens)

    async def _value_score_async(
        self,
        stumble_delta: float,
        candidate: dict[str, Any],
    ) -> float:
        from eden.llmops.inject_budget import estimate_tokens

        success_lift_pp = -stumble_delta * 100.0
        ref_id = str(candidate.get("ref_id") or "")
        tokens = 100
        if ref_id:
            try:
                from eden.storage.postgres import get_postgres_client

                client = await get_postgres_client()
                if client:
                    content = await client.fetchval(
                        "SELECT content FROM nudges WHERE id = $1::uuid",
                        ref_id,
                    )
                    if content:
                        tokens = estimate_tokens(str(content))
            except Exception:
                pass
        return success_lift_pp / max(tokens, 1) * 100.0

    def _value_score(
        self,
        stumble_delta: float,
        candidate: dict[str, Any],
        treatment: list[float],
    ) -> float:
        success_lift_pp = -stumble_delta * 100.0
        tokens = max(100, len(treatment) * 10)
        return success_lift_pp / max(tokens, 1) * 100.0

    async def evaluate_bayesian(
        self, org_id: str, candidate_id: str
    ) -> EvidenceReport:
        """Bayesian winner path for canaries + Artifacts.

        Honesty: Bayesian confidence never overrides ``min_n``. Under
        sample floor the report stays hold even if P(treatment better)
        looks high.
        """
        report = await self.evaluate(org_id, candidate_id)
        kind = "nudge"
        try:
            from eden.experiments._common import _prob_treatment_better

            candidate = await self.get_candidate(org_id, candidate_id)
            if not candidate:
                return report
            kind = str(candidate.get("kind") or "nudge")
            min_n = _MIN_SAMPLES.get(kind, 30)
            control = await self._baseline_metrics({**candidate, "org_id": org_id})
            treatment = await self._treatment_metrics({**candidate, "org_id": org_id})
            report.metrics["n_control"] = len(control)
            report.metrics["n_treatment"] = len(treatment)
            report.metrics["min_n"] = min_n
            report.metrics["bayesian_respects_min_n"] = True
            if len(control) < min_n or len(treatment) < min_n:
                report.passed = False
                report.recommendation = "hold"
                report.explanation = (
                    report.explanation
                    or f"insufficient samples for Bayesian path (need {min_n})"
                )
                if len(control) >= 5 and len(treatment) >= 5:
                    report.metrics["prob_treatment_better"] = _prob_treatment_better(
                        control, treatment
                    )
                    report.metrics["bayesian_advisory_only"] = True
                return report
            prob = _prob_treatment_better(control, treatment)
            report.metrics["prob_treatment_better"] = prob
            value_score = await self._value_score_async(
                report.metrics.get("stumble_rate_delta", 0.0), candidate
            )
            report.metrics["value_score"] = value_score
            if prob > 0.95 and value_score >= self._min_value_score():
                report.recommendation = "promote"
                report.passed = True
                report.gate_verdict = "APPLY"
            else:
                report.passed = False
                if report.recommendation == "promote":
                    report.recommendation = "hold"
        except Exception as exc:
            logger.debug("evidence_gate bayesian: %s", exc)
        return report
