"""F53 versioned dataset hub — org-scoped CRUD, trace promotion, snapshots."""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class DatasetRecord:
    id: str
    org_id: str
    name: str
    description: str
    source_type: str
    source_ref: str | None
    version: int
    row_count: int = 0
    column_count: int = 0
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "org_id": self.org_id,
            "name": self.name,
            "description": self.description,
            "source_type": self.source_type,
            "source_ref": self.source_ref,
            "version": self.version,
            "row_count": self.row_count,
            "column_count": self.column_count,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass
class DatasetSnapshot:
    id: str
    dataset_id: str
    org_id: str
    version: int
    row_count: int
    created_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "dataset_id": self.dataset_id,
            "org_id": self.org_id,
            "version": self.version,
            "row_count": self.row_count,
            "created_at": self.created_at,
        }


class DatasetHub:
    """Versioned dataset hub over ``datasets`` / ``dataset_items``."""

    def __init__(self, pg: Any | None = None, *, memory_only: bool = False) -> None:
        self._pg = pg
        self._memory_only = memory_only
        self._memory: dict[str, DatasetRecord] = {}

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

    async def list_datasets(self, org_id: str, *, limit: int = 100) -> list[DatasetRecord]:
        client = await self._client()
        if client is None:
            return [d for d in self._memory.values() if d.org_id == org_id][:limit]
        rows = await client.fetch(
            """
            SELECT d.id, d.org_id, d.name, d.description, d.source_type,
                   d.source_ref, d.version, d.created_at, d.updated_at,
                   (SELECT COUNT(*)::int FROM dataset_items di WHERE di.dataset_id = d.id) AS row_count,
                   (SELECT COUNT(*)::int FROM dataset_columns dc WHERE dc.dataset_id = d.id) AS column_count
            FROM datasets d
            WHERE d.org_id = $1
            ORDER BY d.updated_at DESC
            LIMIT $2
            """,
            org_id,
            limit,
        )
        return [_row_to_dataset(dict(r)) for r in rows]

    async def get_dataset(self, org_id: str, dataset_id: str) -> DatasetRecord | None:
        client = await self._client()
        if client is None:
            rec = self._memory.get(dataset_id)
            return rec if rec and rec.org_id == org_id else None
        row = await client.fetchrow(
            """
            SELECT d.id, d.org_id, d.name, d.description, d.source_type,
                   d.source_ref, d.version, d.created_at, d.updated_at,
                   (SELECT COUNT(*)::int FROM dataset_items di WHERE di.dataset_id = d.id) AS row_count,
                   (SELECT COUNT(*)::int FROM dataset_columns dc WHERE dc.dataset_id = d.id) AS column_count
            FROM datasets d
            WHERE d.org_id = $1 AND d.id = $2::uuid
            """,
            org_id,
            dataset_id,
        )
        return _row_to_dataset(dict(row)) if row else None

    async def create_dataset(
        self,
        org_id: str,
        *,
        name: str,
        description: str = "",
        source_type: str = "manual",
        source_ref: str | None = None,
    ) -> DatasetRecord:
        dataset_id = str(uuid.uuid4())
        now = datetime.now(UTC).isoformat()
        client = await self._client()
        if client is None:
            rec = DatasetRecord(
                id=dataset_id,
                org_id=org_id,
                name=name,
                description=description,
                source_type=source_type,
                source_ref=source_ref,
                version=1,
                created_at=now,
                updated_at=now,
            )
            self._memory[dataset_id] = rec
            return rec
        row = await client.fetchrow(
            """
            INSERT INTO datasets (id, org_id, name, description, source_type, source_ref)
            VALUES ($1::uuid, $2, $3, $4, $5, $6)
            RETURNING id, org_id, name, description, source_type, source_ref, version,
                      created_at, updated_at
            """,
            dataset_id,
            org_id,
            name,
            description,
            source_type,
            source_ref,
        )
        rec = _row_to_dataset(dict(row))
        rec.row_count = 0
        rec.column_count = 0
        return rec

    async def promote_trace(
        self,
        org_id: str,
        trace_id: str,
        *,
        dataset_id: str | None = None,
        dataset_name: str | None = None,
    ) -> dict[str, Any]:
        """Append a production trace as a dataset row."""
        if not dataset_id:
            name = dataset_name or f"trace-{trace_id[:8]}"
            existing = await self.list_datasets(org_id)
            match = next((d for d in existing if d.name == name), None)
            if match:
                dataset_id = match.id
            else:
                created = await self.create_dataset(
                    org_id,
                    name=name,
                    description=f"Promoted from trace {trace_id}",
                    source_type="trace",
                    source_ref=trace_id,
                )
                dataset_id = created.id
        else:
            owned = await self.get_dataset(org_id, dataset_id)
            if owned is None:
                raise ValueError("dataset not found")

        payload = await self._trace_payload(trace_id)
        input_text = json.dumps(payload.get("messages", payload), default=str)[:100_000]
        client = await self._client()
        row_id = str(uuid.uuid4())
        if client is None:
            return {"dataset_id": dataset_id, "row_id": row_id, "trace_id": trace_id}
        await client.execute(
            """
            INSERT INTO dataset_items
                (id, dataset_id, input, expected_output, payload, origin_trace_id)
            VALUES ($1::uuid, $2::uuid, $3, '', $4::jsonb, $5)
            """,
            row_id,
            dataset_id,
            input_text,
            json.dumps({"trace_id": trace_id}),
            trace_id,
        )
        await client.execute(
            "UPDATE datasets SET updated_at = NOW(), version = version + 1 WHERE id = $1::uuid",
            dataset_id,
        )
        return {"dataset_id": dataset_id, "row_id": row_id, "trace_id": trace_id}

    async def create_snapshot(self, org_id: str, dataset_id: str) -> DatasetSnapshot:
        client = await self._client()
        snap_id = str(uuid.uuid4())
        if client is None:
            ds = self._memory.get(dataset_id)
            version = (ds.version if ds else 1)
            return DatasetSnapshot(
                id=snap_id,
                dataset_id=dataset_id,
                org_id=org_id,
                version=version,
                row_count=0,
                created_at=datetime.now(UTC).isoformat(),
            )
        ds = await self.get_dataset(org_id, dataset_id)
        if ds is None:
            raise ValueError("dataset not found")
        rows = await client.fetch(
            """
            SELECT id, input, expected_output, payload, origin_trace_id
            FROM dataset_items WHERE dataset_id = $1::uuid ORDER BY created_at
            """,
            dataset_id,
        )
        snapshot_rows = [dict(r) for r in rows]
        await client.execute(
            """
            INSERT INTO dataset_snapshots
                (id, dataset_id, org_id, version, row_count, snapshot_data)
            VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb)
            """,
            snap_id,
            dataset_id,
            org_id,
            ds.version,
            len(snapshot_rows),
            json.dumps(snapshot_rows, default=str),
        )
        return DatasetSnapshot(
            id=snap_id,
            dataset_id=dataset_id,
            org_id=org_id,
            version=ds.version,
            row_count=len(snapshot_rows),
            created_at=datetime.now(UTC).isoformat(),
        )

    async def list_snapshots(self, org_id: str, dataset_id: str) -> list[DatasetSnapshot]:
        client = await self._client()
        if client is None:
            return []
        rows = await client.fetch(
            """
            SELECT id, dataset_id, org_id, version, row_count, created_at
            FROM dataset_snapshots
            WHERE org_id = $1 AND dataset_id = $2::uuid
            ORDER BY created_at DESC
            """,
            org_id,
            dataset_id,
        )
        return [
            DatasetSnapshot(
                id=str(r["id"]),
                dataset_id=str(r["dataset_id"]),
                org_id=str(r["org_id"]),
                version=int(r["version"]),
                row_count=int(r["row_count"]),
                created_at=str(r.get("created_at", "")),
            )
            for r in rows
        ]

    async def _trace_payload(self, trace_id: str) -> dict[str, Any]:
        client = await self._client()
        if client is None:
            return {"trace_id": trace_id, "messages": []}
        try:
            row = await client.fetchrow(
                """
                SELECT payload FROM telemetry_events
                WHERE trace_id = $1 ORDER BY timestamp ASC LIMIT 1
                """,
                trace_id,
            )
            if row and row.get("payload"):
                payload = row["payload"]
                if isinstance(payload, str):
                    payload = json.loads(payload)
                if isinstance(payload, dict):
                    return payload
        except Exception as exc:
            logger.debug("trace payload load failed: %s", exc)
        return {"trace_id": trace_id, "messages": []}


def _row_to_dataset(row: dict[str, Any]) -> DatasetRecord:
    created = row.get("created_at")
    updated = row.get("updated_at")
    return DatasetRecord(
        id=str(row["id"]),
        org_id=str(row["org_id"]),
        name=str(row["name"]),
        description=str(row.get("description") or ""),
        source_type=str(row.get("source_type") or "manual"),
        source_ref=row.get("source_ref"),
        version=int(row.get("version") or 1),
        row_count=int(row.get("row_count") or 0),
        column_count=int(row.get("column_count") or 0),
        created_at=created.isoformat() if hasattr(created, "isoformat") else str(created or ""),
        updated_at=updated.isoformat() if hasattr(updated, "isoformat") else str(updated or ""),
    )


__all__ = ["DatasetHub", "DatasetRecord", "DatasetSnapshot"]
