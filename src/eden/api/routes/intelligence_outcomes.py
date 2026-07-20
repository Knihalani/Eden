"""Intelligence Gap — Outcome / ROI Intelligence (Cat 11) routes.

Three routes, all backed by real implementations in
:mod:`eden.analytics.outcomes.tracker`:

* ``POST /orgs/{org_id}/intelligence/outcomes`` — attach a
  business outcome to a single trace. The primary *write*
  path for Cat 11; the rest of the surface is read-only and
  joins against the rows this route writes.
* ``GET /orgs/{org_id}/intelligence/outcomes/departments`` —
  per-department ROI rollup. The killer query for the CFO
  conversation. Persists per-``(org, dept, window)`` rows to
  ``outcome_department_rollups`` and fires the Cat 17
  :func:`PromotionHook.on_drift_alert` hook for any
  low-ROI department.
* ``GET /orgs/{org_id}/intelligence/outcomes/analytics`` —
  top-level summary + drift z-score.

The route is gated by the umbrella ``intelligence_gap_v0``
feature flag; per-route feature flags can be added in v1.5+
without touching this module.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Path, Query
from pydantic import BaseModel, Field

from eden.analytics.outcomes import (
    DepartmentAnalytics,
    OutcomeRollup,
    OutcomeTracker,
)
from eden.api.deps import get_current_user, require_feature_flag, require_path_org_access

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/outcomes",
    tags=["intelligence-outcomes"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
        Depends(require_path_org_access),
    ],
)

# Module-level singletons — stateless services, the same
# pattern used by the other intelligence routers. The
# methods are async so the singleton can be shared across
# concurrent requests without locking.
_tracker = OutcomeTracker()
_rollup = OutcomeRollup()
_dept = DepartmentAnalytics()


class TrackOutcomeRequest(BaseModel):
    """Body for :func:`track_outcome`.

    ``value`` is the dollar value of the outcome (0 is allowed
    for "free" outcomes; negative is rejected — a refund uses
    the dedicated ``outcome_voided`` flag per the appendix's
    failure-mode table, not a negative value). ``department``
    is the bucketing dimension; the service caps it at 64
    chars to match the column width.
    """

    trace_id: str = Field(..., min_length=1, max_length=128)
    outcome_type: str = Field(..., min_length=1, max_length=32)
    value: float = Field(..., ge=0.0)
    department: str | None = Field(default=None, max_length=64)


@router.post("")
async def track_outcome(
    org_id: str = Depends(require_path_org_access),
    body: TrackOutcomeRequest = Body(...),
) -> dict[str, Any]:
    return await _tracker.track(
        org_id,
        trace_id=body.trace_id,
        outcome_type=body.outcome_type,
        value=body.value,
        department=body.department,
    )


@router.get("/departments")
async def departments(
    org_id: str = Depends(require_path_org_access),
    window: str = Query(
        "30d",
        description=(
            "Time window for the rollup. Accepts Nh/Nd/Nm/Ns "
            "(e.g. '7d', '30d', '24h'). Default '30d'."
        ),
    ),
    department: str | None = Query(
        None,
        max_length=64,
        description=(
            "Optional department filter (the appendix's "
            "killer-query drill-down). When set, the "
            "response is narrowed to that single "
            "department."
        ),
    ),
) -> dict[str, Any]:
    return await _rollup.by_department(
        org_id, window=window, department=department
    )


@router.get("/analytics")
async def analytics(
    org_id: str = Depends(require_path_org_access),
    window: str = Query(
        "30d",
        description=(
            "Time window for the analytics summary. Accepts "
            "Nh/Nd/Nm/Ns. Default '30d'."
        ),
    ),
    department: str | None = Query(
        None,
        max_length=64,
        description=(
            "Optional department filter for a focused "
            "drill-down. Default: all departments."
        ),
    ),
) -> dict[str, Any]:
    return await _dept.rollup(
        org_id, window=window, department=department
    )
