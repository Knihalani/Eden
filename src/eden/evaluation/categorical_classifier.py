"""F55 categorical classifiers as trace columns."""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

logger = logging.getLogger(__name__)


class CategoricalClassifierService:
    """Register classifiers and apply labels to traces/spans."""

    async def list_classifiers(self, org_id: str) -> list[dict[str, Any]]:
        client = await self._client()
        if client is None:
            return []
        rows = await client.fetch(
            "SELECT * FROM categorical_classifiers WHERE org_id = $1 "
            "ORDER BY updated_at DESC",
            org_id,
        )
        return [dict(r) for r in rows]

    async def register(
        self,
        org_id: str,
        *,
        name: str,
        column_key: str,
        labels: list[str],
        scorer_type: str = "slm",
        scorer_ref: str | None = None,
    ) -> dict[str, Any] | None:
        client = await self._client()
        if client is None:
            return None
        cid = str(uuid.uuid4())
        await client.execute(
            """
            INSERT INTO categorical_classifiers
            (id, org_id, name, column_key, labels, scorer_type, scorer_ref)
            VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7)
            """,
            cid,
            org_id,
            name,
            column_key,
            json.dumps(labels),
            scorer_type,
            scorer_ref,
        )
        return {"id": cid, "name": name, "column_key": column_key, "labels": labels}

    async def classify_trace(
        self, org_id: str, classifier_id: str, trace_id: str
    ) -> dict[str, Any] | None:
        client = await self._client()
        if client is None:
            return None
        row = await client.fetchrow(
            "SELECT * FROM categorical_classifiers "
            "WHERE org_id = $1 AND id = $2::uuid AND enabled = true",
            org_id,
            classifier_id,
        )
        if not row:
            return None
        column_key = str(row["column_key"])
        labels = list(row.get("labels") or [])
        label = labels[0] if labels else "unknown"

        from eden.observability.custom_properties.service import CustomPropertiesService

        await CustomPropertiesService().set(
            org_id, trace_id=trace_id, properties={column_key: label}
        )
        return {"trace_id": trace_id, "column_key": column_key, "label": label}

    async def _client(self) -> Any | None:
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None
