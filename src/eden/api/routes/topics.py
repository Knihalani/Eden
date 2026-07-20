"""F65 — Topics / insights API."""

from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_path_org_access
from eden.topics.service import act_on_topic, generate_topics, list_topics

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/topics",
    tags=["topics"],
    dependencies=[Depends(get_current_user),
        Depends(require_path_org_access),
    ],
)


class GenerateTopicsRequest(BaseModel):
    facet: Literal["task", "sentiment", "issues", "custom"] = "task"


class TopicActRequest(BaseModel):
    action: Literal["dataset", "alert"] = "dataset"
    name: str | None = Field(default=None, max_length=120)


@router.get("")
async def get_topics(
    org_id: str = Depends(require_path_org_access),
    facet: Literal["task", "sentiment", "issues", "custom"] | None = Query(None),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    topics = await list_topics(org_id, facet=facet)
    return {"status": "ok", "feature": "f65_topics", "topics": topics, "count": len(topics)}


@router.post("/generate")
async def run_topic_generation(
    org_id: str = Depends(require_path_org_access),
    body: GenerateTopicsRequest = Body(default=GenerateTopicsRequest()),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    result = await generate_topics(org_id, facet=body.facet)
    return {"status": "ok", "feature": "f65_topics", "data": result}


@router.post("/{topic_id}/act")
async def topic_act(
    org_id: str = Depends(require_path_org_access),
    topic_id: str = Path(...),
    body: TopicActRequest = Body(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user
    try:
        result = await act_on_topic(
            org_id, topic_id, action=body.action, name=body.name
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from None
    return {"status": "ok", "feature": "f65_topics", "data": result}
