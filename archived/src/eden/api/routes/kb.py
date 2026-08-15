"""Knowledge Base query routes for Eden API."""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from eden.api.deps import get_current_user
from eden.kb.episodic.client import get_episodic_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/kb", tags=["knowledge-base"])


class KBQueryResponse(BaseModel):
    """Response schema for KB query."""

    query: str
    collection: str
    limit: int
    episodic_results: list[dict]
    total_episodic: int


@router.get("/query", response_model=KBQueryResponse)
async def query_kb(
    _user: dict = Depends(get_current_user),
    query: str = Query(..., description="Search query"),
    collection: str = Query("all", description="Collection to search: all or episodic"),
    limit: int = Query(20, ge=1, le=100),
):
    """Query the Knowledge Base episodic layer."""
    if collection not in ("all", "episodic"):
        raise HTTPException(
            status_code=400,
            detail=(
                "Only 'episodic' search is available. "
                "Semantic/skills/exploits collections were removed."
            ),
        )

    episodic_client = get_episodic_client()
    episodic_results = await episodic_client.search_by_description(query, limit)

    return KBQueryResponse(
        query=query,
        collection=collection,
        limit=limit,
        episodic_results=episodic_results,
        total_episodic=len(episodic_results),
    )
