"""AgentTrajectoryAnalyzer — Phoenix-style multi-step trajectory
analysis.

Walks every event in the trace and builds:

* A ``trajectory`` list — one entry per event, in chronological
  order, with a stable ``step_index``, ``type``
  (``llm_call``/``tool_call``/``tool_result``/``span``), the
  span's ``name``/``duration_ms``/``outcome``/``error``, and
  whatever the event had for ``action`` or ``tool_name``.
* An ``analysis`` summary — total steps, counts by type, error
  count, total duration, repeated-tool frequency map, the
  top-level outcome, and a couple of coarse "coherence
  issues" hints (e.g. a tool that was called 3+ times back to
  back likely signals a stuck loop).

The trajectory is persisted as a single ``agent_trajectories``
row per (org, trace), with both ``trajectory_json`` and
``analysis_json`` populated. The trajectory JSON is the
authoritative ordered view; the analysis JSON is the
precomputed aggregates so the front-end can render summary
tiles without re-walking the trajectory client-side.
"""

from __future__ import annotations

import contextlib
import logging
from collections import Counter
from typing import Any

from ._common import (
    _delete_then_insert,
    _extract_chosen_action,
    _fetch_trace_events,
    _is_llm_event,
    _is_tool_event,
    _json_dumps,
    _not_found_envelope,
    _ok_envelope,
    _step_index,
)

logger = logging.getLogger(__name__)


# A tool called this many times across the trace is a "repeated
# tool" — surfaced in the analysis so the front-end can flag
# potentially-stuck loops.
_REPEATED_TOOL_THRESHOLD = 3


def _event_name(event: dict[str, Any]) -> str:
    """Best-effort short label for an event (used in the
    trajectory list and the analysis).
    """
    return (
        event.get("name")
        or _extract_chosen_action(event)
        or event.get("event_type")
        or "unknown"
    )


def _step_kind(event: dict[str, Any]) -> str:
    """Bucket an event for the trajectory view.

    Returns one of: ``"llm_call"``, ``"tool_call"``,
    ``"tool_result"``, ``"span"``. The ``"span"`` bucket is the
    catch-all for span start/end events that don't represent
    a decision or a tool call on their own.
    """
    event_type = (event.get("event_type") or "").lower()
    if _is_tool_event(event):
        if "result" in event_type:
            return "tool_result"
        return "tool_call"
    if _is_llm_event(event):
        return "llm_call"
    if "span" in event_type:
        return "span"
    return "other"


def _detect_repeated_tools(trajectory: list[dict[str, Any]]) -> dict[str, int]:
    """Count occurrences of each tool name in the trajectory.

    Counts tools called from both:
    * explicit ``tool_call`` events (the agent runtime emitted
      a dedicated tool.call event)
    * LLM events whose chosen action is a tool (the agent's
      tool call was embedded in the LLM response)

    The caller surfaces the entries with count >= threshold so
    the front-end can flag potentially-stuck loops.
    """
    counts: Counter[str] = Counter()
    for step in trajectory:
        name: str | None = None
        if step.get("type") == "tool_call":
            name = step.get("tool_name") or step.get("name")
        elif step.get("type") == "llm_call":
            # LLM events carry the chosen action in the
            # trajectory's ``name`` field (set by
            # ``_event_name``); for a tool-calling LLM the
            # chosen action is the tool name.
            event_name = step.get("name")
            # The path reconstructor distinguishes between an
            # LLM call with a tool decision and an LLM call
            # with a free-form text response by the chosen
            # action length and shape. Cheap heuristic: the
            # chosen action for a tool call is short (<= 80
            # chars, no spaces in the middle).
            if (
                isinstance(event_name, str)
                and event_name.strip()
                and " " not in event_name.strip()
                and len(event_name.strip()) <= 80
            ):
                name = event_name.strip()
        if not name:
            continue
        counts[name] += 1
    return {name: count for name, count in counts.items() if count >= _REPEATED_TOOL_THRESHOLD}


