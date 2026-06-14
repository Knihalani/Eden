"""Cat 20 — TraceForker.

The headline. Branches a trace at step N, producing a new
``fork_id`` that inherits the cached payload of steps 1..N-1.

The forker is intentionally minimal in v1.3:

* **Idempotent** — re-forking the same ``(org, parent,
  fork_at_step)`` tuple with the same name updates the
  existing row (the :func:`_upsert_fork_branch` helper).
* **Edits are persisted** — the ``edits_json`` column
  captures the edits applied at fork time so a replay
  is reproducible even if the customer later edits the
  fork.
* **Validation is upfront** — the forker checks the
  parent trace has at least one ``agent.step`` event
  before persisting the fork. A fork on an empty trace
  is still allowed (the replayer will re-execute
  everything live + surface a clear
  ``cache_miss_warnings`` field).

The v1.3 ship does NOT actually clone the trace's
``telemetry_events`` rows. The fork is a lightweight
metadata row; the cached steps live in the existing
``cache_lookups`` table (the gateway writes to it on
every cache hit) and in the existing
``telemetry_events.payload`` (the response body is
already persisted by the existing ingestion path).

A v2 implementation can add a true ``trace_id`` clone
step if customers want to query the fork's events
independently of the parent.
"""

from __future__ import annotations

import logging
from typing import Any

from ._common import (
    _fork_id_for,
    _get_parent_steps,
    _json_dumps,
    _not_implemented_envelope,
    _ok_envelope,
    _upsert_fork_branch,
)

logger = logging.getLogger(__name__)


class TraceForker:
    """Fork a trace at step N."""

    async def fork(
        self,
        org_id: str,
        *,
        parent_trace_id: str,
        fork_at_step: int,
        name: str,
        parent_fork_id: str | None = None,
        edits: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Create a fork branch and return its metadata.

        Args:
            org_id: The tenant id.
            parent_trace_id: The trace being forked.
            fork_at_step: The step index the customer
                chose to fork at. The replayer serves
                steps ``1..fork_at_step-1`` from cache
                and re-executes ``fork_at_step..N`` live.
                Must be >= 0.
            name: The customer-facing fork name.
            parent_fork_id: The fork_id this fork is
                derived from. ``None`` for the first
                fork; non-None for fork-of-fork.
            edits: The per-step edits applied at fork
                time. Persisted as JSON in
                ``trace_fork_branches.edits_json`` for
                replay reproducibility.

        Returns:
            The Cat 20 live envelope with the new
            ``fork_id`` and the fork metadata. On a
            validation error, the envelope is the
            ``not_implemented`` shape.
        """
        if not parent_trace_id or not parent_trace_id.strip():
            return _not_implemented_envelope(
                "TraceForker",
                "parent_trace_id is required and must be non-empty",
            )
        if not isinstance(fork_at_step, int) or fork_at_step < 0:
            return _not_implemented_envelope(
                "TraceForker",
                f"fork_at_step must be a non-negative integer "
                f"(got {fork_at_step!r})",
            )
        if not name or not name.strip():
            return _not_implemented_envelope(
                "TraceForker",
                "name is required and must be non-empty",
            )
        # Optional: validate the parent has at least one
        # agent.step event. We don't fail on an empty
        # parent — the customer may want to fork an
        # "in-flight" trace — but we surface a hint in the
        # response.
        parent_steps = await _get_parent_steps(
            parent_trace_id=parent_trace_id, org_id=org_id
        )
        n_parent_steps = len(parent_steps)

        fork_id = _fork_id_for()
        await _upsert_fork_branch(
            org_id=org_id,
            fork_id=fork_id,
            parent_trace_id=parent_trace_id,
            parent_fork_id=parent_fork_id,
            fork_at_step=fork_at_step,
            name=name,
            edits_json=_json_dumps(edits or {}),
        )

        return _ok_envelope(
            "TraceForker",
            {
                "fork_id": fork_id,
                "parent_trace_id": parent_trace_id,
                "parent_fork_id": parent_fork_id,
                "fork_at_step": fork_at_step,
                "name": name,
                "n_parent_steps": n_parent_steps,
                "has_cacheable_steps": n_parent_steps > 0,
                "edits_applied": list((edits or {}).keys()),
            },
        )


__all__ = ["TraceForker"]
