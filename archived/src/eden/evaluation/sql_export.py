"""F76 SQL/EQL query → dataset or labeling queue export."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


class SqlExportService:
    """Export SQL query results to datasets or labeling queues."""

    async def export_to_dataset(
        self,
        org_id: str,
        *,
        sql: str,
        dataset_name: str,
        trace_id_column: str = "trace_id",
    ) -> dict[str, Any]:
        from eden.datasets.hub import DatasetHub
        from eden.observability.sql_executor import SqlExecutor

        executor = SqlExecutor()
        result = await executor.execute(org_id, sql)
        rows = result.get("rows") or []
        columns = result.get("columns") or []
        trace_idx = (
            columns.index(trace_id_column)
            if trace_id_column in columns
            else None
        )

        hub = DatasetHub()
        dataset = await hub.create_dataset(
            org_id, name=dataset_name, source_type="sql_export", source_ref=sql[:500]
        )
        if dataset is None:
            return {"exported": 0, "dataset_id": None}

        exported = 0
        for row in rows:
            trace_id = None
            if trace_idx is not None and trace_idx < len(row):
                trace_id = str(row[trace_idx])
            if trace_id:
                await hub.promote_trace(org_id, trace_id, dataset_id=dataset.id)
                exported += 1

        return {
            "dataset_id": dataset.id,
            "dataset_name": dataset_name,
            "exported": exported,
            "row_count": len(rows),
        }

    async def export_to_queue(
        self,
        org_id: str,
        *,
        sql: str,
        queue_id: str,
        trace_id_column: str = "trace_id",
    ) -> dict[str, Any]:
        from eden.evaluation.labeling_queues import LabelingQueueService
        from eden.observability.sql_executor import SqlExecutor

        executor = SqlExecutor()
        result = await executor.execute(org_id, sql)
        rows = result.get("rows") or []
        columns = result.get("columns") or []
        trace_idx = (
            columns.index(trace_id_column)
            if trace_id_column in columns
            else None
        )

        service = LabelingQueueService()
        added = 0
        for row in rows:
            if trace_idx is None or trace_idx >= len(row):
                continue
            trace_id = str(row[trace_idx])
            ok = await service.add_item(org_id, queue_id, trace_id=trace_id)
            if ok:
                added += 1

        return {"queue_id": queue_id, "added": added, "row_count": len(rows)}
