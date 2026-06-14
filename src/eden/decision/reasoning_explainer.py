"""ReasoningTraceExplainer — explain in natural language why the
agent chose action X over Y.

For each LLM call event in the trace, emit one explainer step
with the chain-of-thought text, the observation that preceded
it (the previous tool result), and the action that followed.

The explainer is **read-only** — it does not persist to a
Cat 16 table because the underlying reasoning is already in
``telemetry_events`` and the explainer is meant to be re-runnable
on demand. Callers that need to keep a stable explanation
should snapshot the response payload to their own storage.
"""

from __future__ import annotations

import logging
from typing import Any

from ._common import (
    _classify_event,
    _extract_chosen_action,
    _extract_reasoning,
    _fetch_trace_events,
    _is_llm_event,
    _is_tool_event,
    _not_found_envelope,
    _ok_envelope,
    _step_index,
    _truncate_or_empty,
)

logger = logging.getLogger(__name__)


_MAX_REASONING_CHARS = 4000
_MAX_OBSERVATION_CHARS = 2000


def _extract_observation(event: dict[str, Any]) -> str:
    """Pull the observation text from a tool_result event.

    Looks at, in order: ``payload.result``, ``payload.output``,
    ``tool_results[0]`` (array of dicts), ``response_body`` text
    preview. Returns an empty string if nothing matches — the
    caller treats empty as "no preceding observation".
    """
    payload = event.get("payload") or {}
    if isinstance(payload, dict):
        for key in ("result", "output", "observation", "tool_result"):
            v = payload.get(key)
            if isinstance(v, str) and v.strip():
                return v
            if isinstance(v, dict):
                # Some tools return ``{"output": "..."}``
                inner = v.get("output") or v.get("text") or v.get("content")
                if isinstance(inner, str) and inner.strip():
                    return inner
    tool_results = event.get("tool_results") or []
    if tool_results and isinstance(tool_results, list):
        first = tool_results[0]
        if isinstance(first, dict):
            content = first.get("content") or first.get("output") or first.get("result")
            if isinstance(content, str) and content.strip():
                return content
    response_body = event.get("response_body") or {}
    if isinstance(response_body, dict):
        for key in ("output", "result", "text"):
            v = response_body.get(key)
            if isinstance(v, str) and v.strip():
                return v
    return ""


class ReasoningTraceExplainer:
    """Extract the reasoning chain from a trace."""

    name = "reasoning_explainer"

    async def explain(
        self,
        org_id: str,
        trace_id: str,
    ) -> dict[str, Any]:
        events = await _fetch_trace_events(org_id, trace_id)
        if not events:
            return _not_found_envelope(self.name, trace_id)

        # Walk events in timestamp order. For each LLM event,
        # the "observation" is the most recent tool.result that
        # came before it in the same trace — i.e. the tool
        # result the agent just received and is reasoning
        # about. This works for both the ReAct pattern (LLM
        # call → tool.result → LLM call) and the planning pattern
        # (multiple LLM calls with interleaved tool results).
        steps: list[dict[str, Any]] = []
        step_idx = 0
        last_observation: str = ""
        last_observation_span: str | None = None
        for ev in events:
            event_type = (ev.get("event_type") or "").lower()
            if _is_tool_event(ev) and "result" in event_type:
                last_observation = _extract_observation(ev)
                last_observation_span = ev.get("span_id")
                continue
            if not _is_llm_event(ev):
                continue

            reasoning_text = _extract_reasoning(ev)
            action = _extract_chosen_action(ev)
            steps.append(
                {
                    "step_index": _step_index(step_idx),
                    "span_id": ev.get("span_id"),
                    "parent_span_id": ev.get("parent_span_id"),
                    "event_type": _classify_event(ev),
                    "reasoning_text": _truncate_or_empty(reasoning_text, _MAX_REASONING_CHARS),
                    "observation": _truncate_or_empty(last_observation, _MAX_OBSERVATION_CHARS),
                    "observation_span_id": last_observation_span,
                    "action": _truncate_or_empty(action, 500),
                    "timestamp": ev.get("timestamp"),
                    "agent_id": ev.get("agent_id"),
                    "outcome": ev.get("outcome"),
                }
            )
            step_idx += 1
            # A new LLM call "consumes" the observation; the
            # next tool_result will replace it.
            last_observation = ""

        return _ok_envelope(
            self.name,
            {
                "trace_id": trace_id,
                "step_count": len(steps),
                "has_reasoning_count": sum(1 for s in steps if s["reasoning_text"]),
                "steps": steps,
            },
        )
