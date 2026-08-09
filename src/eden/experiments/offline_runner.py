"""F51 immutable offline experiment runner."""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from eden.experiments.compare import aggregate_grades, grade_datapoint
from eden.playground.llm_handler import LLMHandler, make_playground_handler
from eden.playground.scorers import aggregate_score, run_scorers
from eden.prompts.registry import Playground, PromptTemplate

logger = logging.getLogger(__name__)

_METHOD_LLM = "llm"
_METHOD_STORED_BASELINE = "stored_baseline"
_METHOD_OFFLINE_FALLBACK = "offline_fallback"


@dataclass
class OfflineExperiment:
    id: str
    org_id: str
    name: str
    dataset_id: str
    dataset_snapshot_id: str | None
    config: dict[str, Any]
    baseline_experiment_id: str | None
    source_issue_id: str | None
    status: str
    created_at: str = ""
    completed_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "org_id": self.org_id,
            "name": self.name,
            "dataset_id": self.dataset_id,
            "dataset_snapshot_id": self.dataset_snapshot_id,
            "config": dict(self.config),
            "baseline_experiment_id": self.baseline_experiment_id,
            "source_issue_id": self.source_issue_id,
            "status": self.status,
            "created_at": self.created_at,
            "completed_at": self.completed_at,
        }


