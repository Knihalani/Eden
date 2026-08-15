"""F79 span-level score persistence."""

from __future__ import annotations

import logging
import uuid
from typing import Any

logger = logging.getLogger(__name__)


class SpanScoreStore:
    """Persist and query span-level scores."""

    def __init__(self, pg: Any | None = None) -> None:
        self._pg = pg

    async def _client(self) -> Any | None:
        if self._pg is not None:
            return self._pg
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None

    async def persist(
        self,
        org_id: str,
        *,
        trace_id: str,
        span_id: str,
        rule_id: str | None,
        scorer_type: str,
        score: float,
        passed: bool,
        label: str | None = None,
        rationale: str | None = None,
        confidence: float | None = None,
        cost_usd: float = 0.0,
        judge_tier: str = "slm",
    ) -> str | None:
        client = await self._client()
        if client is None:
            return None
        sid = str(uuid.uuid4())
        try:
            await client.execute(
                """
                INSERT INTO span_scores
                (id, org_id, trace_id, span_id, rule_id, scorer_type, score,
                 passed, label, rationale, confidence, cost_usd, judge_tier)
                VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6, $7, $8, $9, $10,
                        $11, $12, $13)
                """,
                sid,
                org_id,
                trace_id,
                span_id,
                rule_id,
                scorer_type,
                score,
                passed,
                label,
                rationale,
                confidence,
                cost_usd,
                judge_tier,
            )
            return sid
        except Exception as exc:
            logger.debug("span_scores: persist failed: %s", exc)
            return None

    async def list_for_trace(
        self, org_id: str, trace_id: str, *, span_id: str | None = None
    ) -> list[dict[str, Any]]:
        client = await self._client()
        if client is None:
            return []
        if span_id:
            rows = await client.fetch(
                """
                SELECT * FROM span_scores
                WHERE org_id = $1 AND trace_id = $2 AND span_id = $3
                ORDER BY scored_at DESC
                """,
                org_id,
                trace_id,
                span_id,
            )
        else:
            rows = await client.fetch(
                """
                SELECT * FROM span_scores
                WHERE org_id = $1 AND trace_id = $2
                ORDER BY scored_at DESC
                """,
                org_id,
                trace_id,
            )
        return [dict(r) for r in rows]

    async def list_for_span(self, org_id: str, span_id: str) -> list[dict[str, Any]]:
        client = await self._client()
        if client is None:
            return []
        rows = await client.fetch(
            """
            SELECT * FROM span_scores
            WHERE org_id = $1 AND span_id = $2
            ORDER BY scored_at DESC
            """,
            org_id,
            span_id,
        )
        return [dict(r) for r in rows]
