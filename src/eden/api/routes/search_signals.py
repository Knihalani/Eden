"""N10 — deep search → signal API."""

from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, Path
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_org_member
from eden.search.deep_to_signal import preview_save_as_signal, save_search_as_signal

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/search",
    tags=["search-signals"],
    dependencies=[Depends(get_current_user)],
)


class SaveAsSignalRequest(BaseModel):
    search_query: str = Field(..., min_length=2, max_length=2000)
    trace_ids: list[str] = Field(..., min_length=1, max_length=500)
    mode: Literal["investigator", "classifier"] = "investigator"
    backfill_days: int = Field(default=0, ge=0, le=30)


class PreviewSignalRequest(BaseModel):
    search_query: str = Field(..., min_length=2, max_length=2000)
    trace_ids: list[str] = Field(..., min_length=1, max_length=500)
    mode: Literal["investigator", "classifier"] = "investigator"
    backfill_days: int = Field(default=7, ge=0, le=30)


@router.post("/to-signal/preview")
async def preview_as_signal(
    org_id: str = Path(...),
    body: PreviewSignalRequest = Body(...),
    user: dict = Depends(require_org_member),
) -> dict[str, Any]:
    _ = user
    data = await preview_save_as_signal(
        org_id,
        search_query=body.search_query,
        trace_ids=body.trace_ids,
        mode=body.mode,
        backfill_days=body.backfill_days,
    )
    return {"status": "ok", "feature": "search_to_signal", "live": True, "data": data}


@router.post("/to-signal")
async def save_as_signal(
    org_id: str = Path(...),
    body: SaveAsSignalRequest = Body(...),
    user: dict = Depends(require_org_member),
) -> dict[str, Any]:
    created_by = str(user.get("sub") or user.get("user_id") or "")
    data = await save_search_as_signal(
        org_id,
        search_query=body.search_query,
        trace_ids=body.trace_ids,
        mode=body.mode,
        created_by=created_by or None,
        backfill_days=body.backfill_days,
    )
    return {"status": "ok", "feature": "search_to_signal", "live": True, "data": data}
