"""Qdrant vector database client for Eden.

Provides hybrid dense+sparse vector search for semantic memory retrieval.
"""

import logging
from typing import Optional
from dataclasses import dataclass

from qdrant_client import QdrantClient
from qdrant_client.http import models
from qdrant_client.http.exceptions import UnexpectedResponse

from eden.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


@dataclass
class SearchResult:
    """A single search result."""

    id: str
    score: float
    payload: dict


@dataclass
class SearchResults:
    """Collection of search results."""

    results: list[SearchResult]
    total: int


class QdrantClientWrapper:
    """Qdrant client wrapper for Eden's semantic memory.

    Provides:
    - Hybrid dense+sparse search
    - Metadata filtering
    - Collection management
    """

    def __init__(
        self,
        host: Optional[str] = None,
        port: Optional[int] = None,
        collection_prefix: str = "eden_",
    ):
        self.host = host or settings.qdrant_host
        self.port = port or settings.qdrant_port
        self.collection_prefix = collection_prefix
        self._client: Optional[QdrantClient] = None

    def _get_client(self) -> QdrantClient:
        """Get or create the Qdrant client."""
        if self._client is None:
            self._client = QdrantClient(
                host=self.host,
                port=self.port,
            )
        return self._client

    def initialize_collections(self) -> None:
        """Initialize Eden's collections if they don't exist."""
        client = self._get_client()

        collections_to_create = {
            f"{self.collection_prefix}semantic_memory": {
                "vector_size": 1536,
                "distance": models.Distance.COSINE,
            },
            f"{self.collection_prefix}skills": {
                "vector_size": 1536,
                "distance": models.Distance.COSINE,
            },
            f"{self.collection_prefix}exploits": {
                "vector_size": 1536,
                "distance": models.Distance.COSINE,
            },
        }

        existing = {c.name for c in client.get_collections().collections}
        for name, config in collections_to_create.items():
            if name not in existing:
                client.create_collection(
                    collection_name=name,
                    vectors_config=models.VectorParams(
                        size=config["vector_size"],
                        distance=config["distance"],
                    ),
                )
                logger.info(f"Created Qdrant collection: {name}")

    def search(
        self,
        collection: str,
        query_vector: list[float],
        limit: int = 20,
        query_filter: Optional[dict] = None,
        score_threshold: Optional[float] = None,
    ) -> SearchResults:
        """Search for similar vectors.

        Args:
            collection: Collection name (without prefix)
            query_vector: Query embedding
            limit: Max results to return
            query_filter: Metadata filter conditions
            score_threshold: Minimum score threshold

        Returns:
            SearchResults with matched points
        """
        client = self._get_client()
        collection_name = f"{self.collection_prefix}{collection}"

        filter_condition = None
        if query_filter:
            filter_condition = self._build_filter(query_filter)

        try:
            results = client.search(
                collection_name=collection_name,
                query_vector=query_vector,
                limit=limit,
                query_filter=filter_condition,
                score_threshold=score_threshold,
            )

            search_results = [
                SearchResult(
                    id=str(hit.id),
                    score=hit.score,
                    payload=hit.payload or {},
                )
                for hit in results
            ]

            return SearchResults(
                results=search_results,
                total=len(search_results),
            )
        except UnexpectedResponse as e:
            if e.status_code == 404:
                logger.warning(f"Collection not found: {collection_name}")
                return SearchResults(results=[], total=0)
            raise

    def search_hybrid(
        self,
        collection: str,
        query_vector: list[float],
        query_text: str,
        limit: int = 20,
        dense_weight: float = 0.6,
        sparse_weight: float = 0.4,
    ) -> SearchResults:
        """Hybrid search combining dense vector and keyword search.

        Uses Reciprocal Rank Fusion to combine results.
        """
        # For now, just use dense search
        # TODO: Implement sparse vector search with BM25
        return self.search(collection, query_vector, limit)

    def upsert(
        self,
        collection: str,
        points: list[dict],
    ) -> bool:
        """Insert or update points in a collection.

        Args:
            collection: Collection name (without prefix)
            points: List of points with id, vector, payload

        Returns:
            True if successful
        """
        client = self._get_client()
        collection_name = f"{self.collection_prefix}{collection}"

        qdrant_points = [
            models.PointStruct(
                id=p["id"],
                vector=p["vector"],
                payload=p.get("payload", {}),
            )
            for p in points
        ]

        client.upsert(collection_name=collection_name, points=qdrant_points)
        logger.debug(f"Upserted {len(points)} points to {collection_name}")
        return True

    def delete(self, collection: str, point_ids: list[str]) -> bool:
        """Delete points from a collection."""
        client = self._get_client()
        collection_name = f"{self.collection_prefix}{collection}"

        client.delete(
            collection_name=collection_name,
            points_selector=models.PointIdsList(points=point_ids),
        )
        return True

    def count(self, collection: str, filter_cond: Optional[dict] = None) -> int:
        """Count points in a collection."""
        client = self._get_client()
        collection_name = f"{self.collection_prefix}{collection}"

        filter_condition = self._build_filter(filter_cond) if filter_cond else None

        result = client.count(
            collection_name=collection_name,
            count_filter=filter_condition,
        )
        return result.count

    def _build_filter(self, filter_dict: dict) -> models.Filter:
        """Build a Qdrant filter from a dict."""
        must = []

        for key, value in filter_dict.items():
            if isinstance(value, dict):
                # Handle operators like $eq, $ne, $gt, etc.
                for op, op_value in value.items():
                    if op == "$eq":
                        must.append(models.FieldCondition(
                            key=key,
                            match=models.MatchValue(value=op_value),
                        ))
                    elif op == "$ne":
                        must.append(models.FieldCondition(
                            key=key,
                            match=models.MatchExcept(values=[op_value]),
                        ))
                    elif op == "$in":
                        must.append(models.FieldCondition(
                            key=key,
                            match=models.MatchAny(any=[op_value] if isinstance(op_value, str) else op_value),
                        ))
            else:
                must.append(models.FieldCondition(
                    key=key,
                    match=models.MatchValue(value=value),
                ))

        return models.Filter(must=must) if must else None


# Singleton instance
_qdrant_client: Optional[QdrantClientWrapper] = None


def get_qdrant_client() -> QdrantClientWrapper:
    """Get the singleton Qdrant client instance."""
    global _qdrant_client
    if _qdrant_client is None:
        _qdrant_client = QdrantClientWrapper()
    return _qdrant_client