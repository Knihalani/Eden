"""U03/F49 playground CRUD + run orchestration (Postgres + memory fallback)."""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from eden.playground.diff import char_diff, grade_outputs
from eden.playground.llm_handler import make_playground_handler
from eden.prompts.registry import (
    Playground,
    PromptTemplate,
)

logger = logging.getLogger(__name__)


@dataclass
class PlaygroundRecord:
    id: str
    org_id: str
    name: str
    config: dict[str, Any] = field(default_factory=dict)
    created_by: str | None = None
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "org_id": self.org_id,
            "name": self.name,
            "config": dict(self.config),
            "created_by": self.created_by,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class PlaygroundService:
    """Org-scoped playgrounds with write-through Postgres (memory fallback)."""

    def __init__(self, pg: Any | None = None, *, memory_only: bool = False) -> None:
        self._pg = pg
        self._memory_only = memory_only
        self._memory: dict[str, PlaygroundRecord] = {}
        self._runs: dict[str, list[dict[str, Any]]] = {}

    async def _client(self) -> Any | None:
        if self._memory_only:
            return None
        if self._pg is not None:
            return self._pg
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None

    async def list(self, org_id: str, *, limit: int = 50) -> list[PlaygroundRecord]:
        client = await self._client()
        if client is None:
            return [p for p in self._memory.values() if p.org_id == org_id][:limit]
        rows = await client.fetch(
            """
            SELECT id, org_id, name, config, created_by, created_at, updated_at
            FROM playgrounds WHERE org_id = $1
            ORDER BY updated_at DESC LIMIT $2
            """,
            org_id,
            limit,
        )
        return [_row_to_pg(dict(r)) for r in rows]

    async def get(self, org_id: str, playground_id: str) -> PlaygroundRecord | None:
        client = await self._client()
        if client is None:
            rec = self._memory.get(playground_id)
            return rec if rec and rec.org_id == org_id else None
        row = await client.fetchrow(
            """
            SELECT id, org_id, name, config, created_by, created_at, updated_at
            FROM playgrounds WHERE org_id = $1 AND id = $2::uuid
            """,
            org_id,
            playground_id,
        )
        return _row_to_pg(dict(row)) if row else None

    async def create(
        self,
        org_id: str,
        *,
        name: str,
        config: dict[str, Any] | None = None,
        created_by: str | None = None,
    ) -> PlaygroundRecord:
        pid = str(uuid.uuid4())
        now = datetime.now(UTC).isoformat()
        cfg = config or _default_config()
        client = await self._client()
        if client is None:
            rec = PlaygroundRecord(
                id=pid,
                org_id=org_id,
                name=name,
                config=cfg,
                created_by=created_by,
                created_at=now,
                updated_at=now,
            )
            self._memory[pid] = rec
            return rec
        row = await client.fetchrow(
            """
            INSERT INTO playgrounds (id, org_id, name, config, created_by)
            VALUES ($1::uuid, $2, $3, $4::jsonb, $5)
            RETURNING id, org_id, name, config, created_by, created_at, updated_at
            """,
            pid,
            org_id,
            name,
            json.dumps(cfg),
            created_by,
        )
        return _row_to_pg(dict(row))

    async def update(
        self,
        org_id: str,
        playground_id: str,
        *,
        name: str | None = None,
        config: dict[str, Any] | None = None,
    ) -> PlaygroundRecord | None:
        existing = await self.get(org_id, playground_id)
        if existing is None:
            return None
        new_name = name if name is not None else existing.name
        new_cfg = config if config is not None else existing.config
        now = datetime.now(UTC).isoformat()
        client = await self._client()
        if client is None:
            existing.name = new_name
            existing.config = new_cfg
            existing.updated_at = now
            return existing
        row = await client.fetchrow(
            """
            UPDATE playgrounds
            SET name = $3, config = $4::jsonb, updated_at = NOW()
            WHERE org_id = $1 AND id = $2::uuid
            RETURNING id, org_id, name, config, created_by, created_at, updated_at
            """,
            org_id,
            playground_id,
            new_name,
            json.dumps(new_cfg),
        )
        return _row_to_pg(dict(row)) if row else None

    async def from_span(
        self,
        org_id: str,
        *,
        trace_id: str,
        span_id: str | None = None,
        messages: list[dict[str, Any]] | None = None,
        model: str | None = None,
        tools: list[dict[str, Any]] | None = None,
        created_by: str | None = None,
    ) -> PlaygroundRecord:
        user_text = ""
        system_text = ""
        for m in messages or []:
            role = str(m.get("role") or "")
            content = str(m.get("content") or "")
            if role == "system" and not system_text:
                system_text = content
            elif role in ("user", "human") and not user_text:
                user_text = content
            elif not user_text and content:
                user_text = content
        if not user_text:
            user_text = f"Replay span {span_id or 'root'} from trace {trace_id}"
        cfg = _default_config()
        cfg["source"] = {"trace_id": trace_id, "span_id": span_id}
        cfg["tasks"] = [
            {
                "id": "task_a",
                "label": "From span",
                "system": system_text,
                "user": user_text or "{{user}}",
                "model": model or "t1",
                "tools": tools or [],
            },
            {
                "id": "task_b",
                "label": "Variant",
                "system": system_text,
                "user": user_text or "{{user}}",
                "model": "t2",
                "tools": tools or [],
            },
        ]
        name = f"From span {span_id or trace_id[:8]}"
        return await self.create(org_id, name=name, config=cfg, created_by=created_by)

    async def run(
        self,
        org_id: str,
        playground_id: str,
        *,
        params: dict[str, Any] | None = None,
        dataset_rows: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        rec = await self.get(org_id, playground_id)
        if rec is None:
            raise ValueError("playground not found")
        params = params or {}
        tasks = list(rec.config.get("tasks") or [])
        if not tasks:
            tasks = [_default_task()]
        rows = dataset_rows or [{"id": "adhoc", "input": params.get("user", "")}]
        scorers = list(rec.config.get("scorers") or [])
        runner = Playground(make_playground_handler(org_id))
        matrix: list[dict[str, Any]] = []
        total_cost = 0.0
        for row in rows[:50]:
            row_id = str(row.get("id") or uuid.uuid4())
            row_params = {
                **params,
                "user": str(row.get("input") or params.get("user") or ""),
                "expected": str(row.get("expected_output") or ""),
            }
            task_results: list[dict[str, Any]] = []
            for task in tasks:
                template = PromptTemplate(
                    name=str(task.get("label") or task.get("id") or "task"),
                    system=str(task.get("system") or ""),
                    user=str(task.get("user") or "{{user}}"),
                    tools=list(task.get("tools") or []),
                    required_params=["user"]
                    if "{{user}}" in str(task.get("user") or "{{user}}")
                    else [],
                    optional_params=["expected"],
                    model=str(task.get("model") or "t1"),
                )
                # Ensure required params satisfied for freeform templates.
                if "user" not in row_params:
                    row_params["user"] = ""
                try:
                    result = await runner.run(template, row_params)
                except Exception as exc:
                    result_dict = {
                        "task_id": task.get("id"),
                        "error": str(exc),
                        "response": "",
                        "cost_usd": 0.0,
                    }
                    task_results.append(result_dict)
                    continue
                cost = float(result.cost_usd or 0.0)
                total_cost += cost
                scores: dict[str, Any] = {}
                for scorer in scorers:
                    name = str(scorer.get("name") or "exact")
                    expected = row_params.get("expected", "")
                    if name == "exact_match":
                        scores[name] = 1.0 if result.response == expected else 0.0
                    else:
                        scores[name] = 0.5
                task_results.append(
                    {
                        "task_id": task.get("id"),
                        "label": task.get("label"),
                        "model": result.model,
                        "response": result.response,
                        "latency_ms": result.latency_ms,
                        "cost_usd": cost,
                        "scores": scores,
                    }
                )
            grade = "tie"
            delta = 0.0
            diff: dict[str, Any] | None = None
            if len(task_results) >= 2:
                a = task_results[0]
                b = task_results[1]
                grade, delta = grade_outputs(
                    str(a.get("response") or ""),
                    str(b.get("response") or ""),
                    control_score=float(
                        (a.get("scores") or {}).get("exact_match", 0.5) or 0.5
                    ),
                    treatment_score=float(
                        (b.get("scores") or {}).get("exact_match", 0.5) or 0.5
                    ),
                    control_cost=float(a.get("cost_usd") or 0),
                    treatment_cost=float(b.get("cost_usd") or 0),
                )
                diff = char_diff(
                    str(a.get("response") or ""), str(b.get("response") or "")
                )
            matrix.append(
                {
                    "row_id": row_id,
                    "input": row_params.get("user"),
                    "tasks": task_results,
                    "grade": grade,
                    "score_delta": delta,
                    "diff": diff,
                }
            )
        run_id = str(uuid.uuid4())
        payload = {
            "run_id": run_id,
            "playground_id": playground_id,
            "status": "completed",
            "matrix": matrix,
            "cost_usd": round(total_cost, 6),
            "task_count": len(tasks),
            "row_count": len(matrix),
            "created_at": datetime.now(UTC).isoformat(),
        }
        await self._persist_run(org_id, playground_id, run_id, payload, total_cost)
        return payload

    async def promote_experiment(
        self,
        org_id: str,
        playground_id: str,
        *,
        name: str | None = None,
        dataset_id: str | None = None,
    ) -> dict[str, Any]:
        rec = await self.get(org_id, playground_id)
        if rec is None:
            raise ValueError("playground not found")
        ds_id = dataset_id or rec.config.get("dataset_id")
        if not ds_id:
            raise ValueError("dataset_id required to promote")
        from eden.experiments.offline_runner import OfflineExperimentRunner

        exp_name = name or f"From playground {rec.name}"
        runner = OfflineExperimentRunner()
        exp = await runner.create(
            org_id,
            name=exp_name,
            dataset_id=str(ds_id),
            config={
                "source_playground_id": playground_id,
                "tasks": rec.config.get("tasks") or [],
                "scorers": rec.config.get("scorers") or [],
            },
        )
        return {"experiment": exp.to_dict()}

    async def _persist_run(
        self,
        org_id: str,
        playground_id: str,
        run_id: str,
        payload: dict[str, Any],
        cost_usd: float,
    ) -> None:
        client = await self._client()
        if client is None:
            self._runs.setdefault(playground_id, []).append(payload)
            return
        try:
            await client.execute(
                """
                INSERT INTO playground_runs
                    (id, playground_id, org_id, status, results, cost_usd)
                VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6)
                """,
                run_id,
                playground_id,
                org_id,
                "completed",
                json.dumps(payload),
                cost_usd,
            )
        except Exception as exc:
            logger.warning("playground_run persist failed: %s", exc)
            self._runs.setdefault(playground_id, []).append(payload)


def _default_task() -> dict[str, Any]:
    return {
        "id": "task_a",
        "label": "Default",
        "system": "",
        "user": "{{user}}",
        "model": "t1",
        "tools": [],
    }


def _default_config() -> dict[str, Any]:
    return {
        "tasks": [
            _default_task(),
            {
                "id": "task_b",
                "label": "Compare",
                "system": "",
                "user": "{{user}}",
                "model": "t2",
                "tools": [],
            },
        ],
        "scorers": [{"name": "exact_match"}],
        "dataset_id": None,
        "params": {},
    }


def _row_to_pg(row: dict[str, Any]) -> PlaygroundRecord:
    cfg = row.get("config") or {}
    if isinstance(cfg, str):
        cfg = json.loads(cfg)
    created = row.get("created_at")
    updated = row.get("updated_at")
    return PlaygroundRecord(
        id=str(row["id"]),
        org_id=str(row["org_id"]),
        name=str(row["name"]),
        config=dict(cfg),
        created_by=row.get("created_by"),
        created_at=created.isoformat() if hasattr(created, "isoformat") else str(created or ""),
        updated_at=updated.isoformat() if hasattr(updated, "isoformat") else str(updated or ""),
    )


__all__ = ["PlaygroundRecord", "PlaygroundService"]
