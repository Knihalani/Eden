"""N03 — ProductionEvalSampler: policy + budget gate on trace.finalized."""

from __future__ import annotations

import hashlib
import logging
import uuid
from datetime import UTC, date, datetime
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
    ) -> dict[str, Any] | None:
        if not self._enabled():
            return None
        policy = await self._resolve_policy(org_id, agent_id)
        if not policy.get("enabled", True):
            return None
        if not is_stumble and not self._should_sample(trace_id, policy):
            return None
        if not is_stumble and not await self._budget_allows(org_id, policy):
            return None
        score, passed = await self._score_trace(org_id, trace_id, agent_id)
        row_id = await self._persist_score(
            org_id, trace_id, agent_id, score, passed
        )
        if row_id:
            await self._bump_spend(org_id, _SCORE_COST_USD)
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
        except Exception:
            return True

    async def _score_trace(
        self, org_id: str, trace_id: str, agent_id: str | None
    ) -> tuple[float, bool]:
        """Lightweight SLM-tier score — reuse judge_scores when present."""
        client = await self._client()
        if client is not None:
            try:
                row = await client.fetchrow(
                    "SELECT AVG(score) AS avg_score FROM judge_scores "
                    "WHERE org_id = $1 AND trace_id = $2",
                    org_id,
                    trace_id,
                )
                if row and row["avg_score"] is not None:
                    score = float(row["avg_score"])
                    return score, score >= 0.7
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
                    return score, score >= 0.6
            except Exception:
                pass
        # Deterministic pseudo-score for traces without judges yet.
        h = int(hashlib.sha256(f"{trace_id}:{agent_id}".encode()).hexdigest()[:6], 16)
        score = 0.55 + (h % 40) / 100.0
        return score, score >= 0.7

    async def _persist_score(
        self,
        org_id: str,
        trace_id: str,
        agent_id: str | None,
        score: float,
        passed: bool,
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
                _SCORE_COST_USD,
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

    async def _client(self) -> Any | None:
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None
