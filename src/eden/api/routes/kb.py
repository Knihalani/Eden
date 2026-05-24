"""Knowledge Base query routes for Eden API."""

import logging
from typing import Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel

from eden.kb.episodic.client import get_episodic_client
from eden.kb.semantic.vector_client import get_vector_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/kb", tags=["knowledge-base"])


class KBQueryResponse(BaseModel):
    """Response schema for KB query."""

    query: str
    collection: str
    limit: int
    episodic_results: list[dict]
    semantic_results: list[dict]
    total_episodic: int
    total_semantic: int


@router.get("/query", response_model=KBQueryResponse)
async def query_kb(
    query: str = Query(..., description="Search query"),
    collection: str = Query("all", description="Collection to search: all, episodic, skills, exploits, semantic"),
    limit: int = Query(20, ge=1, le=100),
):
    """Query the Knowledge Base across all layers.

    - episodic: Job records with full pipeline traces
    - skills: Skill Library code templates
    - exploits: Exploit Library probes
    - semantic: Design patterns and best practices
    """
    episodic_results = []
    semantic_results = []
    total_episodic = 0
    total_semantic = 0

    episodic_client = get_episodic_client()

    if collection in ("all", "episodic", "jobs"):
        # Full-text search on job descriptions
        episodic_results = await episodic_client.search_by_description(query, limit)
        total_episodic = len(episodic_results)

    if collection in ("all", "semantic", "skills", "exploits"):
        # Vector search requires embedding - return descriptive query instead
        # The actual vector search is done internally by agents with proper embedding
        logger.debug(f"Vector search for collection={collection} query={query}")

    return KBQueryResponse(
        query=query,
        collection=collection,
        limit=limit,
        episodic_results=episodic_results,
        semantic_results=semantic_results,
        total_episodic=total_episodic,
        total_semantic=total_semantic,
    )