"""Semantic memory - vector search client.

Handles embedding-based retrieval using pgvector (N4 — Qdrant replaced).
"""

from __future__ import annotations

import logging
from typing import Any

from eden.kb.retrieval_logger import get_retrieval_logger
from eden.storage.pgvector import SearchResult, SearchResults, get_pgvector_client

logger = logging.getLogger(__name__)


def _as_result_list(raw: SearchResults | list[SearchResult] | Any) -> list[SearchResult]:
    """Normalize pgvector wrapper output to ``list[SearchResult]``."""
    if isinstance(raw, SearchResults):
        return list(raw.results or [])
    if isinstance(raw, list):
        return raw
    results = getattr(raw, "results", None)
    if isinstance(results, list):
        return results
    return []


def _payload_matches(payload: dict[str, Any], filter_conditions: dict[str, Any]) -> bool:
    """Equality match for simple ``{field: value}`` filter dicts."""
    for key, expected in filter_conditions.items():
        if key.startswith("$"):
            continue
        if payload.get(key) != expected:
            return False
    return True


class SemanticVectorClient:
    """Client for semantic vector search operations.

    Uses Postgres pgvector for dense search (N4).
    """

    async def search(
        self,
        collection: str,
        query_vector: list[float],
        filter_conditions: dict | None = None,
        limit: int = 20,
        score_threshold: float | None = None,
    ) -> list[SearchResult]:
        """Search for similar vectors.

        Args:
            collection: Collection name (without prefix)
            query_vector: Query embedding
            filter_conditions: Optional metadata filters
            limit: Max results
            score_threshold: Minimum similarity score

        Returns:
            List of SearchResult objects
        """
        client = get_pgvector_client()

        raw = await client.search_async(
            collection=collection,
            query_vector=query_vector,
            query_filter=filter_conditions,
            limit=limit,
            score_threshold=score_threshold,
        )
        results = _as_result_list(raw)

        # Log retrieval for RetrievalTuner
        try:
            retrieval_logger = get_retrieval_logger()
            retrieved = [{"id": str(r.id)} for r in results]
            await retrieval_logger.log_retrieval(
                collection=collection,
                query_vector=query_vector,
                retrieved_items=retrieved,
                retrieval_method="vector",
                filter_conditions=filter_conditions,
                score_threshold=score_threshold,
            )
        except Exception as e:
            logger.warning("Failed to log retrieval: %s", e)

        return results

    async def search_hybrid(
        self,
        collection: str,
        query_vector: list[float],
        query_text: str,
        filter_conditions: dict | None = None,
        limit: int = 20,
    ) -> list[SearchResult]:
        """Hybrid search combining dense vector and keyword search.

        Args:
            collection: Collection name (without prefix)
            query_vector: Query embedding
            query_text: Text for keyword search
            filter_conditions: Optional metadata filters
            limit: Max results

        Returns:
            List of SearchResult objects
        """
        client = get_pgvector_client()

        # Prefer dense search with server-side filters when filters are present;
        # hybrid fusion in the wrapper does not accept query_filter yet.
        if filter_conditions:
            raw = await client.search_async(
                collection=collection,
                query_vector=query_vector,
                query_filter=filter_conditions,
                limit=limit,
            )
            results = _as_result_list(raw)
        else:
            raw = await client.search_hybrid_async(
                collection=collection,
                query_vector=query_vector,
                query_text=query_text,
                limit=limit,
            )
            results = _as_result_list(raw)

        if filter_conditions:
            results = [
                r
                for r in results
                if _payload_matches(getattr(r, "payload", None) or {}, filter_conditions)
            ][:limit]

        # Log retrieval for RetrievalTuner
        try:
            retrieval_logger = get_retrieval_logger()
            retrieved = [{"id": str(r.id)} for r in results]
            await retrieval_logger.log_retrieval(
                collection=collection,
                query_vector=query_vector,
                query_text=query_text,
                retrieved_items=retrieved,
                retrieval_method="hybrid",
                filter_conditions=filter_conditions,
            )
        except Exception as e:
            logger.warning("Failed to log retrieval: %s", e)

        return results

    async def upsert(
        self,
        collection: str,
        points: list[dict],
    ) -> bool:
        """Insert or update vectors.

        Args:
            collection: Collection name (without prefix)
            points: List of points with id, vector, payload

        Returns:
            True if successful
        """
        client = get_pgvector_client()
        return await client.upsert_async(collection, points)

    async def delete(
        self,
        collection: str,
        point_ids: list[str],
    ) -> bool:
        """Delete vectors by ID.

        Args:
            collection: Collection name (without prefix)
            point_ids: List of point IDs to delete

        Returns:
            True if successful
        """
        client = get_pgvector_client()
        return await client.delete_async(collection, point_ids)

    async def count(
        self,
        collection: str,
        filter_conditions: dict | None = None,
    ) -> int:
        """Count vectors in a collection.

        Args:
            collection: Collection name (without prefix)
            filter_conditions: Optional metadata filters

        Returns:
            Count of matching vectors
        """
        client = get_pgvector_client()
        return await client.count_async(collection, filter_conditions)


# Singleton
_vector_client: SemanticVectorClient | None = None


def get_vector_client() -> SemanticVectorClient:
    """Get the singleton vector client."""
    global _vector_client
    if _vector_client is None:
        _vector_client = SemanticVectorClient()
    return _vector_client
