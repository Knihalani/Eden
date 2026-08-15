"""Shared human-label types (FEAT-162).

Both the general annotation queue (:mod:`eden.evaluation.labeling`) and
F21 tool-call thumbs (:mod:`eden.learning.tool_call_labels`) emit
human judgments. This module is the thin shared vocabulary so the two
surfaces can converge on one event stream without a big rewrite.

Target model (see ``docs/specs/strategic-review-2026-08/features/
labeling-unification.md``):

* One conceptual **human-label event** (``HumanLabel``).
* Tool-call thumbs map to labeling item kind ``tool_call`` via
  :func:`bridge_tool_call_label_to_queue` (best-effort upsert).
* The dedicated ``tool_call_labels`` table remains the source of truth
  for calibrator training; the labeling queue is the HiL review /
  IAA / export surface.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Literal, TypedDict

logger = logging.getLogger(__name__)

#: Labeling item ``label_schema.type`` / kind for F21 tool-call thumbs.
TOOL_CALL_ITEM_KIND = "tool_call"

#: Supported human-label kinds today. Extend as more surfaces join.
LabelKind = Literal[
    "generic",
    "trace_score",
    "tool_call",
]

LabelValue = Literal["good", "bad"] | str


class HumanLabel(TypedDict, total=False):
    """Canonical human-label event shared by labeling + tool_call_labels.

    Required keys for a durable event: ``org_id``, ``kind``, ``label``,
    ``annotator_id``. Source pointers (``span_id`` / ``trace_id`` /
    ``item_id``) are optional depending on the surface.
    """

    org_id: str
    kind: LabelKind
    label: LabelValue
    annotator_id: str
    confidence: float
    notes: str | None
    item_id: str | None
    span_id: str | None
    trace_id: str | None
    tool_name: str | None
    agent_id: str | None
    source: str  # "labeling" | "tool_call_labels"


def tool_call_thumbs_to_human_label(
    *,
    org_id: str,
    span_id: str,
    trace_id: str,
    tool_name: str,
    label: str,
    labeled_by: str | None,
    agent_id: str | None = None,
    reason: str | None = None,
) -> HumanLabel:
    """Map an F21 thumbs payload onto the shared ``HumanLabel`` shape."""
    return HumanLabel(
        org_id=org_id,
        kind="tool_call",
        label=label,
        annotator_id=labeled_by or "",
        notes=reason,
        span_id=span_id,
        trace_id=trace_id,
        tool_name=tool_name,
        agent_id=agent_id,
        source="tool_call_labels",
    )


def bridge_enabled() -> bool:
    """Whether tool-call writes should upsert a labeling-queue item.

    Default **on** (best-effort). Set ``EDEN_TOOL_CALL_LABEL_BRIDGE=0``
    to disable without code changes.
    """
    raw = os.environ.get("EDEN_TOOL_CALL_LABEL_BRIDGE", "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


async def bridge_tool_call_label_to_queue(
    *,
    org_id: str,
    span_id: str,
    trace_id: str,
    tool_name: str,
    label: str,
    labeled_by: str | None,
    agent_id: str | None = None,
    reason: str | None = None,
    pg: Any | None = None,
) -> str | None:
    """Best-effort upsert of a ``tool_call`` labeling item + annotation.

    Never raises into the F21 write path — failures are logged and
    return ``None``. Returns the labeling item id when the bridge
    succeeds.
    """
    if not bridge_enabled():
        return None
    try:
        if pg is None:
            from eden.storage.postgres import get_postgres_client

            pg = await get_postgres_client()
        if pg is None:
            return None

        from eden.evaluation.labeling import LabelingService

        svc = LabelingService(pg)
        item_id = await _find_or_seed_tool_call_item(
            svc,
            org_id=org_id,
            span_id=span_id,
            trace_id=trace_id,
            tool_name=tool_name,
            agent_id=agent_id,
        )
        annotator = (labeled_by or "").strip() or "tool_call_labels:anonymous"
        await svc.annotate(
            org_id=org_id,
            item_id=item_id,
            annotator_id=annotator,
            label=label,
            confidence=1.0,
            notes=reason,
            skills_exercised=["tool_call"],
        )
        return item_id
    except Exception as exc:  # noqa: BLE001 — never break F21 writes
        logger.debug(
            "human_labels: tool_call bridge skipped (org=%s span=%s): %s",
            org_id,
            span_id,
            exc,
        )
        return None


async def _find_or_seed_tool_call_item(
    svc: Any,
    *,
    org_id: str,
    span_id: str,
    trace_id: str,
    tool_name: str,
    agent_id: str | None,
) -> str:
    """Find existing ``tool_call`` item for ``span_id`` or seed one."""
    row = await svc._pg.fetchrow(
        """
        SELECT id FROM labeling_items
        WHERE org_id = $1
          AND source_span_id = $2
          AND label_schema->>'type' = $3
        LIMIT 1
        """,
        org_id,
        span_id,
        TOOL_CALL_ITEM_KIND,
    )
    if row is not None:
        return str(row["id"])
    payload: dict[str, Any] = {
        "span_id": span_id,
        "trace_id": trace_id,
        "tool_name": tool_name,
        "kind": TOOL_CALL_ITEM_KIND,
    }
    if agent_id:
        payload["agent_id"] = agent_id
    return str(
        await svc.seed(
            org_id=org_id,
            payload=payload,
            label_schema={
                "type": TOOL_CALL_ITEM_KIND,
                "values": ["good", "bad"],
            },
            prompt=f"Tool-call thumbs for {tool_name} (span {span_id})",
            tags=["tool_call", tool_name],
            annotations_required=1,
            source_trace_id=trace_id,
            source_span_id=span_id,
        )
    )


def human_label_to_json(event: HumanLabel) -> str:
    """Serialize a ``HumanLabel`` for logging / export."""
    return json.dumps(dict(event), default=str, sort_keys=True)
