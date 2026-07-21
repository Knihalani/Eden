"""Shadow match → fingerprint outcome join (async SQL, $0 LLM)."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


class ShadowOutcomeJoiner:
    """Attribute later stumbles on same fingerprint to shadow nudge_outcomes."""

    async def run_once(self, *, limit: int = 200) -> dict[str, Any]:
        updated = 0
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return {"updated": 0}

            rows = await client.fetch(
                """
                SELECT no.id AS outcome_id, no.trace_id, n.id AS nudge_id,
                       ai.fingerprint
                FROM nudge_outcomes no
                JOIN nudges n ON n.id = no.nudge_id
                JOIN agent_issues ai
                  ON ai.org_id = n.org_id
                 AND ai.agent_id = n.agent_id
                 AND ai.fingerprint IS NOT NULL
                 AND (
                       n.source_issue_id IS NULL
                    OR ai.id::text = n.source_issue_id
                 )
                WHERE no.mode = 'shadow'
                  AND no.outcome_success IS NULL
                  AND no.matched = true
                  AND no.recorded_at >= now() - interval '14 days'
                LIMIT $1
                """,
                limit,
            )
            for row in rows or []:
                fp = row.get("fingerprint")
                if not fp:
                    continue
                stumble = await client.fetchval(
                    """
                    SELECT EXISTS (
                        SELECT 1 FROM agent_issues
                        WHERE fingerprint = $1
                          AND status = 'open'
                          AND created_at > (
                              SELECT recorded_at FROM nudge_outcomes WHERE id = $2
                          )
                    )
                    """,
                    fp,
                    row["outcome_id"],
                )
                if stumble is None:
                    continue
                success = not bool(stumble)
                await client.execute(
                    """
                    UPDATE nudge_outcomes
                    SET outcome_success = $2
                    WHERE id = $1 AND outcome_success IS NULL
                    """,
                    row["outcome_id"],
                    success,
                )
                updated += 1
        except Exception as exc:
            logger.debug("shadow outcome join failed: %s", exc)
        return {"updated": updated}
