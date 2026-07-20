"""F51 immutable offline experiment runner."""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from eden.experiments.compare import aggregate_grades, grade_datapoint

logger = logging.getLogger(__name__)


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
            items = await client.fetch(
                "SELECT id, input, expected_output, payload FROM dataset_items WHERE dataset_id = $1::uuid",
                dataset_id,
            )
            grades: list[str] = []
            for item in items:
                control = {
                    "score": 0.5,
                    "output": item.get("expected_output") or "",
                    "synthetic": True,
                    "method": "heuristic_stub",
                }
                treatment = await self._run_row(item, cfg)
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
                "synthetic": True,
                "method": "heuristic_stub",
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
            "synthetic": True,
            "method": "heuristic_stub",
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

    async def _run_row(self, item: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
        """Deterministic heuristic stub — not a live model score.

        Scores are labeled ``synthetic: true`` / ``method: heuristic_stub``
        so API + portal never present them as real LLM evals.
        """
        expected = str(item.get("expected_output") or "")
        payload = item.get("payload")
        if isinstance(payload, str):
            payload = json.loads(payload)
        input_text = str(item.get("input") or "")
        model = str(config.get("model") or "baseline")
        score = 0.7 if expected else 0.5
        if expected and expected in input_text:
            score = 0.9
        return {
            "score": score,
            "output": expected or input_text[:200],
            "model": model,
            "cost_usd": float(config.get("cost_usd", 0.001) or 0.001),
            "synthetic": True,
            "method": "heuristic_stub",
        }


__all__ = ["OfflineExperimentRunner", "OfflineExperiment"]
