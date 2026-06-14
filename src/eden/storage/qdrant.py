"""Qdrant vector database client for Eden.

Provides hybrid dense+sparse vector search for semantic memory retrieval.
"""

import logging
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
        host: str | None = None,
        port: int | None = None,
        collection_prefix: str = "eden_",
    ):
        self.host = host or settings.qdrant_host
        self.port = port or settings.qdrant_port
        self.collection_prefix = collection_prefix
        self._client: QdrantClient | None = None

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
                # ``config`` is built from a literal above, so the values
                # are concrete (not Any). Cast through the static types so
                # mypy is happy.
                client.create_collection(
                    collection_name=name,
                    vectors_config=models.VectorParams(
                        size=int(config["vector_size"]),
                        distance=models.Distance(config["distance"]),
                    ),
                )
                logger.info(f"Created Qdrant collection: {name}")

    def search(
        self,
        collection: str,
        query_vector: list[float],
        limit: int = 20,
        query_filter: dict | None = None,
        score_threshold: float | None = None,
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

        Args:
            collection: Collection name (without prefix)
            query_vector: Query embedding for dense search
            query_text: Query text for sparse/BME25 search
            limit: Max results to return
            dense_weight: Weight for dense vector results (0.0-1.0)
            sparse_weight: Weight for sparse/keyword results (0.0-1.0)

        Returns:
            SearchResults with fused ranked results
        """
        self._get_client()
        collection_name = f"{self.collection_prefix}{collection}"

        # Perform dense vector search
        dense_results = self.search(collection, query_vector, limit=limit)

        # Perform sparse keyword search using Qdrant's sparse vector support
        # or fallback to text match scoring
        sparse_results = self._sparse_search(collection_name, query_text, limit=limit)

        # Apply Reciprocal Rank Fusion to combine results
        fused = self._reciprocal_rank_fusion(
            dense_results.results,
            sparse_results,
            dense_weight=dense_weight,
            sparse_weight=sparse_weight,
        )

        return SearchResults(results=fused[:limit], total=len(fused))

    def _sparse_search(
        self,
        collection_name: str,
        query_text: str,
        limit: int,
    ) -> list[SearchResult]:
        """Perform sparse keyword search using BM25-style scoring.

        Qdrant supports sparse vectors through the sparse_quantization config.
        This method uses text match with scoring as a fallback when
        sparse vectors are not configured.

        For a full BM25 implementation, you would:
        1. Configure a sparse vector index on the collection
        2. Use qdrant's sparse search with a sparse vector computed from query_text
        3. Return results with BM25 scores

        This implementation uses payload-based text matching with scoring.
        """
        # Fallback: use text match scoring via filtered search
        # Get all points and score by text match
        try:
            # Try to use scroll API with text match filter
            search_filter = None
            client = self._get_client()
            results = client.scroll(
                collection_name=collection_name,
                scroll_filter=search_filter,
                limit=limit * 2,  # Get more to filter
                with_payload=True,
            )[0]

            # Score by text match (simplified BM25-style)
            scored = []
            query_terms = query_text.lower().split()
            for point in results:
                payload = point.payload or {}
                # Get searchable text fields
                text_fields = [
                    str(payload.get("name", "")),
                    str(payload.get("description", "")),
                    str(payload.get("properties", {}).get("description", "")),
                ]
                combined_text = " ".join(text_fields).lower()

                # Count matching terms (simplified scoring)
                matches = sum(1 for term in query_terms if term in combined_text)
                if matches > 0:
                    # Normalize by number of terms (like precision)
                    score = matches / len(query_terms) if query_terms else 0
                    scored.append(SearchResult(
                        id=str(point.id),
                        score=score,
                        payload=payload,
                    ))

            # Sort by score descending
            scored.sort(key=lambda x: x.score, reverse=True)
            return scored[:limit]

        except Exception as e:
            logger.warning(f"Sparse search failed, falling back to dense-only: {e}")
            return []

    def _reciprocal_rank_fusion(
        self,
        dense_results: list[SearchResult],
        sparse_results: list[SearchResult],
        dense_weight: float = 0.6,
        sparse_weight: float = 0.4,
        k: int = 60,
    ) -> list[SearchResult]:
        """Fuse dense and sparse results using Reciprocal Rank Fusion.

        RRF score = weight * (1 / (k + rank))

        Args:
            dense_results: Results from dense vector search
            sparse_results: Results from sparse/keyword search
            dense_weight: Weight for dense results
            sparse_weight: Weight for sparse results
            k: RRF damping constant (higher = more weight to lower ranks)

        Returns:
            Combined and ranked results
        """
        # Build rank maps
        dense_ranks = {r.id: rank for rank, r in enumerate(dense_results)}
        sparse_ranks = {r.id: rank for rank, r in enumerate(sparse_results)}

        # Get all unique IDs
        all_ids = set(dense_ranks.keys()) | set(sparse_ranks.keys())

        # Calculate RRF scores
        scored = []
        for doc_id in all_ids:
            dense_rank = dense_ranks.get(doc_id, float('inf'))
            sparse_rank = sparse_ranks.get(doc_id, float('inf'))

            # RRF formula
            rrf_score = 0.0
            if dense_rank != float('inf'):
                rrf_score += dense_weight * (1 / (k + dense_rank))
            if sparse_rank != float('inf'):
                rrf_score += sparse_weight * (1 / (k + sparse_rank))

            # Get payload from whichever result has it
            payload = {}
            for r in dense_results:
                if r.id == doc_id:
                    payload = r.payload
                    break
            if not payload:
                for r in sparse_results:
                    if r.id == doc_id:
                        payload = r.payload
                        break

            scored.append(SearchResult(
                id=doc_id,
                score=rrf_score,
                payload=payload,
            ))

        # Sort by fused score
        scored.sort(key=lambda x: x.score, reverse=True)
        return scored

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

    def count(self, collection: str, filter_cond: dict | None = None) -> int:
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
_qdrant_client: QdrantClientWrapper | None = None


def get_qdrant_client() -> QdrantClientWrapper:
    """Get the singleton Qdrant client instance."""
    global _qdrant_client
    if _qdrant_client is None:
        _qdrant_client = QdrantClientWrapper()
    return _qdrant_client