class OfflineExperimentRunner:
    """Run immutable dataset × config experiments."""

    def __init__(
        self,
        pg: Any | None = None,
        *,
        llm_handler: LLMHandler | None = None,
    ) -> None:
        self._pg = pg
        self._llm_handler = llm_handler

    async def _client(self) -> Any | None:
        if self._pg is not None:
            return self._pg
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None

    def _playground(self, org_id: str) -> Playground:
        if self._llm_handler is not None:
            return Playground(self._llm_handler)
        return Playground(make_playground_handler(org_id))

    async def create(
        self,
        org_id: str,
        *,
        name: str,
        dataset_id: str,
        config: dict[str, Any] | None = None,
        baseline_experiment_id: str | None = None,
        source_issue_id: str | None = None,
        snapshot: bool = True,
    ) -> OfflineExperiment:
        exp_id = str(uuid.uuid4())
        snapshot_id: str | None = None
        if snapshot:
            from eden.datasets.hub import DatasetHub

            snap = await DatasetHub(self._pg).create_snapshot(org_id, dataset_id)
            snapshot_id = snap.id
        client = await self._client()
        cfg = config or {}
        now = datetime.now(UTC).isoformat()
        if client is None:
            return OfflineExperiment(
                id=exp_id,
                org_id=org_id,
                name=name,
                dataset_id=dataset_id,
                dataset_snapshot_id=snapshot_id,
                config=cfg,
                baseline_experiment_id=baseline_experiment_id,
                source_issue_id=source_issue_id,
                status="pending",
                created_at=now,
            )
        await client.execute(
            """
            INSERT INTO offline_experiments
                (id, org_id, name, dataset_id, dataset_snapshot_id, config,
                 baseline_experiment_id, source_issue_id, status)
            VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6::jsonb, $7::uuid, $8, 'pending')
            """,
            exp_id,
            org_id,
            name,
            dataset_id,
            snapshot_id,
            json.dumps(cfg),
            baseline_experiment_id,
            source_issue_id,
        )
        return OfflineExperiment(
            id=exp_id,
            org_id=org_id,
            name=name,
            dataset_id=dataset_id,
            dataset_snapshot_id=snapshot_id,
            config=cfg,
            baseline_experiment_id=baseline_experiment_id,
            source_issue_id=source_issue_id,
            status="pending",
            created_at=now,
        )

    async def run(self, org_id: str, experiment_id: str) -> dict[str, Any]:
        client = await self._client()
        if client is None:
            # Do not claim completed — callers must surface ErrorState, not false success.
            raise RuntimeError("database unavailable")
        row = await client.fetchrow(
            "SELECT * FROM offline_experiments WHERE org_id = $1 AND id = $2::uuid",
            org_id,
            experiment_id,
        )
        if row is None:
            raise ValueError("experiment not found")
        await client.execute(
            """
            UPDATE offline_experiments
            SET status = 'running', completed_at = NULL
            WHERE id = $1::uuid
            """,
            experiment_id,
        )
        try:
            dataset_id = str(row["dataset_id"])
            cfg = row["config"]
            if isinstance(cfg, str):
                cfg = json.loads(cfg)
            split_filter = cfg.get("split") if isinstance(cfg, dict) else None
            baseline_cfg: dict[str, Any] | None = None
            baseline_id = row.get("baseline_experiment_id")
            if baseline_id:
                baseline_cfg = await self._load_experiment_config(
                    org_id, str(baseline_id)
                )
            items = await client.fetch(
                """
                SELECT id, input, expected_output, payload
                FROM dataset_items
                WHERE dataset_id = $1::uuid
                  AND ($2::text IS NULL OR split = $2)
                """,
                dataset_id,
                split_filter,
            )
            grades: list[str] = []
            saw_synthetic = False
            methods: set[str] = set()
            for item in items:
                control = await self._run_control(
                    org_id, item, cfg, baseline_cfg=baseline_cfg
                )
                treatment = await self._run_treatment(org_id, item, cfg)
                if control.get("synthetic"):
                    saw_synthetic = True
                if treatment.get("synthetic"):
                    saw_synthetic = True
                methods.add(str(control.get("method") or _METHOD_LLM))
                methods.add(str(treatment.get("method") or _METHOD_LLM))
                grade, delta = grade_datapoint(control, treatment)
                grades.append(grade)
                await client.execute(
                    """
                    INSERT INTO experiment_datapoints
                        (id, experiment_id, row_id, input_data, control_output,
                         treatment_output, grade, score_delta)
                    VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8)
                    """,
                    str(uuid.uuid4()),
                    experiment_id,
                    str(item["id"]),
                    json.dumps({"input": item.get("input")}),
                    json.dumps(control),
                    json.dumps(treatment),
                    grade,
                    delta,
                )
            await client.execute(
                """
                UPDATE offline_experiments
                SET status = 'completed', completed_at = NOW()
                WHERE id = $1::uuid
                """,
                experiment_id,
            )
            return {
                "experiment_id": experiment_id,
                "status": "completed",
                "rows": len(items),
                "grades": aggregate_grades(grades),
                "synthetic": saw_synthetic,
                "method": _summarize_methods(methods),
            }
        except Exception:
            await client.execute(
                """
                UPDATE offline_experiments
                SET status = 'failed', completed_at = NOW()
                WHERE id = $1::uuid
                """,
                experiment_id,
            )
            raise

    async def compare(
        self, org_id: str, experiment_id: str, *, baseline_id: str | None = None
    ) -> dict[str, Any]:
        client = await self._client()
        if client is None:
            raise RuntimeError("database unavailable")
        exp = await client.fetchrow(
            "SELECT * FROM offline_experiments WHERE org_id = $1 AND id = $2::uuid",
            org_id,
            experiment_id,
        )
        if exp is None:
            raise ValueError("experiment not found")
        baseline = baseline_id or (
            str(exp["baseline_experiment_id"])
            if exp.get("baseline_experiment_id")
            else None
        )
        rows = await client.fetch(
            """
            SELECT row_id, input_data, control_output, treatment_output, grade, score_delta
            FROM experiment_datapoints WHERE experiment_id = $1::uuid ORDER BY created_at
            """,
            experiment_id,
        )
        datapoints = [dict(r) for r in rows]
        grades = [str(r.get("grade") or "tie") for r in rows]
        synthetic, method = _infer_run_metadata(datapoints)
        out: dict[str, Any] = {
            "experiment_id": experiment_id,
            "baseline_experiment_id": baseline,
            "source_issue_id": exp.get("source_issue_id"),
            "datapoints": datapoints,
            "summary": aggregate_grades(grades),
            "immutable": True,
            "dataset_snapshot_id": str(exp["dataset_snapshot_id"])
            if exp.get("dataset_snapshot_id")
            else None,
            "synthetic": synthetic,
            "method": method,
        }
        return out

    async def list_experiments(self, org_id: str, *, limit: int = 50) -> list[dict[str, Any]]:
        client = await self._client()
        if client is None:
            raise RuntimeError("database unavailable")
        rows = await client.fetch(
            """
            SELECT id, name, dataset_id, status, source_issue_id, created_at, completed_at
            FROM offline_experiments WHERE org_id = $1
            ORDER BY created_at DESC LIMIT $2
            """,
            org_id,
            limit,
        )
        return [dict(r) for r in rows]

    async def _load_experiment_config(
        self, org_id: str, experiment_id: str
    ) -> dict[str, Any] | None:
        client = await self._client()
        if client is None:
            return None
        row = await client.fetchrow(
            "SELECT config FROM offline_experiments WHERE org_id = $1 AND id = $2::uuid",
            org_id,
            experiment_id,
        )
        if row is None:
            return None
        cfg = row["config"]
        if isinstance(cfg, str):
            cfg = json.loads(cfg)
        return cfg if isinstance(cfg, dict) else None

    async def _run_control(
        self,
        org_id: str,
        item: dict[str, Any],
        config: dict[str, Any],
        *,
        baseline_cfg: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        global_scorers = list(config.get("scorers") or [])
        control_cfg = baseline_cfg or config
        control_task, _ = _resolve_tasks(control_cfg)
        baseline_output = _extract_baseline_output(item)
        if baseline_output is not None:
            return self._score_stored_output(
                baseline_output,
                item,
                control_task,
                global_scorers=global_scorers,
            )
        return await self._invoke_task(
            org_id,
            control_task,
            item,
            config,
            global_scorers=global_scorers,
        )

    async def _run_treatment(
        self,
        org_id: str,
        item: dict[str, Any],
        config: dict[str, Any],
    ) -> dict[str, Any]:
        global_scorers = list(config.get("scorers") or [])
        _, treatment_task = _resolve_tasks(config)
        return await self._invoke_task(
            org_id,
            treatment_task,
            item,
            config,
            global_scorers=global_scorers,
        )

    async def _invoke_task(
        self,
        org_id: str,
        task: dict[str, Any],
        item: dict[str, Any],
        config: dict[str, Any],
        *,
        global_scorers: list[dict[str, Any]],
    ) -> dict[str, Any]:
        user_input = str(item.get("input") or "")
        expected_raw = item.get("expected_output")
        expected = None if expected_raw is None else str(expected_raw)
        row_params = {
            "user": user_input,
            "expected": expected or "",
        }
        template = _task_to_template(task)
        playground = self._playground(org_id)
        result = await playground.run(template, row_params)
        specs = list(task.get("scorers") or global_scorers)
        scores = run_scorers(
            specs,
            output=result.response,
            expected=expected,
            input_text=user_input,
        )
        score = aggregate_score(scores)
        synthetic, method = _classify_llm_result(result)
        return {
            "score": score if score is not None else 0.0,
            "output": result.response,
            "model": result.model,
            "cost_usd": float(result.cost_usd or 0.0),
            "latency_ms": result.latency_ms,
            "scores": scores,
            "synthetic": synthetic,
            "method": method,
        }

    def _score_stored_output(
        self,
        output: str,
        item: dict[str, Any],
        task: dict[str, Any],
        *,
        global_scorers: list[dict[str, Any]],
    ) -> dict[str, Any]:
        expected_raw = item.get("expected_output")
        expected = None if expected_raw is None else str(expected_raw)
        specs = list(task.get("scorers") or global_scorers)
        scores = run_scorers(
            specs,
            output=output,
            expected=expected,
            input_text=str(item.get("input") or ""),
        )
        score = aggregate_score(scores)
        return {
            "score": score if score is not None else 0.0,
            "output": output,
            "model": "stored_baseline",
            "cost_usd": 0.0,
            "scores": scores,
            "synthetic": False,
            "method": _METHOD_STORED_BASELINE,
        }

    async def _run_row(self, item: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
        """Run the treatment task for one dataset row (test / legacy helper)."""
        org_id = str(config.get("org_id") or "")
        return await self._run_treatment(org_id, item, config)


def _resolve_tasks(config: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    tasks = list(config.get("tasks") or [])
    if not tasks:
        model = str(config.get("model") or "t1")
        default = {
            "id": "task_a",
            "label": "Default",
            "system": "",
            "user": "{{user}}",
            "model": model,
            "tools": [],
        }
        return default, dict(default)
    control = tasks[0]
    treatment = tasks[1] if len(tasks) > 1 else tasks[0]
    return control, treatment


def _task_to_template(task: dict[str, Any]) -> PromptTemplate:
    user_tpl = str(task.get("user") or "{{user}}")
    return PromptTemplate(
        name=str(task.get("label") or task.get("id") or "task"),
        system=str(task.get("system") or ""),
        user=user_tpl,
        tools=list(task.get("tools") or []),
        required_params=["user"] if "{{user}}" in user_tpl else [],
        optional_params=["expected"],
        model=str(task.get("model") or "t1"),
    )


def _extract_baseline_output(item: dict[str, Any]) -> str | None:
    raw = item.get("baseline_output")
    if raw is not None and str(raw).strip():
        return str(raw)
    payload = item.get("payload")
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (ValueError, TypeError):
            payload = None
    if isinstance(payload, dict):
        nested = payload.get("baseline_output")
        if nested is not None and str(nested).strip():
            return str(nested)
    return None


def _classify_llm_result(result: Any) -> tuple[bool, str]:
    model = str(getattr(result, "model", "") or "")
    response = str(getattr(result, "response", "") or "")
    if "+offline:" in model or response.startswith("[offline:"):
        return True, _METHOD_OFFLINE_FALLBACK
    return False, _METHOD_LLM


def _summarize_methods(methods: set[str]) -> str:
    if not methods:
        return _METHOD_LLM
    if len(methods) == 1:
        return next(iter(methods))
    return "mixed"


def _infer_run_metadata(datapoints: list[dict[str, Any]]) -> tuple[bool, str]:
    synthetic = False
    methods: set[str] = set()
    for row in datapoints:
        for key in ("control_output", "treatment_output"):
            raw = row.get(key)
            if raw is None:
                continue
            data = raw
            if isinstance(raw, str):
                try:
                    data = json.loads(raw)
                except (ValueError, TypeError):
                    continue
            if not isinstance(data, dict):
                continue
            if data.get("synthetic"):
                synthetic = True
            method = data.get("method")
            if method:
                methods.add(str(method))
    return synthetic, _summarize_methods(methods)


__all__ = ["OfflineExperimentRunner", "OfflineExperiment"]
