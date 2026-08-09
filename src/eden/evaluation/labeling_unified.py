"""FEAT-162 — shared labeling identity between the queue and tool-call labels.

Full unification (one kanban surface, merged export) is deferred until real
tool-call labeling usage proves the UX — this module shares status vocabulary,
subject keys, and a thin bridge that seeds queue rows for cross-linking.

Remaining debt: merge ``tool_call_labels`` into ``annotations`` or a single
export path; today tool labels live in their own table with calibrator training.
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

# Shared queue status vocabulary (labeling_items.status).
LABEL_STATUS_PENDING = "pending"
LABEL_STATUS_IN_PROGRESS = "in_progress"
LABEL_STATUS_COMPLETED = "completed"
LABEL_STATUS_SKIPPED = "skipped"

LABEL_SOURCE_QUEUE = "queue"
LABEL_SOURCE_TOOL_CALL = "tool_call"


def label_subject_key(org_id: str, source: str, ref_id: str) -> str:
    """Stable cross-surface identity for a labelable subject."""
    return f"{source}:{org_id}:{ref_id}"


async def bridge_tool_call_label_to_queue(
    *,
    org_id: str,
    span_id: str,
    trace_id: str,
    tool_name: str,
    label: str,
    reason: str | None = None,
    agent_id: str | None = None,
) -> str | None:
    """Seed or refresh a labeling queue item keyed by ``source_span_id`` (FEAT-162)."""
    try:
        from eden.evaluation.labeling import LabelingService
        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()
        if pg is None:
            return None
        svc = LabelingService(pg)
        existing = await pg.fetchrow(
            """
            SELECT id FROM labeling_items
            WHERE org_id = $1 AND source_span_id = $2
            ORDER BY id ASC
            LIMIT 1
            """,
            org_id,
            span_id,
        )
        payload: dict[str, Any] = {
            "label_source": LABEL_SOURCE_TOOL_CALL,
            "subject_key": label_subject_key(org_id, LABEL_SOURCE_TOOL_CALL, span_id),
            "tool_name": tool_name,
            "label": label,
            "reason": reason,
            "trace_id": trace_id,
            "agent_id": agent_id,
        }
        tags = ["tool_call", tool_name]
        if existing:
            item_id = str(existing["id"])
            await pg.execute(
                """
                UPDATE labeling_items
                SET payload = $3::jsonb,
                    tags = $4,
                    status = CASE
                        WHEN status = 'completed' THEN 'pending'
                        ELSE status
                    END,
                    updated_at = NOW()
                WHERE id = $1 AND org_id = $2
                """,
                item_id,
                org_id,
                json.dumps(payload),
                tags,
            )
            return item_id
        return await svc.seed(
            org_id=org_id,
            payload=payload,
            label_schema={
                "type": "tool_call",
                "fields": ["good", "bad"],
            },
            prompt=f"Tool call quality: {tool_name}",
            tags=tags,
            annotations_required=1,
            source_trace_id=trace_id,
            source_span_id=span_id,
        )
    except Exception as exc:  # noqa: BLE001 — bridge must not break tool labeling
        logger.debug("tool_call labeling bridge failed span=%s: %s", span_id, exc)
        return None
