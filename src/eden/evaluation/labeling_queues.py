"""F50 annotation queue kanban service."""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)

KANBAN_COLUMNS = ("todo", "in_progress", "done", "skipped")


@dataclass
class LabelingQueue:
    id: str
    org_id: str
    name: str
    description: str
    schema: dict[str, Any]
    status: str
    created_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "org_id": self.org_id,
            "name": self.name,
            "description": self.description,
            "schema": dict(self.schema),
            "status": self.status,
            "created_at": self.created_at,
        }


class LabelingQueueService:
    """Kanban queues for SME annotation workflow."""

    def __init__(self, pg: Any | None = None, *, memory_only: bool = False) -> None:
        self._pg = pg
        self._memory_only = memory_only
        self._memory: dict[str, LabelingQueue] = {}

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

    async def create_queue(
        self,
        org_id: str,
        *,
        name: str,
        description: str = "",
        schema: dict[str, Any] | None = None,
    ) -> LabelingQueue:
        qid = str(uuid.uuid4())
        now = datetime.now(UTC).isoformat()
        sch = schema or {"type": "binary", "labels": ["good", "bad"]}
        client = await self._client()
        if client is None:
            q = LabelingQueue(
                id=qid,
                org_id=org_id,
                name=name,
                description=description,
                schema=sch,
                status="active",
                created_at=now,
            )
            self._memory[qid] = q
            return q
        row = await client.fetchrow(
            """
            INSERT INTO labeling_queues (id, org_id, name, description, schema)
            VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
            RETURNING id, org_id, name, description, schema, status, created_at
            """,
            qid,
            org_id,
            name,
            description,
            json.dumps(sch),
        )
        return _row_to_queue(dict(row))

    async def list_queues(self, org_id: str) -> list[LabelingQueue]:
        client = await self._client()
        if client is None:
            return [q for q in self._memory.values() if q.org_id == org_id]
        rows = await client.fetch(
            "SELECT * FROM labeling_queues WHERE org_id = $1 ORDER BY created_at DESC",
            org_id,
        )
        return [_row_to_queue(dict(r)) for r in rows]

    async def kanban_board(self, org_id: str, queue_id: str) -> dict[str, list[dict[str, Any]]]:
        client = await self._client()
        board = {col: [] for col in KANBAN_COLUMNS}
        if client is None:
            return board
        rows = await client.fetch(
            """
            SELECT id, prompt, payload, kanban_status, tags, created_at
            FROM labeling_items
            WHERE org_id = $1 AND queue_id = $2::uuid
            ORDER BY created_at ASC
            """,
            org_id,
            queue_id,
        )
        for r in rows:
            status = str(r.get("kanban_status") or "todo")
            if status not in board:
                status = "todo"
            board[status].append(dict(r))
        return board

    async def add_item(
        self, org_id: str, queue_id: str, *, trace_id: str, prompt: str = ""
    ) -> bool:
        """Seed a queue item from a trace (F76 SQL export)."""
        client = await self._client()
        if client is None:
            return False
        iid = str(uuid.uuid4())
        payload = {"trace_id": trace_id}
        try:
            await client.execute(
                """
                INSERT INTO labeling_items
                (id, org_id, queue_id, prompt, payload, source_trace_id, kanban_status)
                VALUES ($1::uuid, $2, $3::uuid, $4, $5::jsonb, $6, 'todo')
                """,
                iid,
                org_id,
                queue_id,
                prompt or f"trace:{trace_id}",
                json.dumps(payload),
                trace_id,
            )
            return True
        except Exception as exc:
            logger.debug("labeling_queue: add_item failed: %s", exc)
            return False

    async def move_item(
        self, org_id: str, queue_id: str, item_id: str, *, status: str
    ) -> bool:
        if status not in KANBAN_COLUMNS:
            raise ValueError(f"invalid status: {status}")
        client = await self._client()
        if client is None:
            return True
        result = await client.execute(
            """
            UPDATE labeling_items
            SET kanban_status = $1, updated_at = NOW()
            WHERE org_id = $2 AND queue_id = $3::uuid AND id = $4::uuid
            """,
            status,
            org_id,
            queue_id,
            item_id,
        )
        return bool(result)

    async def push_to_dataset(
        self, org_id: str, queue_id: str, *, dataset_id: str
    ) -> dict[str, Any]:
        """Export approved items to F53 dataset."""
        from eden.datasets.hub import DatasetHub

        client = await self._client()
        if client is None:
            return {"pushed": 0}
        rows = await client.fetch(
            """
            SELECT li.id, li.payload, li.source_trace_id
            FROM labeling_items li
            WHERE li.org_id = $1 AND li.queue_id = $2::uuid
              AND li.kanban_status = 'done'
            """,
            org_id,
            queue_id,
        )
        hub = DatasetHub(client)
        pushed = 0
        for r in rows:
            payload = r.get("payload")
            if isinstance(payload, str):
                payload = json.loads(payload)
            trace_id = r.get("source_trace_id") or (payload or {}).get("trace_id")
            if trace_id:
                await hub.promote_trace(org_id, str(trace_id), dataset_id=dataset_id)
            else:
                await client.execute(
                    """
                    INSERT INTO dataset_items (dataset_id, input, payload)
                    VALUES ($1::uuid, $2, $3::jsonb)
                    """,
                    dataset_id,
                    json.dumps(payload or {}, default=str)[:100_000],
                    json.dumps(payload or {}),
                )
            pushed += 1
        return {"pushed": pushed, "dataset_id": dataset_id}


def _row_to_queue(row: dict[str, Any]) -> LabelingQueue:
    schema = row.get("schema") or {}
    if isinstance(schema, str):
        schema = json.loads(schema)
    created = row.get("created_at")
    return LabelingQueue(
        id=str(row["id"]),
        org_id=str(row["org_id"]),
        name=str(row["name"]),
        description=str(row.get("description") or ""),
        schema=dict(schema),
        status=str(row.get("status") or "active"),
        created_at=created.isoformat() if hasattr(created, "isoformat") else str(created or ""),
    )


__all__ = ["LabelingQueueService", "LabelingQueue", "KANBAN_COLUMNS"]
