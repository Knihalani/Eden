"""F61 automations engine — score threshold → dataset/queue/issue/alert."""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

logger = logging.getLogger(__name__)


class AutomationsEngine:
    """Unified automations on online scores and production events."""

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

    async def list_automations(self, org_id: str) -> list[dict[str, Any]]:
        client = await self._client()
        if client is None:
            return []
        rows = await client.fetch(
            "SELECT * FROM automations WHERE org_id = $1 ORDER BY updated_at DESC",
            org_id,
        )
        return [dict(r) for r in rows]

    async def create(
        self,
        org_id: str,
        *,
        name: str,
        trigger_type: str = "score_threshold",
        trigger_config: dict[str, Any] | None = None,
        action_type: str = "dataset",
        action_config: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        client = await self._client()
        if client is None:
            return None
        aid = str(uuid.uuid4())
        await client.execute(
            """
            INSERT INTO automations
            (id, org_id, name, trigger_type, trigger_config, action_type, action_config)
            VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
            """,
            aid,
            org_id,
            name,
            trigger_type,
            json.dumps(trigger_config or {}),
            action_type,
            json.dumps(action_config or {}),
        )
        return {"id": aid, "name": name, "trigger_type": trigger_type, "action_type": action_type}

    async def on_score(
        self,
        org_id: str,
        *,
        rule_id: str,
        trace_id: str,
        score: float,
        passed: bool,
    ) -> list[dict[str, Any]]:
        client = await self._client()
        if client is None:
            return []
        rows = await client.fetch(
            "SELECT * FROM automations WHERE org_id = $1 AND enabled = true",
            org_id,
        )
        fired: list[dict[str, Any]] = []
        for row in rows:
            trigger = dict(row.get("trigger_config") or {})
            if str(row.get("trigger_type")) != "score_threshold":
                continue
            min_score = trigger.get("min_score")
            max_score = trigger.get("max_score")
            require_fail = bool(trigger.get("require_fail"))
            rule_match = trigger.get("rule_id")
            if rule_match and str(rule_match) != rule_id:
                continue
            if min_score is not None and score < float(min_score):
                continue
            if max_score is not None and score > float(max_score):
                continue
            if require_fail and passed:
                continue
            result = await self._execute_action(
                org_id,
                str(row["action_type"]),
                dict(row.get("action_config") or {}),
                trace_id=trace_id,
                score=score,
            )
            run_id = await self._log_run(org_id, str(row["id"]), result)
            fired.append({"automation_id": str(row["id"]), "run_id": run_id, **result})
        return fired

    async def _execute_action(
        self,
        org_id: str,
        action_type: str,
        config: dict[str, Any],
        *,
        trace_id: str,
        score: float,
    ) -> dict[str, Any]:
        if action_type == "dataset":
            dataset_name = str(config.get("dataset_name") or "automation-captures")
            try:
                from eden.datasets.hub import DatasetHub

                hub = DatasetHub(pg=self._pg)
                result = await hub.promote_trace(
                    org_id, trace_id, dataset_name=dataset_name
                )
                return {"action": "dataset", "result": result}
            except Exception as exc:
                logger.debug("automations: dataset action failed: %s", exc)
                return {"action": "dataset", "error": str(exc)}
        if action_type == "queue":
            queue_id = config.get("queue_id")
            return {"action": "queue", "queue_id": queue_id, "trace_id": trace_id}
        if action_type == "alert":
            return {
                "action": "alert",
                "trace_id": trace_id,
                "score": score,
                "message": config.get("message") or "score threshold breached",
            }
        return {"action": action_type, "trace_id": trace_id, "score": score}

    async def _log_run(
        self, org_id: str, automation_id: str, payload: dict[str, Any]
    ) -> str | None:
        client = await self._client()
        if client is None:
            return None
        rid = str(uuid.uuid4())
        try:
            await client.execute(
                """
                INSERT INTO automation_runs (id, org_id, automation_id, payload)
                VALUES ($1::uuid, $2, $3::uuid, $4::jsonb)
                """,
                rid,
                org_id,
                automation_id,
                json.dumps(payload),
            )
            return rid
        except Exception:
            return None
