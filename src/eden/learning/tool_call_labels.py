"""F21 — tool call label learning service."""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

_MIN_LABELS_FOR_CALIBRATION = 5


@dataclass
class ToolCallLabelCreate:
    org_id: str
    span_id: str
    trace_id: str
    tool_name: str
    label: str
    reason: str | None = None
    agent_id: str | None = None
    args_summary: str | None = None
    labeled_by: str | None = None


class ToolCallLabelService:
    async def create_label(self, data: ToolCallLabelCreate) -> dict[str, Any]:
        if data.label not in ("good", "bad"):
            raise ValueError("label must be 'good' or 'bad'")

        args_hash = ""
        if data.args_summary:
            args_hash = hashlib.sha256(data.args_summary.encode()).hexdigest()[:16]

        label_id = str(uuid.uuid4())
        try:
            from eden.storage.postgres import get_postgres_client

            pg = await get_postgres_client()
        except Exception as exc:
            raise RuntimeError("database unavailable") from exc
        if pg is None:
            raise RuntimeError("database unavailable")

        await pg.execute(
            """
            INSERT INTO tool_call_labels
                (id, org_id, span_id, trace_id, agent_id, label, reason,
                 tool_name, args_hash, labeled_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (org_id, span_id) DO UPDATE SET
                label = EXCLUDED.label,
                reason = EXCLUDED.reason,
                tool_name = EXCLUDED.tool_name,
                args_hash = EXCLUDED.args_hash,
                labeled_by = EXCLUDED.labeled_by
            """,
            label_id,
            data.org_id,
            data.span_id,
            data.trace_id,
            data.agent_id,
            data.label,
            data.reason,
            data.tool_name,
            args_hash or None,
            data.labeled_by,
        )
        return {
            "id": label_id,
            "org_id": data.org_id,
            "span_id": data.span_id,
            "label": data.label,
            "tool_name": data.tool_name,
        }

    async def delete_label(self, org_id: str, span_id: str) -> bool:
        try:
            from eden.storage.postgres import get_postgres_client

            pg = await get_postgres_client()
        except Exception:
            return False
        if pg is None:
            return False
        result = await pg.execute(
            "DELETE FROM tool_call_labels WHERE org_id = $1 AND span_id = $2",
            org_id,
            span_id,
        )
        return result.endswith("1")

    async def list_for_agent(
        self, org_id: str, agent_id: str, *, tool_name: str | None = None
    ) -> list[dict[str, Any]]:
        try:
            from eden.storage.postgres import get_postgres_client

            pg = await get_postgres_client()
        except Exception:
            return []
        if pg is None:
            return []
        where = ["org_id = $1", "agent_id = $2"]
        args: list[Any] = [org_id, agent_id]
        if tool_name:
            where.append(f"tool_name = ${len(args)+1}")
            args.append(tool_name)
        rows = await pg.fetch(
            f"""
            SELECT id, span_id, trace_id, tool_name, label, reason, created_at
            FROM tool_call_labels
            WHERE {' AND '.join(where)}
            ORDER BY created_at DESC
            LIMIT 200
            """,
            *args,
        )
        return [dict(r) for r in rows]

    async def count_labels(
        self, org_id: str, agent_id: str, tool_name: str
    ) -> int:
        try:
            from eden.storage.postgres import get_postgres_client

            pg = await get_postgres_client()
        except Exception:
            return 0
        if pg is None:
            return 0
        row = await pg.fetchrow(
            """
            SELECT COUNT(*) AS n
            FROM tool_call_labels
            WHERE org_id = $1 AND agent_id = $2 AND tool_name = $3
            """,
            org_id,
            agent_id,
            tool_name,
        )
        return int(row["n"]) if row else 0

    async def should_train(self, org_id: str, agent_id: str, tool_name: str) -> bool:
        return (
            await self.count_labels(org_id, agent_id, tool_name)
            >= _MIN_LABELS_FOR_CALIBRATION
        )

    def feature_vector(self, tool_name: str, args_summary: str, agent_id: str) -> list[float]:
        """Tiny bag-of-hash feature vector for logistic regression."""
        text = f"{agent_id}|{tool_name}|{args_summary}"
        vec = [0.0] * 16
        for i, ch in enumerate(hashlib.sha256(text.encode()).digest()[:16]):
            vec[i] = (ch / 255.0) * 2 - 1
        return vec

    async def export_training_rows(
        self, org_id: str, agent_id: str, tool_name: str
    ) -> list[tuple[list[float], int]]:
        labels = await self.list_for_agent(org_id, agent_id, tool_name=tool_name)
        out: list[tuple[list[float], int]] = []
        for row in labels:
            y = 1 if row["label"] == "bad" else 0
            out.append(
                (
                    self.feature_vector(
                        _s(row.get("tool_name")),
                        _s(row.get("reason")),
                        agent_id,
                    ),
                    y,
                )
            )
        return out


def _s(v: Any) -> str:
    return "" if v is None else str(v)
