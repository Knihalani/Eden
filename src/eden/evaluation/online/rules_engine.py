"""F52 online scoring rules engine."""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from eden.evaluation.online.scorer_cascade import OnlineScorerCascade

logger = logging.getLogger(__name__)


@dataclass
class ScoringRule:
    id: str
    org_id: str
    name: str
    description: str
    scope: str
    filter_query: str
    scorer_type: str
    scorer_ref: str | None
    sample_rate: float
    enabled: bool
    version: int
    config: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "org_id": self.org_id,
            "name": self.name,
            "description": self.description,
            "scope": self.scope,
            "filter_query": self.filter_query,
            "scorer_type": self.scorer_type,
            "scorer_ref": self.scorer_ref,
            "sample_rate": self.sample_rate,
            "enabled": self.enabled,
            "version": self.version,
            "config": self.config,
        }


def _row_to_rule(row: dict[str, Any]) -> ScoringRule:
    return ScoringRule(
        id=str(row["id"]),
        org_id=str(row["org_id"]),
        name=str(row["name"]),
        description=str(row.get("description") or ""),
        scope=str(row.get("scope") or "trace"),
        filter_query=str(row.get("filter_query") or ""),
        scorer_type=str(row.get("scorer_type") or "slm"),
        scorer_ref=row.get("scorer_ref"),
        sample_rate=float(row.get("sample_rate") or 1.0),
        enabled=bool(row.get("enabled", True)),
        version=int(row.get("version") or 1),
        config=dict(row.get("config") or {}),
    )


