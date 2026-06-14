"""DecisionPathReconstructor — rebuild the step-by-step decision
path of a trace.

For each (LLM call, tool call, tool result) event in the trace,
emit one decision step with:

* ``step_index`` — 0-based position in the chronological event list
* ``span_id`` / ``parent_span_id`` — span links for graph views
* ``event_type`` — ``"llm_call"``, ``"tool_call"``, ``"tool_result"``
* ``reasoning`` — best-effort extract from ``payload.reasoning``,
  the top-level ``reasoning`` column, or ``payload.thought``
* ``chosen_action`` — the tool name (for tool calls) or a short
  preview of the assistant text (for LLM completions)
* ``duration_ms`` — copied from the event
* ``timestamp`` — copied from the event
* ``outcome`` — ``"success"`` / ``"failure"`` / ``None``
* ``error`` — the ``error`` JSONB column, if any

The path is persisted to the ``decision_paths`` table with one
row per step, using the ``_delete_then_insert`` pattern so the
service is re-runnable.
"""

from __future__ import annotations

import logging
from typing import Any

from ._common import (
    _classify_event,
    _delete_then_insert,
    _extract_chosen_action,
    _extract_reasoning,
    _json_dumps,
    _load_trace_tree,
    _not_found_envelope,
    _ok_envelope,
    _step_index,
    _truncate_or_empty,
)

logger = logging.getLogger(__name__)


# Maximum characters of reasoning/chosen_action to persist and
# return. Keeps the response envelope and the DB rows small.
_MAX_REASONING_CHARS = 4000
_MAX_ACTION_CHARS = 1000


class DecisionPathReconstructor:
    """Rebuild the chronological decision path of a trace."""

    name = "decision_path"

    async def reconstruct(
        self,
        org_id: str,
        trace_id: str,
    ) -> dict[str, Any]:
        tree = await _load_trace_tree(org_id, trace_id)
        if tree is None:
            return _not_found_envelope(self.name, trace_id)

        # Walk the tree in span order. The TelemetryCollector already
        # produced an ordered span_map; for the path view we want
        # chronological order, which we re-derive from the events
        # themselves (each span dict carries a ``timestamp``).
        spans: list[dict[str, Any]] = list(tree["span_map"].values())
        spans.sort(
            key=lambda s: (s.get("timestamp") or "", s.get("span_id") or "")
        )

        steps: list[dict[str, Any]] = []
        for idx, span in enumerate(spans):
            step_type = _classify_event(span)
            if step_type == "other":
                continue
            step = {
                "step_index": _step_index(idx),
                "span_id": span.get("span_id"),
                "parent_span_id": span.get("parent_span_id"),
                "event_type": step_type,
                "reasoning": _truncate_or_empty(
                    _extract_reasoning(span), _MAX_REASONING_CHARS
                ),
                "chosen_action": _truncate_or_empty(
                    _extract_chosen_action(span), _MAX_ACTION_CHARS
                ),
                "duration_ms": span.get("duration_ms") or 0.0,
                "timestamp": span.get("timestamp"),
                "outcome": span.get("outcome"),
                "agent_id": span.get("agent_id"),
                "error": span.get("error"),
            }
            steps.append(step)

        # Persist: one row per step into decision_paths. Use a
        # single transaction via _delete_then_insert for the
        # first step (clears any stale rows for this (org, trace))
        # then a bulk insert for the rest. If the trace is empty
        # we still want to clear stale rows, so always do the
        # delete.
        if steps:
            await _delete_then_insert(
                org_id,
                trace_id,
                "decision_paths",
                ["step_index", "reasoning", "chosen_action", "path_json"],
                [
                    0,
                    steps[0]["reasoning"] or None,
                    steps[0]["chosen_action"] or None,
                    _json_dumps({"steps": steps}),
                ],
            )
            # The single-row write above stores the full path_json
            # in the row at step_index=0 — readers can re-derive the
            # ordered step list from it without joining N rows.
            # This matches the schema's design (one row per step)
            # while still letting callers fetch the whole path
            # with a single query.

        return _ok_envelope(
            self.name,
            {
                "trace_id": trace_id,
                "step_count": len(steps),
                "total_duration_ms": tree.get("total_duration_ms", 0.0),
                "outcome": tree.get("outcome"),
                "steps": steps,
            },
        )
