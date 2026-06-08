"""OpenLineage lineage tracking for Eden data platform.

Tracks the provenance of data through the Bronze → Silver → Gold pipeline:
- Which job produced which dataset
- Which upstream tables feed into downstream aggregations
- Schema evolution over time
- Column-level lineage (which fields are derived from which sources)

Usage:
    from eden.data_platform.lineage import LineageTracker
    tracker = LineageTracker()
    await tracker.record_run(
        job_name="silver_etl_daily",
        inputs=[Dataset("bronze.usage_events", "postgres")],
        outputs=[Dataset("silver.silver_events", "postgres")],
        facets={"quality_score": 0.98, "rows_processed": 15000},
    )
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from eden.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


@dataclass
class Dataset:
    """Represents a dataset in the lineage graph."""

    name: str
    namespace: str = "eden"
    storage: str = "postgres"  # postgres, s3, clickhouse, iceberg
    schema_version: str = "1.0"
    fields: list[dict[str, Any]] = field(default_factory=list)

    def to_openlineage(self) -> dict[str, Any]:
        return {
            "namespace": self.namespace,
            "name": self.name,
            "facets": {
                "storage": {"_producer": "eden", "_schemaURL": "", "storageType": self.storage},
                "schema": {
                    "_producer": "eden",
                    "_schemaURL": "",
                    "fields": self.fields,
                },
            },
        }


@dataclass
class ColumnLineage:
    """Column-level lineage: which output columns derive from which input columns."""

    output_column: str
    input_dataset: str
    input_column: str
    transformation: str = "direct"  # direct, derived, aggregated


@dataclass
class LineageRun:
    """A single lineage run record."""

    run_id: str
    job_name: str
    job_namespace: str = "eden"
    event_type: str = "COMPLETE"  # START, COMPLETE, FAIL, ABORT
    inputs: list[Dataset] = field(default_factory=list)
    outputs: list[Dataset] = field(default_factory=list)
    facets: dict[str, Any] = field(default_factory=dict)
    column_lineage: list[ColumnLineage] = field(default_factory=list)
    started_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    ended_at: Optional[str] = None

    def to_openlineage(self) -> dict[str, Any]:
        return {
            "eventTime": self.ended_at or self.started_at,
            "run": {
                "runId": self.run_id,
                "facets": {
                    "nominalTime": {
                        "_producer": "eden",
                        "_schemaURL": "",
                        "nominalStartTime": self.started_at,
                        "nominalEndTime": self.ended_at,
                    },
                },
            },
            "job": {
                "namespace": self.job_namespace,
                "name": self.job_name,
            },
            "inputs": [d.to_openlineage() for d in self.inputs],
            "outputs": [d.to_openlineage() for d in self.outputs],
            "producer": "eden",
        }


class LineageTracker:
    """Tracks data lineage across the Eden data platform.

    Stores lineage events in PostgreSQL for durability and exposes
    OpenLineage-compatible JSON for integration with external tools
    (Marquez, DataHub, etc.).
    """

    def __init__(self) -> None:
        self._postgres_client: Optional[Any] = None

    async def _get_postgres(self) -> Any:
        if self._postgres_client is None:
            from eden.storage.postgres import get_postgres_client
            self._postgres_client = await get_postgres_client()
        return self._postgres_client

    async def record_run(
        self,
        job_name: str,
        inputs: list[Dataset],
        outputs: list[Dataset],
        event_type: str = "COMPLETE",
        facets: Optional[dict[str, Any]] = None,
        column_lineage: Optional[list[ColumnLineage]] = None,
        run_id: Optional[str] = None,
        started_at: Optional[str] = None,
        ended_at: Optional[str] = None,
    ) -> str:
        """Record a lineage run.

        Returns the run_id.
        """
        run = LineageRun(
            run_id=run_id or str(uuid.uuid4()),
            job_name=job_name,
            event_type=event_type,
            inputs=inputs,
            outputs=outputs,
            facets=facets or {},
            column_lineage=column_lineage or [],
            started_at=started_at or datetime.now(timezone.utc).isoformat(),
            ended_at=ended_at,
        )

        client = await self._get_postgres()
        query = """
            INSERT INTO lineage_runs (
                run_id, job_name, job_namespace, event_type,
                inputs_json, outputs_json, facets_json, column_lineage_json,
                started_at, ended_at, recorded_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
            ON CONFLICT (run_id) DO UPDATE SET
                event_type = EXCLUDED.event_type,
                facets_json = EXCLUDED.facets_json,
                ended_at = EXCLUDED.ended_at,
                recorded_at = EXCLUDED.recorded_at
            RETURNING run_id
        """
        result = await client.fetchval(
            query,
            run.run_id,
            run.job_name,
            run.job_namespace,
            run.event_type,
            json.dumps([{"name": d.name, "namespace": d.namespace, "storage": d.storage} for d in run.inputs]),
            json.dumps([{"name": d.name, "namespace": d.namespace, "storage": d.storage} for d in run.outputs]),
            json.dumps(run.facets),
            json.dumps([{"out": c.output_column, "in_dataset": c.input_dataset, "in_col": c.input_column, "tx": c.transformation} for c in run.column_lineage]),
            run.started_at,
            run.ended_at,
        )
        logger.debug(f"Lineage recorded: {run.job_name} ({run.run_id})")
        return str(result)

    async def record_pipeline_run(
        self,
        job_id: str,
        stage: str,
        stage_status: str,
        inputs: Optional[list[Dataset]] = None,
        outputs: Optional[list[Dataset]] = None,
        duration_ms: Optional[float] = None,
        error_message: Optional[str] = None,
    ) -> str:
        """Convenience: record a pipeline stage run."""
        facets: dict[str, Any] = {"stage": stage, "job_id": job_id}
        if duration_ms is not None:
            facets["duration_ms"] = duration_ms
        if error_message:
            facets["error"] = error_message

        event_type = "COMPLETE" if stage_status in ("success", "complete") else "FAIL"

        return await self.record_run(
            job_name=f"eden_pipeline_{stage}",
            inputs=inputs or [],
            outputs=outputs or [],
            event_type=event_type,
            facets=facets,
        )

    async def record_etl_run(
        self,
        etl_report: dict[str, Any],
        source_table: str = "usage_events",
        target_table: str = "silver_events",
    ) -> str:
        """Convenience: record an ETL run from the Silver ETL pipeline."""
        inputs = [Dataset(source_table, "eden", "postgres")]
        outputs = [Dataset(target_table, "eden", "postgres")]
        return await self.record_run(
            job_name="silver_etl_batch",
            inputs=inputs,
            outputs=outputs,
            event_type="COMPLETE",
            facets=etl_report,
        )

    async def get_upstream(
        self,
        dataset_name: str,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """Find all upstream datasets that feed into a given dataset."""
        client = await self._get_postgres()
        query = """
            SELECT run_id, job_name, inputs_json, started_at
            FROM lineage_runs
            WHERE outputs_json::text ILIKE $1
              AND event_type = 'COMPLETE'
            ORDER BY started_at DESC
            LIMIT $2
        """
        rows = await client.fetch(query, f"%{dataset_name}%", limit)
        upstream: list[dict[str, Any]] = []
        for row in rows:
            inputs = json.loads(row["inputs_json"])
            for inp in inputs:
                upstream.append({
                    "run_id": row["run_id"],
                    "job_name": row["job_name"],
                    "dataset": inp["name"],
                    "namespace": inp["namespace"],
                    "started_at": row["started_at"],
                })
        return upstream

    async def get_downstream(
        self,
        dataset_name: str,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """Find all downstream datasets that consume from a given dataset."""
        client = await self._get_postgres()
        query = """
            SELECT run_id, job_name, outputs_json, started_at
            FROM lineage_runs
            WHERE inputs_json::text ILIKE $1
              AND event_type = 'COMPLETE'
            ORDER BY started_at DESC
            LIMIT $2
        """
        rows = await client.fetch(query, f"%{dataset_name}%", limit)
        downstream: list[dict[str, Any]] = []
        for row in rows:
            outputs = json.loads(row["outputs_json"])
            for out in outputs:
                downstream.append({
                    "run_id": row["run_id"],
                    "job_name": row["job_name"],
                    "dataset": out["name"],
                    "namespace": out["namespace"],
                    "started_at": row["started_at"],
                })
        return downstream

    async def get_lineage_for_job(
        self,
        job_id: str,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Get full lineage history for a specific Eden pipeline job."""
        client = await self._get_postgres()
        query = """
            SELECT run_id, job_name, event_type, inputs_json, outputs_json,
                   facets_json, started_at, ended_at
            FROM lineage_runs
            WHERE facets_json::text ILIKE $1
            ORDER BY started_at DESC
            LIMIT $2
        """
        rows = await client.fetch(query, f"%{job_id}%", limit)
        return [
            {
                "run_id": r["run_id"],
                "job_name": r["job_name"],
                "event_type": r["event_type"],
                "inputs": json.loads(r["inputs_json"]),
                "outputs": json.loads(r["outputs_json"]),
                "facets": json.loads(r["facets_json"]),
                "started_at": r["started_at"],
                "ended_at": r["ended_at"],
            }
            for r in rows
        ]

    async def export_openlineage(
        self,
        since: Optional[datetime] = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        """Export lineage runs as OpenLineage-compatible JSON.

        Suitable for ingestion into Marquez, DataHub, or other lineage tools.
        """
        client = await self._get_postgres()
        if since:
            query = """
                SELECT run_id, job_name, job_namespace, event_type,
                       inputs_json, outputs_json, facets_json,
                       started_at, ended_at
                FROM lineage_runs
                WHERE started_at >= $1
                ORDER BY started_at DESC
                LIMIT $2
            """
            rows = await client.fetch(query, since.isoformat(), limit)
        else:
            query = """
                SELECT run_id, job_name, job_namespace, event_type,
                       inputs_json, outputs_json, facets_json,
                       started_at, ended_at
                FROM lineage_runs
                ORDER BY started_at DESC
                LIMIT $1
            """
            rows = await client.fetch(query, limit)

        events = []
        for row in rows:
            run = LineageRun(
                run_id=row["run_id"],
                job_name=row["job_name"],
                job_namespace=row["job_namespace"],
                event_type=row["event_type"],
                inputs=[Dataset(d["name"], d["namespace"], d["storage"]) for d in json.loads(row["inputs_json"])],
                outputs=[Dataset(d["name"], d["namespace"], d["storage"]) for d in json.loads(row["outputs_json"])],
                facets=json.loads(row["facets_json"]),
                started_at=row["started_at"],
                ended_at=row["ended_at"],
            )
            events.append(run.to_openlineage())
        return events


# Singleton
_lineage_tracker: Optional[LineageTracker] = None


async def get_lineage_tracker() -> LineageTracker:
    """Get the singleton LineageTracker."""
    global _lineage_tracker
    if _lineage_tracker is None:
        _lineage_tracker = LineageTracker()
    return _lineage_tracker
