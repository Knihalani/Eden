"""F65 — Topics / insights API."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_path_org_access
from eden.topics.service import act_on_topic, generate_topics, list_topics, topics_to_csv

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


@router.get("/export")
async def export_topics(
    org_id: str = Depends(require_path_org_access),
    facet: Literal["task", "sentiment", "issues", "custom"] | None = Query(None),
    format: Literal["csv", "json"] = Query("csv"),
    user: dict = Depends(get_current_user),
) -> Any:
    """FEAT-179 — export topic/pattern cluster results as CSV or JSON.

    Reuses :func:`list_topics` (the same rows the ``/topics`` list and
    portal page render) so the export always matches what's on screen.
    """
    _ = user
    topics = await list_topics(org_id, facet=facet, limit=500)
    if format == "json":
        return {"status": "ok", "feature": "f65_topics", "topics": topics, "count": len(topics)}

    csv_text = topics_to_csv(topics)
    stamp = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
    filename = f"topics_{org_id}_{stamp}.csv"
    return StreamingResponse(
        iter([csv_text.encode("utf-8")]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/generate")
async def run_topic_generation(
    org_id: str = Depends(require_path_org_access),
    body: GenerateTopicsRequest = Body(default_factory=GenerateTopicsRequest),
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