class AgentTrajectoryAnalyzer:
    """Phoenix-style multi-step trajectory analysis."""

    name = "agent_trajectory"

    async def analyze(
        self,
        org_id: str,
        trace_id: str,
    ) -> dict[str, Any]:
        events = await _fetch_trace_events(org_id, trace_id)
        if not events:
            return _not_found_envelope(self.name, trace_id)

        trajectory: list[dict[str, Any]] = []
        llm_count = 0
        tool_call_count = 0
        tool_result_count = 0
        span_count = 0
        error_count = 0
        total_duration_ms = 0.0
        reasoning_count = 0
        outcome: str | None = None

        for idx, ev in enumerate(events):
            kind = _step_kind(ev)
            if kind == "llm_call":
                llm_count += 1
            elif kind == "tool_call":
                tool_call_count += 1
            elif kind == "tool_result":
                tool_result_count += 1
            else:
                span_count += 1

            ev_outcome = ev.get("outcome")
            if ev_outcome == "failure":
                error_count += 1
            if ev_outcome and outcome is None:
                outcome = ev_outcome

            duration = ev.get("duration_ms") or 0.0
            with contextlib.suppress(TypeError, ValueError):
                total_duration_ms += float(duration)

            payload = ev.get("payload") or {}
            has_reasoning = bool(
                (isinstance(payload, dict) and (payload.get("reasoning") or payload.get("thought")))
                or ev.get("reasoning")
            )
            if has_reasoning:
                reasoning_count += 1

            name = _event_name(ev)
            tool_name: str | None = None
            if kind == "tool_call":
                tool_name = _extract_chosen_action(ev) or name

            trajectory.append(
                {
                    "step_index": _step_index(idx),
                    "type": kind,
                    "name": name,
                    "tool_name": tool_name,
                    "span_id": ev.get("span_id"),
                    "parent_span_id": ev.get("parent_span_id"),
                    "event_type": ev.get("event_type"),
                    "duration_ms": duration,
                    "timestamp": ev.get("timestamp"),
                    "agent_id": ev.get("agent_id"),
                    "outcome": ev_outcome,
                    "error": ev.get("error"),
                }
            )

        repeated_tools = _detect_repeated_tools(trajectory)
        total_steps = len(trajectory)
        error_rate = (error_count / total_steps) if total_steps else 0.0

        # A "coherence issue" is a coarse, deterministic signal
        # the front-end can render. The list is intentionally
        # small — Phoenix-style signal, not LLM judgement.
        coherence_issues: list[dict[str, Any]] = []
        for tool_name, count in repeated_tools.items():
            coherence_issues.append(
                {
                    "kind": "repeated_tool",
                    "tool_name": tool_name,
                    "count": count,
                }
            )
        if reasoning_count == 0 and llm_count > 0:
            coherence_issues.append(
                {
                    "kind": "no_reasoning_recorded",
                    "llm_call_count": llm_count,
                }
            )
        if error_rate > 0.5 and error_count > 0:
            coherence_issues.append(
                {
                    "kind": "high_error_rate",
                    "error_count": error_count,
                    "total_steps": total_steps,
                    "error_rate": error_rate,
                }
            )

        analysis = {
            "total_steps": total_steps,
            "llm_call_count": llm_count,
            "tool_call_count": tool_call_count,
            "tool_result_count": tool_result_count,
            "span_count": span_count,
            "error_count": error_count,
            "error_rate": error_rate,
            "total_duration_ms": total_duration_ms,
            "reasoning_recorded_count": reasoning_count,
            "outcome": outcome,
            "repeated_tools": repeated_tools,
            "coherence_issues": coherence_issues,
        }

        # Persist one row per (org, trace).
        await _delete_then_insert(
            org_id,
            trace_id,
            "agent_trajectories",
            ["trajectory_json", "analysis_json"],
            [
                _json_dumps({"trace_id": trace_id, "trajectory": trajectory}),
                _json_dumps(analysis),
            ],
        )

        return _ok_envelope(
            self.name,
            {
                "trace_id": trace_id,
                "trajectory": trajectory,
                "analysis": analysis,
            },
        )
