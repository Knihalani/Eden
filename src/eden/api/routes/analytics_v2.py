"""Analytics v2 routes — cohorts + funnels (§8.2).

Mounts:
  - GET /orgs/{org_id}/analytics/cohorts?weeks=8
  - GET /orgs/{org_id}/analytics/funnel?steps=session_started,engaged,completed&window_days=30
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from eden.analytics import cohort_retention, funnel
from eden.api.deps import get_current_user, require_path_org_access
from eden.api.utils.redact import redact_all
from eden.api.utils.safe_error import raise_mapped_db_error

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/orgs/{org_id}/analytics", tags=["analytics"], dependencies=[Depends(require_path_org_access)])


@router.get("/cohorts")
async def get_cohorts(
    org_id: str = Depends(require_path_org_access),
    weeks: int = Query(default=8, ge=1, le=52),
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        rows = await cohort_retention(org_id, weeks=weeks)
    except Exception as exc:
        logger.warning("get_cohorts failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="cohort analytics unavailable",
            uuid_detail="Invalid organization id",
        )
    return {
        "org_id": org_id,
        "weeks": weeks,
        "cohorts": [
            {
                "cohort": r.cohort,
                "start_date": r.start_date.isoformat(),
                "size": r.size,
                "retention": {str(k): round(v, 4) for k, v in r.retention.items()},
            }
            for r in rows
        ],
    }


@router.get("/funnel")
async def get_funnel(
    org_id: str = Depends(require_path_org_access),
    steps: str = Query(..., description="Comma-separated list of step names, ordered"),
    window_days: int = Query(default=30, ge=1, le=365),
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    step_list = [s.strip() for s in steps.split(",") if s.strip()]
    if len(step_list) < 2:
        raise HTTPException(status_code=400, detail="Provide at least two comma-separated steps")
    try:
        result = await funnel(org_id, step_list, window_days=window_days)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.warning("get_funnel failed: %s", redact_all(str(exc)))
        raise_mapped_db_error(
            exc,
            fallback="funnel analytics unavailable",
            uuid_detail="Invalid organization id",
        )
    return {
        "org_id": org_id,
        "window_days": window_days,
        "name": result.name,
        "overall_conversion": round(result.overall_conversion, 4),
        "steps": [
            {
                "name": s.name,
                "count": s.count,
                "conversion_from_previous": round(s.conversion_from_previous, 4),
            }
            for s in result.steps
        ],
    }
