"""DecisionAlternatives — list the actions the agent considered
and didn't take.

This is the **stubbiest** of the five Cat 16 services for a
reason: the agent runtime doesn't currently log "here are the
tools I considered before picking one" as a first-class field.
Most agents pick deterministically from their prompt; the LLM's
internal deliberation isn't surfaced in the telemetry payload.

The service therefore:

1. Looks for explicit alternatives in the event payload under
   several known keys (``considered_alternatives``,
   ``candidates``, ``choices``, ``tool_candidates``,
   ``request_body.tools``).
2. When none are found, returns the chosen tool and an empty
   ``considered`` list with a ``notes`` field that explains the
   gap, so callers can render "no alternatives recorded" in the
   UI.
3. Persists one row per (step, alternative) to the
   ``decision_alternatives`` table. The chosen one is flagged
   with ``chosen=TRUE``; the others with ``chosen=FALSE``.

The service is best-effort: the limitations of step 2 are
documented in the module docstring and surfaced to the caller,
not hidden.
"""

from __future__ import annotations

import logging
from typing import Any

from ._common import (
    _classify_event,
    _delete_then_insert,
    _extract_chosen_action,
    _fetch_trace_events,
    _insert_rows,
    _is_llm_event,
    _is_tool_event,
    _not_found_envelope,
    _ok_envelope,
    _step_index,
)

logger = logging.getLogger(__name__)


_MAX_CONSIDERED_CHARS = 500


def _extract_considered(event: dict[str, Any]) -> list[str]:
    """Best-effort list of alternative actions the agent weighed.

    Looks at, in order:
    * ``payload.considered_alternatives`` (list of strings or dicts)
    * ``payload.candidates`` (list of strings or dicts)
    * ``payload.choices`` (list of dicts with ``text``/``name``)
    * ``payload.tool_candidates`` (list)
    * OpenAI-style ``request_body.tools`` (list of ``{"type":
      "function", "function": {"name": ...}}``)

    Returns a de-duplicated list of tool names / action strings.
    Empty list means the runtime didn't record alternatives.
    """
    payload = event.get("payload") or {}
    if not isinstance(payload, dict):
        payload = {}

    candidates: list[Any] = []
    for key in (
        "considered_alternatives",
        "candidates",
        "tool_candidates",
        "alternatives",
    ):
        v = payload.get(key)
        if isinstance(v, list):
            candidates.extend(v)
        elif isinstance(v, str) and v.strip():
            candidates.append(v)

    # OpenAI ``choices`` shape on a request-side payload is unusual
    # but some agents pass it through. Treat it as a fallback.
    choices = payload.get("choices")
    if isinstance(choices, list):
        candidates.extend(choices)

    # OpenAI ``request_body.tools`` shape — list of tool defs.
    request_body = event.get("request_body") or {}
    if isinstance(request_body, dict):
        tools = request_body.get("tools")
        if isinstance(tools, list):
            for t in tools:
                if isinstance(t, dict):
                    fn = t.get("function") or {}
                    name = fn.get("name") or t.get("name")
                    if name:
                        candidates.append({"name": name})
                elif isinstance(t, str):
                    candidates.append(t)

    out: list[str] = []
    seen: set[str] = set()
    for c in candidates:
        if isinstance(c, str):
            text = c.strip()
        elif isinstance(c, dict):
            text = (
                c.get("name")
                or c.get("tool")
                or c.get("text")
                or c.get("action")
                or ""
            )
            if isinstance(text, dict):
                # nested: ``{"name": {"value": "x"}}``
                text = text.get("value") or text.get("name") or ""
            text = str(text).strip()
        else:
            continue
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


class DecisionAlternatives:
    """List the alternatives the agent considered per step."""

    name = "decision_alternatives"

    async def list_considered(
        self,
        org_id: str,
        trace_id: str,
    ) -> dict[str, Any]:
        events = await _fetch_trace_events(org_id, trace_id)
        if not events:
            return _not_found_envelope(self.name, trace_id)

        # Clear any stale rows for this (org, trace) before the
        # bulk insert — the table has no unique constraint, so
        # the only way to keep it idempotent is a delete-first
        # pattern.
        await _delete_then_insert(org_id, trace_id, "decision_alternatives", [], [])

        steps: list[dict[str, Any]] = []
        rows: list[tuple[Any, ...]] = []
        step_idx = 0
        for ev in events:
            event_type = (ev.get("event_type") or "").lower()
            # We score alternatives on LLM events that produced a
            # tool call (i.e. the agent was *choosing* between
            # tools). LLM events with no tool call and pure tool
            # results are skipped here.
            if _is_tool_event(ev) and "result" in event_type:
                # tool results aren't decisions
                continue
            if not _is_llm_event(ev) and not _is_tool_event(ev):
                continue

            chosen = _extract_chosen_action(ev)
            considered = _extract_considered(ev)

            if not considered and not chosen:
                # Nothing actionable on this event.
                continue

            # The "considered" set is the union of the extracted
            # candidates plus the chosen tool, so the chosen is
            # always represented in the response.
            considered_set = list(considered)
            if chosen and chosen not in considered_set:
                considered_set.append(chosen)

            notes = None
            if not considered:
                notes = "no alternatives recorded in payload"

            step_payload: dict[str, Any] = {
                "step_index": _step_index(step_idx),
                "span_id": ev.get("span_id"),
                "parent_span_id": ev.get("parent_span_id"),
                "event_type": _classify_event(ev),
                "considered": considered_set,
                "chosen": chosen or None,
                "score": None,
                "notes": notes,
                "timestamp": ev.get("timestamp"),
            }
            steps.append(step_payload)

            # Persist: one row per considered alternative. The
            # chosen one is flagged.
            for alt in considered_set:
                if not isinstance(alt, str) or not alt.strip():
                    continue
                truncated = alt[:_MAX_CONSIDERED_CHARS]
                rows.append(
                    (
                        _step_index(step_idx),
                        truncated,
                        bool(chosen) and alt == chosen,
                        None,  # score — populated by DecisionScorer if needed
                    )
                )

            step_idx += 1

        if rows:
            await _insert_rows(
                org_id,
                "decision_alternatives",
                rows,
                ["step_index", "considered", "chosen", "score"],
            )

        return _ok_envelope(
            self.name,
            {
                "trace_id": trace_id,
                "step_count": len(steps),
                "alternatives_total": sum(len(s["considered"]) for s in steps),
                "steps": steps,
            },
        )
