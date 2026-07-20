"""Intelligence Gap — Closed-Loop Wiring (Cat 17) routes.

Five routes that surface the hook recommendations the
:class:`ClosedLoopExecutor` aggregates:

* ``GET  /actions``                 — list the org's pending
  closed-loop actions (the portal's "Pending Actions" panel
  reads from this).
* ``GET  /actions/all``             — list *all* actions
  (any status), newest first.
* ``POST /actions/{action_id}/approve`` — mark a pending
  action as approved.
* ``POST /actions/{action_id}/deny``    — mark a pending
  action as denied.
* ``POST /actions/{action_id}/apply``   — apply a single
  approved action. v0 is a no-op side effect; v0.1 wires
  the per-action handlers.
* ``GET  /dashboard``               — aggregate counts per
  ``action_kind`` + ``status`` + ``severity`` for the
  closed-loop dashboard.

Gates:
* ``intelligence_gap_v0`` umbrella flag (product surface for Cat 17)
* Org scoping via ``{org_id}`` path param
* ``get_current_user`` for auth
* ``require_org_admin`` on ``approve`` and ``deny`` (beyond bare membership)

Product-flag note: this router intentionally does **not** call
Improve's ``agent_v1`` gate. Intelligence closed-loop is gated by
``intelligence_gap_v0`` alone; the Improve cockpit's ``closed_loop:``
item-approve path additionally requires agent_v1 so flag-off orgs
cannot approve while Improve UI shows disabled. Keep those gates
separate — do not mirror agent_v1 here.

The ``approve`` / ``deny`` / ``apply`` routes accept an
optional ``applied_by`` query param so the audit log
captures the user who actioned the recommendation.

See ``docs/eden-observability-gap-roadmap.md`` (Cat 17) and
``docs/observability-gap/17-closed-loop-wiring.md``.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Path, Query

from eden.api.deps import (
    _try_resolve_token_payload,
    get_current_user,
    require_feature_flag,
    require_org_admin,
    require_path_org_access,
)
from eden.llmops.closed_loop_executor import ClosedLoopExecutor

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/closed-loop",
    tags=["intelligence-closed-loop"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
        Depends(require_path_org_access),
    ],
)

_executor = ClosedLoopExecutor()


@router.get("/actions")
async def list_pending(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(50, ge=1, le=500),
) -> dict[str, Any]:
    """List the org's pending closed-loop actions."""
    return await _executor.list_pending(org_id, limit=limit)


@router.get("/actions/all")
async def list_all(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(50, ge=1, le=500),
) -> dict[str, Any]:
    """List all closed-loop actions (any status), newest first."""
    return await _executor.list_all(org_id, limit=limit)


@router.post("/actions/{action_id}/approve")
async def approve(
    org_id: str = Depends(require_path_org_access),
    action_id: str = Path(...),
    applied_by: str | None = Query(None),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict[str, Any]:
    """Mark a pending action as approved.

    The v0 ship flips the status flag only; the side-effect
    applier is the v0.1 follow-up. The status change is
    recorded in the audit log via ``applied_by``.
    Org admin/owner required — bare membership is not enough.
    """
    await require_org_admin(org_id, payload)
    return await _executor.approve(
        org_id, action_id=action_id, applied_by=applied_by
    )


@router.post("/actions/{action_id}/deny")
async def deny(
    org_id: str = Depends(require_path_org_access),
    action_id: str = Path(...),
    applied_by: str | None = Query(None),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> dict[str, Any]:
    """Mark a pending action as denied.

    Org admin/owner required — bare membership is not enough
    (same privilege bar as approve).
    """
    await require_org_admin(org_id, payload)
    return await _executor.deny(
        org_id, action_id=action_id, applied_by=applied_by
    )


@router.post("/actions/{action_id}/apply")
async def apply(
    org_id: str = Depends(require_path_org_access),
    action_id: str = Path(...),
    applied_by: str | None = Query(None),
) -> dict[str, Any]:
    """Apply a single approved action.

    v0 ships a best-effort no-op side effect; v0.1 wires
    the per-action handlers (block_promotion, rollback, …).
    """
    return await _executor.apply_approved(
        org_id, action_id=action_id, applied_by=applied_by
    )


@router.get("/dashboard")
async def dashboard(org_id: str = Depends(require_path_org_access)) -> dict[str, Any]:
    """Aggregate counts per ``action_kind`` + status + severity."""
    return await _executor.dashboard(org_id)
