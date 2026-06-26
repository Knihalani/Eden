"""Onboarding API routes — D.14 cold-start UX (upgradespec §10.3 / §C.5).

The 4 endpoints (all under ``/v1/internal/onboarding/{org_id}``):

* ``GET  /state`` — read the current state (org-member gated).
  Lazy-creates a default row on first read so a new org gets
  ``current_step='install'`` with empty completed steps.
* ``POST /advance`` — move to the next step (org-admin gated).
  Body: ``{"target_step": "org", "force": false}``. Skipping
  is blocked unless ``force=True`` (used by milestone
  auto-advance from the hook bus).
* ``POST /milestone`` — record a milestone (org-admin gated).
  Body: ``{"milestone": "first_10_traces"}``. Idempotent;
  auto-advances the org if the milestone maps to a step.
* ``POST /enable_cat`` — toggle a cat enablement (org-admin gated).
  Body: ``{"cat_id": "cat-3", "config": {...}}``. Idempotent;
  stores ``{enabled_at, config}`` in the JSONB.

The 7-step order is enforced in
:class:`eden.services.onboarding.OnboardingStateMachine` —
the route layer just maps JSON to method calls.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Path
from pydantic import BaseModel, Field

from eden.api.deps import (
    get_current_user,
    require_org_admin,
    require_org_member,
)
from eden.services.onboarding import (
    ONBOARDING_STEPS,
    get_state_machine,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/v1/internal/onboarding/{org_id}",
    tags=["onboarding"],
    dependencies=[Depends(get_current_user)],
)


class AdvanceRequest(BaseModel):
    target_step: str = Field(..., min_length=1, max_length=32)
    force: bool = False


class MilestoneRequest(BaseModel):
    milestone: str = Field(..., min_length=1, max_length=128)


class EnableCatRequest(BaseModel):
    cat_id: str = Field(..., min_length=1, max_length=64)
    config: dict[str, Any] = Field(default_factory=dict)


# ── helpers ──────────────────────────────────────────────────────────


def _state_to_dict(state) -> dict[str, Any]:
    return {
        "org_id": state.org_id,
        "current_step": state.current_step,
        "completed_steps": list(state.completed_steps),
        "cat_enablements": dict(state.cat_enablements),
        "first_trace_at": state.first_trace_at,
        "milestones_reached": list(state.milestones_reached),
        "created_at": state.created_at,
        "updated_at": state.updated_at,
        "source": state.source,
        "onboarding_v2_enabled": state.onboarding_v2_enabled,
        "last_audit": state.last_audit,
    }


# ── routes ───────────────────────────────────────────────────────────


@router.get("/state")
async def get_state(
    org_id: str = Path(...),
    _user: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Read the current onboarding state. Org-member gated.

    Defensive: the state machine already returns a synthetic
    StateRow when the DB is unreachable, so this should never
    raise. The outer try/except is a last-resort safety net for
    serialization failures (e.g. a non-JSONB value in the
    ``cat_enablements`` column from a manual DB write). On any
    unexpected error we return a default state so the portal
    /agents/connect flow can still render — a 500 here would
    prevent the user from connecting a repo at all. June 2026 fix.
    """
    try:
        sm = get_state_machine()
        state = await sm.get_state(org_id)
        return {
            "status": "ok",
            "feature": "onboarding",
            "live": True,
            "data": _state_to_dict(state),
            "steps": [s.value for s in ONBOARDING_STEPS],
        }
    except Exception as exc:
        logger.warning("onboarding: get_state fallback for org=%s: %s", org_id, exc)
        return {
            "status": "ok",
            "feature": "onboarding",
            "live": False,
            "data": {
                "org_id": org_id,
                "current_step": "install",
                "completed_steps": [],
                "cat_enablements": {},
                "first_trace_at": None,
                "milestones_reached": [],
                "created_at": "",
                "updated_at": "",
                "source": "fallback",
                "onboarding_v2_enabled": True,
                "last_audit": None,
            },
            "steps": [s.value for s in ONBOARDING_STEPS],
        }


@router.post("/advance")
async def advance(
    org_id: str = Path(...),
    body: AdvanceRequest = Body(...),
    _admin: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    """Advance to a target step. Org-admin gated."""
    sm = get_state_machine()
    try:
        state = await sm.advance(
            org_id, body.target_step, force=body.force
        )
    except ValueError as exc:
        return {
            "status": "error",
            "feature": "onboarding",
            "live": False,
            "message": str(exc),
            "data": None,
        }
    return {
        "status": "ok",
        "feature": "onboarding",
        "live": True,
        "data": _state_to_dict(state),
    }


@router.post("/milestone")
async def record_milestone(
    org_id: str = Path(...),
    body: MilestoneRequest = Body(...),
    _admin: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    """Record a milestone. Idempotent; auto-advances if mapped."""
    sm = get_state_machine()
    state = await sm.record_milestone(org_id, body.milestone)
    return {
        "status": "ok",
        "feature": "onboarding",
        "live": True,
        "data": _state_to_dict(state),
    }


@router.post("/enable_cat")
async def enable_cat(
    org_id: str = Path(...),
    body: EnableCatRequest = Body(...),
    _admin: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    """Toggle a cat enablement. Idempotent."""
    sm = get_state_machine()
    state = await sm.enable_cat(
        org_id, body.cat_id, config=body.config
    )
    return {
        "status": "ok",
        "feature": "onboarding",
        "live": True,
        "data": _state_to_dict(state),
    }
