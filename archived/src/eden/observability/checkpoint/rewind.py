"""Checkpoint rewind service (Cat 1).

LangGraph-Studio-style time-travel replay: a user can rewind a
stateful agent execution to any prior step and re-execute
forward from there. Useful for "what if I had answered
differently at step 4" debugging.

Real implementation reads from ``trace_replay_sessions`` (the
new Cat 1 table from migration 020). The table is keyed by
``(org_id, trace_id)`` with a ``cursor`` (the step index) and
a ``state_json`` (the captured state at that step).

Note: the original Cat 1 appendix referenced the
``checkpoint_blobs`` table from migration 001, but that table
is keyed by ``(job_id, field)`` and predates the trace_id
naming convention. ``trace_replay_sessions`` is the natural
home for Cat 1's rewind; ``checkpoint_blobs`` is read-only
per the Phase 2 cutover and is still surfaced for legacy
job-style workflows.

See ``docs/observability-gap/01-trace-replay.md``.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from eden.observability._trace_common import (
    error_envelope,
    fetch_session_at_cursor,
    fetch_sessions,
    not_found_envelope,
    ok_envelope,
)

logger = logging.getLogger(__name__)


class CheckpointService:
    """Time-travel replay for stateful agent executions."""

    name = "checkpoint_rewind"

    async def rewind_to_step(
        self,
        org_id: str,
        trace_id: str,
        *,
        step_index: int,
    ) -> dict[str, Any]:
        """Return the state at ``step_index`` for a re-run.

        Reads the most recent ``trace_replay_sessions`` row
        for the (org, trace) with ``cursor <= step_index``.
        That row's ``state_json`` is parsed and returned so
        the caller can reconstruct the agent state at that
        point and re-execute forward.

        If no session exists yet, returns
        ``not_found_envelope`` — the user is asked to open a
        replay first, which creates a session row.

        A negative ``step_index`` is rejected with
        ``error_envelope`` (invalid_input) rather than
        silently treated as 0.
        """
        try:
            step_int = int(step_index)
        except (TypeError, ValueError):
            return error_envelope(
                self.name,
                "step_index must be an integer",
                code="invalid_input",
            )
        if step_int < 0:
            return error_envelope(
                self.name,
                "step_index must be >= 0",
                code="invalid_input",
            )

        row = await fetch_session_at_cursor(
            org_id, trace_id, cursor=step_int
        )
        if row is None:
            return not_found_envelope(self.name, trace_id)

        # Parse state_json safely. If the field is None or
        # malformed, return an empty state with a flag so
        # the caller knows the rewind point is valid but
        # state is missing.
        state: Any = None
        state_parsed = False
        state_error: str | None = None
        raw_state = row.get("state_json")
        if raw_state is None or raw_state == "":
            state = None
        else:
            try:
                state = json.loads(raw_state)
                state_parsed = True
            except (TypeError, ValueError) as exc:
                state = raw_state
                state_error = f"state_json not valid JSON: {exc}"

        return ok_envelope(
            self.name,
            {
                "trace_id": trace_id,
                "step_index": step_int,
                "rewound_to": row.get("cursor"),
                "session_id": row.get("id"),
                "state": state,
                "state_parsed": state_parsed,
                "state_error": state_error,
                "message": (
                    "rewound to step — re-run forward from here"
                ),
            },
        )

    async def list_checkpoints(
        self,
        org_id: str,
        trace_id: str,
    ) -> dict[str, Any]:
        """List all available checkpoint step indexes for ``trace_id``."""
        rows = await fetch_sessions(org_id, trace_id)
        checkpoints = [
            {
                "session_id": r.get("id"),
                "cursor": r.get("cursor"),
                "user_id": r.get("user_id"),
                "updated_at": r.get("updated_at"),
                "created_at": r.get("created_at"),
                "has_state": bool(r.get("state_json")),
            }
            for r in rows
        ]
        return ok_envelope(
            self.name,
            {
                "trace_id": trace_id,
                "checkpoint_count": len(checkpoints),
                "checkpoints": checkpoints,
            },
        )