class OnlineScoringRulesEngine:
    """CRUD + apply online scoring rules on production traces/spans."""

    def __init__(self, pg: Any | None = None) -> None:
        self._pg = pg
        self._cascade = OnlineScorerCascade()

    async def _client(self) -> Any | None:
        if self._pg is not None:
            return self._pg
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None

    async def list_rules(self, org_id: str) -> list[ScoringRule]:
        client = await self._client()
        if client is None:
            return []
        rows = await client.fetch(
            "SELECT * FROM online_scoring_rules WHERE org_id = $1 "
            "ORDER BY updated_at DESC",
            org_id,
        )
        return [_row_to_rule(dict(r)) for r in rows]

    async def get_rule(self, org_id: str, rule_id: str) -> ScoringRule | None:
        client = await self._client()
        if client is None:
            return None
        row = await client.fetchrow(
            "SELECT * FROM online_scoring_rules WHERE org_id = $1 AND id = $2::uuid",
            org_id,
            rule_id,
        )
        return _row_to_rule(dict(row)) if row else None

    async def create_rule(
        self,
        org_id: str,
        *,
        name: str,
        description: str = "",
        scope: str = "trace",
        filter_query: str = "",
        scorer_type: str = "slm",
        scorer_ref: str | None = None,
        sample_rate: float = 1.0,
        config: dict[str, Any] | None = None,
    ) -> ScoringRule | None:
        client = await self._client()
        if client is None:
            return None
        rid = str(uuid.uuid4())
        await client.execute(
            """
            INSERT INTO online_scoring_rules
            (id, org_id, name, description, scope, filter_query, scorer_type,
             scorer_ref, sample_rate, config)
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
            """,
            rid,
            org_id,
            name,
            description,
            scope,
            filter_query,
            scorer_type,
            scorer_ref,
            sample_rate,
            __import__("json").dumps(config or {}),
        )
        return await self.get_rule(org_id, rid)

    async def update_rule(
        self, org_id: str, rule_id: str, **fields: Any
    ) -> ScoringRule | None:
        rule = await self.get_rule(org_id, rule_id)
        if rule is None:
            return None
        client = await self._client()
        if client is None:
            return None
        name = fields.get("name", rule.name)
        description = fields.get("description", rule.description)
        scope = fields.get("scope", rule.scope)
        filter_query = fields.get("filter_query", rule.filter_query)
        scorer_type = fields.get("scorer_type", rule.scorer_type)
        scorer_ref = fields.get("scorer_ref", rule.scorer_ref)
        sample_rate = fields.get("sample_rate", rule.sample_rate)
        enabled = fields.get("enabled", rule.enabled)
        config = fields.get("config", rule.config)
        version = rule.version + 1
        await client.execute(
            """
            UPDATE online_scoring_rules SET
                name = $3, description = $4, scope = $5, filter_query = $6,
                scorer_type = $7, scorer_ref = $8, sample_rate = $9,
                enabled = $10, version = $11, config = $12::jsonb,
                updated_at = NOW()
            WHERE org_id = $1 AND id = $2::uuid
            """,
            org_id,
            rule_id,
            name,
            description,
            scope,
            filter_query,
            scorer_type,
            scorer_ref,
            sample_rate,
            enabled,
            version,
            __import__("json").dumps(config),
        )
        return await self.get_rule(org_id, rule_id)

    async def apply_rules_for_trace(
        self,
        org_id: str,
        trace_id: str,
        *,
        agent_id: str | None = None,
        span_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Evaluate enabled rules; persist span/trace scores when cascade succeeds."""
        from eden.evaluation.online.span_scores import SpanScoreStore

        rules = [r for r in await self.list_rules(org_id) if r.enabled]
        if not rules:
            return []

        store = SpanScoreStore(pg=self._pg)
        results: list[dict[str, Any]] = []
        for rule in rules:
            if rule.scope == "span" and not span_id:
                continue
            if not self._matches_filter(rule.filter_query, trace_id, agent_id):
                continue
            scored = await self._cascade.score(
                org_id,
                trace_id=trace_id,
                span_id=span_id,
                scorer_type=rule.scorer_type,
                scorer_ref=rule.scorer_ref,
                payload={"agent_id": agent_id, "rule_id": rule.id},
            )
            if scored is None:
                continue
            row_id = await store.persist(
                org_id,
                trace_id=trace_id,
                span_id=span_id or trace_id,
                rule_id=rule.id,
                scorer_type=rule.scorer_type,
                score=float(scored.get("score") or 0),
                passed=bool(scored.get("passed")),
                label=scored.get("label"),
                rationale=scored.get("rationale"),
                confidence=scored.get("confidence"),
                cost_usd=float(scored.get("cost_usd") or 0),
                judge_tier=str(scored.get("judge_tier") or "slm"),
            )
            if row_id:
                results.append({"rule_id": rule.id, "score_id": row_id, **scored})
                await self._maybe_fire_automations(org_id, rule, scored, trace_id)
        return results

    def _matches_filter(
        self, filter_query: str, trace_id: str, agent_id: str | None
    ) -> bool:
        if not filter_query or filter_query.strip() in ("*", "true"):
            return True
        q = filter_query.lower()
        if agent_id and f"agent_id:{agent_id.lower()}" in q:
            return True
        if f"trace_id:{trace_id.lower()}" in q:
            return True
        return True

    async def rewind(self, org_id: str, rule_id: str, *, limit: int = 100) -> str | None:
        """Enqueue reprocess of recent traces for a rule (F52 rewind)."""
        client = await self._client()
        if client is None:
            return None
        job_id = str(uuid.uuid4())
        await client.execute(
            """
            INSERT INTO online_scoring_rewind_jobs (id, org_id, rule_id, status)
            VALUES ($1::uuid, $2, $3::uuid, 'pending')
            """,
            job_id,
            org_id,
            rule_id,
        )
        rows = await client.fetch(
            """
            SELECT DISTINCT trace_id FROM telemetry_events
            WHERE tenant_id = $1 ORDER BY timestamp DESC LIMIT $2
            """,
            org_id,
            limit,
        )
        processed = 0
        for row in rows:
            await self.apply_rules_for_trace(org_id, str(row["trace_id"]))
            processed += 1
        await client.execute(
            """
            UPDATE online_scoring_rewind_jobs
            SET status = 'completed', traces_processed = $3, completed_at = NOW()
            WHERE id = $1::uuid AND org_id = $2
            """,
            job_id,
            org_id,
            processed,
        )
        return job_id

    async def _maybe_fire_automations(
        self,
        org_id: str,
        rule: ScoringRule,
        scored: dict[str, Any],
        trace_id: str,
    ) -> None:
        try:
            from eden.automations.engine import AutomationsEngine

            await AutomationsEngine(pg=self._pg).on_score(
                org_id,
                rule_id=rule.id,
                trace_id=trace_id,
                score=float(scored.get("score") or 0),
                passed=bool(scored.get("passed")),
            )
        except Exception as exc:
            logger.debug("rules_engine: automation hook failed: %s", exc)
