"""Semantic memory - vector search client.

Handles embedding-based retrieval using Qdrant.
"""

import logging

from eden.kb.retrieval_logger import get_retrieval_logger
from eden.storage.qdrant import SearchResult, get_qdrant_client

logger = logging.getLogger(__name__)


class SemanticVectorClient:
    """Client for semantic vector search operations.

    Uses Qdrant for hybrid dense+sparse search.
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
        client = get_qdrant_client()

        results = client.search(
            collection=collection,
            query_vector=query_vector,
            query_filter=filter_conditions,
            limit=limit,
            score_threshold=score_threshold,
        )

        # Log retrieval for RetrievalTuner
        try:
            logger = get_retrieval_logger()
            retrieved = [{"id": str(r.id)} for r in results]
            await logger.log_retrieval(
                collection=collection,
                query_vector=query_vector,
                retrieved_items=retrieved,
                retrieval_method="vector",
                filter_conditions=filter_conditions,
                score_threshold=score_threshold,
            )
        except Exception as e:
            logger.warning(f"Failed to log retrieval: {e}")

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
        client = get_qdrant_client()

        results = client.search_hybrid(
            collection=collection,
            query_vector=query_vector,
            query_text=query_text,
            limit=limit,
        )

        # Log retrieval for RetrievalTuner
        try:
            logger = get_retrieval_logger()
            retrieved = [{"id": str(r.id)} for r in results]
            await logger.log_retrieval(
                collection=collection,
                query_vector=query_vector,
                query_text=query_text,
                retrieved_items=retrieved,
                retrieval_method="hybrid",
                filter_conditions=filter_conditions,
            )
        except Exception as e:
            logger.warning(f"Failed to log retrieval: {e}")

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
        client = get_qdrant_client()
        return client.upsert(collection, points)

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
        client = get_qdrant_client()
        return client.delete(collection, point_ids)

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
        client = get_qdrant_client()
        return client.count(collection, filter_conditions)


# Singleton
_vector_client: SemanticVectorClient | None = None


def get_vector_client() -> SemanticVectorClient:
    """Get the singleton vector client."""
    global _vector_client
    if _vector_client is None:
        _vector_client = SemanticVectorClient()
    return _vector_client
