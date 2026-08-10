"""N03 — ProductionEvalSampler: policy + budget gate on trace.finalized."""

from __future__ import annotations

import hashlib
import logging
import uuid
from datetime import date
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT_SAMPLE_RATE = 0.02
_SCORE_COST_USD = 0.001


class ProductionEvalSampler:
    """Sample production traces and record lightweight eval scores."""

    name = "production_eval_sampler"

    async def maybe_score_trace(
        self,
        org_id: str,
        trace_id: str,
        *,
        agent_id: str | None = None,
        is_stumble: bool = False,
        events: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any] | None:
        """Sample production traces and record lightweight eval scores.

        ``events`` is the trace's already-fetched event list (the
        trace.finalized pipeline fetches it once and threads it through
        every stage). Passing it lets the rules engine derive judge
        content from memory instead of issuing its own telemetry_events
        read for the sampled trace.
        """
        if not self._enabled():
            return None
        policy = await self._resolve_policy(org_id, agent_id)
        if not policy.get("enabled", True):
            return None
        if not is_stumble and not self._should_sample(trace_id, policy):
            return None
        # Stumbles skip the sample RATE (a failing trace is always worth
        # scoring) but never the spend CAP — a looping agent emits stumbles
        # in bursts, so the budget gate must apply to them most of all.
        if not await self._budget_allows(org_id, policy):
            return None
        score, passed, billed_cost = await self._score_trace(
            org_id, trace_id, agent_id, events=events
        )
        if score == 0.0 and not passed and billed_cost == 0.0:
            rules_exist = await self._org_has_rules(org_id)
            if not rules_exist:
                return None
        row_id = await self._persist_score(
            org_id, trace_id, agent_id, score, passed, cost_usd=billed_cost
        )
        if row_id:
            if billed_cost > 0:
                await self._bump_spend(org_id, billed_cost)
            if agent_id:
                await self._touch_registry(org_id, agent_id)
        return {
            "score_id": row_id,
            "trace_id": trace_id,
            "score": score,
            "passed": passed,
        }

    def _enabled(self) -> bool:
        try:
            from eden.config import get_settings

            return bool(getattr(get_settings(), "production_eval_sampling_v1", True))
        except Exception:
            return True

    def _should_sample(self, trace_id: str, policy: dict[str, Any]) -> bool:
        rate = float(policy.get("sample_rate") or _DEFAULT_SAMPLE_RATE)
        h = int(hashlib.sha256(trace_id.encode()).hexdigest()[:8], 16)
        return (h % 10_000) < int(rate * 10_000)

    async def _resolve_policy(
        self, org_id: str, agent_id: str | None
    ) -> dict[str, Any]:
        client = await self._client()
        if client is None:
            return {"sample_rate": _DEFAULT_SAMPLE_RATE, "enabled": True}
        try:
            if agent_id:
                row = await client.fetchrow(
                    "SELECT * FROM production_eval_policies "
                    "WHERE org_id = $1 AND agent_id = $2 AND enabled = true "
                    "ORDER BY updated_at DESC LIMIT 1",
                    org_id,
                    agent_id,
                )
                if row:
                    return dict(row)
            row = await client.fetchrow(
                "SELECT * FROM production_eval_policies "
                "WHERE org_id = $1 AND agent_id IS NULL AND enabled = true "
                "ORDER BY updated_at DESC LIMIT 1",
                org_id,
            )
            if row:
                return dict(row)
        except Exception as exc:
            logger.debug("prod_eval: policy lookup failed: %s", exc)
        return {
            "sample_rate": _DEFAULT_SAMPLE_RATE,
            "max_cost_usd_per_day": 50.0,
            "enabled": True,
        }

    async def _budget_allows(self, org_id: str, policy: dict[str, Any]) -> bool:
        cap = float(policy.get("max_cost_usd_per_day") or 50.0)
        client = await self._client()
        if client is None:
            return True
        today = date.today()
        try:
            row = await client.fetchrow(
                "SELECT spend_usd FROM production_eval_daily_spend "
                "WHERE org_id = $1 AND date = $2",
                org_id,
                today,
            )
            spent = float(row["spend_usd"]) if row else 0.0
            return spent + _SCORE_COST_USD <= cap
        except Exception as exc:
            logger.warning(
                "prod_eval: budget check DB error — failing closed: %s", exc
            )
            return False

    async def _score_trace(
        self,
        org_id: str,
        trace_id: str,
        agent_id: str | None,
        *,
        events: list[dict[str, Any]] | None = None,
    ) -> tuple[float, bool, float]:
        """Apply online rules; reuse Layer A scores; skip if no signal.

        ``events`` (when provided) is forwarded to the rules engine so it
        can build the judge payload from the already-fetched trace events
        instead of re-reading telemetry_events itself.
        """
        try:
            from eden.evaluation.online.rules_engine import OnlineScoringRulesEngine

            engine = OnlineScoringRulesEngine()
            applied = await engine.apply_rules_for_trace(
                org_id, trace_id, agent_id=agent_id, events=events
            )
            if applied:
                score = float(applied[0].get("score") or 0)
                return score, bool(applied[0].get("passed")), float(
                    applied[0].get("cost_usd") or 0
                )
        except Exception:
            pass

        client = await self._client()
        if client is not None:
            try:
                row = await client.fetchrow(
                    "SELECT AVG(score) AS avg_score FROM judge_scores "
                    "WHERE tenant_id = $1 AND trace_id = $2",
                    org_id,
                    trace_id,
                )
                if row and row["avg_score"] is not None:
                    score = float(row["avg_score"])
                    return score, score >= 0.7, 0.0
            except Exception:
                pass
            try:
                row = await client.fetchrow(
                    "SELECT quality_score FROM trace_quality_reports "
                    "WHERE org_id = $1 AND trace_id = $2 "
                    "ORDER BY created_at DESC LIMIT 1",
                    org_id,
                    trace_id,
                )
                if row and row.get("quality_score") is not None:
                    score = float(row["quality_score"])
                    return score, score >= 0.6, 0.0
            except Exception:
                pass
        # No rules matched and no existing scores — do not invent scores.
        return 0.0, False, 0.0

    async def _persist_score(
        self,
        org_id: str,
        trace_id: str,
        agent_id: str | None,
        score: float,
        passed: bool,
        *,
        cost_usd: float = _SCORE_COST_USD,
    ) -> str | None:
        client = await self._client()
        if client is None:
            return None
        sid = str(uuid.uuid4())
        try:
            await client.execute(
                "INSERT INTO production_eval_scores "
                "(id, org_id, trace_id, agent_id, score, passed, cost_usd, "
                "judge_tier, scored_at) "
                "VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, 'slm', NOW())",
                sid,
                org_id,
                trace_id,
                agent_id,
                score,
                passed,
                float(cost_usd),
            )
            return sid
        except Exception as exc:
            logger.debug("prod_eval: persist failed: %s", exc)
            return None

    async def _bump_spend(self, org_id: str, cost: float) -> None:
        client = await self._client()
        if client is None:
            return
        today = date.today()
        try:
            await client.execute(
                "INSERT INTO production_eval_daily_spend "
                "(org_id, date, spend_usd, traces_scored) "
                "VALUES ($1, $2, $3, 1) "
                "ON CONFLICT (org_id, date) DO UPDATE SET "
                "spend_usd = production_eval_daily_spend.spend_usd + $3, "
                "traces_scored = production_eval_daily_spend.traces_scored + 1",
                org_id,
                today,
                cost,
            )
        except Exception as exc:
            logger.debug("prod_eval: spend bump failed: %s", exc)

    async def _touch_registry(self, org_id: str, agent_id: str) -> None:
        client = await self._client()
        if client is None:
            return
        try:
            await client.execute(
                "INSERT INTO agent_registry (org_id, agent_id, first_seen, last_seen) "
                "VALUES ($1, $2, NOW(), NOW()) "
                "ON CONFLICT (org_id, agent_id) DO UPDATE SET last_seen = NOW()",
                org_id,
                agent_id,
            )
        except Exception as exc:
            logger.debug("prod_eval: registry touch failed: %s", exc)

    async def get_quality_trend(
        self, org_id: str, agent_id: str, *, hours: int = 168
    ) -> list[dict[str, Any]]:
        client = await self._client()
        if client is None:
            return []
        try:
            rows = await client.fetch(
                "SELECT date_trunc('hour', scored_at) AS hour, "
                "AVG(score) AS avg_score, COUNT(*) AS n, "
                "SUM(CASE WHEN NOT passed THEN 1 ELSE 0 END)::float "
                "/ NULLIF(COUNT(*), 0) AS fail_rate "
                "FROM production_eval_scores "
                "WHERE org_id = $1 AND agent_id = $2 "
                "AND scored_at > NOW() - ($3 || ' hours')::interval "
                "GROUP BY 1 ORDER BY 1",
                org_id,
                agent_id,
                str(hours),
            )
            return [
                {
                    "hour": r["hour"].isoformat() if r["hour"] else None,
                    "avg_score": float(r["avg_score"] or 0),
                    "n": int(r["n"] or 0),
                    "fail_rate": float(r["fail_rate"] or 0),
                }
                for r in rows
            ]
        except Exception as exc:
            logger.debug("prod_eval: trend failed: %s", exc)
            return []

    async def _org_has_rules(self, org_id: str) -> bool:
        client = await self._client()
        if client is None:
            return False
        try:
            n = await client.fetchval(
                "SELECT count(*) FROM online_scoring_rules "
                "WHERE org_id = $1 AND enabled = true",
                org_id,
            )
            return int(n or 0) > 0
        except Exception:
            return False

    async def _client(self) -> Any | None:
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None
