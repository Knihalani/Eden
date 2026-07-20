"""Qdrant vector database client for Eden.

Provides hybrid dense+sparse vector search for semantic memory retrieval.
"""

import asyncio
import logging
import re
from dataclasses import dataclass
from typing import Any

from qdrant_client import QdrantClient
from qdrant_client.http import models
from qdrant_client.http.exceptions import UnexpectedResponse

from eden.config import get_settings  # noqa: F401  # used by _get_settings()

logger = logging.getLogger(__name__)

# Filter key allowlist: only safe identifier characters. This blocks
# spaced / quoted / SQL-meta keys that would otherwise be smuggled
# into the Qdrant filter builder.
_SAFE_KEY = re.compile(r"^[A-Za-z0-9_.\-]+$")

# Belt-and-braces: keys whose literal characters all pass the regex
# but which are still semantically dangerous (prototype-pollution
# classics, JS reserved words that Qdrant might honour).
_DENIED_KEYS: frozenset[str] = frozenset(
    {"__proto__", "constructor", "prototype", "__defineGetter__",
     "__defineSetter__", "__lookupGetter__", "__lookupSetter__"}
)

# Filter operator allowlist. Anything outside this set is dropped
# silently (the search behaves as if the condition was never sent).
_ALLOWED_OPERATORS: frozenset[str] = frozenset({"$eq", "$ne", "$in"})
settings = None

def _get_settings():
    global settings
    if settings is None:
        from eden.config import get_settings as _gs
        settings = _gs()
    return settings



@dataclass
class SearchResult:
    """A single search result."""

    id: str
    score: float
    payload: dict


@dataclass
class SearchResults:
    """Collection of search results.

    ``unavailable=True`` means Qdrant soft-failed (transport / 5xx).
    Callers should treat that as a "search unavailable" banner, not an
    empty index — aligned with Wave 1.3 soft-dep + Typesense fallback.
    """

    results: list[SearchResult]
    total: int
    unavailable: bool = False


def _empty_unavailable(op: str, exc: BaseException) -> SearchResults:
    """Soft-degrade: log and return empty results instead of raising 500."""
    logger.warning("Qdrant %s soft-failed (feature degrade): %s", op, exc)
    return SearchResults(results=[], total=0, unavailable=True)


def resolve_qdrant_client_kwargs(
    *,
    host: str,
    port: int,
    https: bool,
    api_key: str = "",
) -> dict[str, Any]:
    """Resolve QdrantClient constructor kwargs from settings-like inputs.

    Prod Errno 99 root cause (July 2026): when ``QDRANT_HTTPS`` was unset
    **or** ``QDRANT_API_KEY`` was empty, the old client path used plain
    ``host=``/``port=`` (HTTP) against Qdrant Cloud. That surfaces as
    ``[Errno 99] Cannot assign requested address``. HTTPS must not be
    gated on the API key; Cloud hostnames auto-upgrade to HTTPS when the
    flag is missing.
    """
    host = (host or "").strip()
    key = (api_key or "").strip()
    use_https = bool(https)
    if not use_https and host.endswith(".cloud.qdrant.io"):
        use_https = True
        logger.warning(
            "QDRANT_HTTPS unset/false but host %r looks like Qdrant Cloud; "
            "forcing HTTPS url= construction to avoid Errno 99",
            host,
        )
    if use_https:
        kwargs: dict[str, Any] = {"url": f"https://{host}:{port}"}
        if key:
            kwargs["api_key"] = key
        else:
            logger.warning(
                "Qdrant HTTPS enabled but QDRANT_API_KEY is empty — "
                "Cloud clusters will reject unauthenticated requests"
            )
        return kwargs
    kwargs = {"host": host, "port": port}
    if key:
        kwargs["api_key"] = key
    return kwargs


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
        self.host = host or _get_settings().qdrant_host
        self.port = port or _get_settings().qdrant_port
        self.collection_prefix = collection_prefix
        self._client: QdrantClient | None = None

    def _get_client(self) -> QdrantClient:
        """Get or create the Qdrant client.

        For Qdrant Cloud (or any TLS-terminated upstream) we build a
        full ``url=`` rather than host/port. Some qdrant-client versions
        pick the wrong scheme (http://) when given just host/port even
        with ``https=True``, which surfaces as ``[Errno 99] Cannot assign
        requested address`` on the cloud cluster because the gateway
        redirects to HTTPS on a different port. Using ``url=https://...``
        avoids that and matches the qdrant-client docs' Cloud recipe.

        ``QDRANT_HTTPS`` alone selects the HTTPS url path — the API key
        is optional at construction time (warned if missing) so a missing
        secret no longer silently falls back to plain HTTP.
        """
        if self._client is None:
            settings = _get_settings()
            kwargs = resolve_qdrant_client_kwargs(
                host=self.host,
                port=self.port,
                https=bool(settings.qdrant_https),
                api_key=settings.qdrant_api_key or "",
            )
            self._client = QdrantClient(**kwargs)
        return self._client

    def initialize_collections(self) -> None:
        """Initialize Eden's collections if they don't exist.

        All 3 collections ship with scalar int8 quantization and
        on-disk payload mmap (Phase B6 — June 2026). Quantization
        reduces RAM by ~4× (1536-dim float32 → int8) with <1% recall
        loss on MTEB benchmarks; on-disk payload mmap keeps the
        index in RAM while pushing the (usually large) payload to
        disk. For existing collections, run
        ``scripts/qdrant_enable_quantization.py`` to reindex.

        Soft on transport failure: Qdrant is a soft dep (Wave 1.3 /
        8.5). Raising here would turn startup / admin paths into 500s
        while Postgres is healthy; ``/health`` still sees Errno 99 via
        direct ``get_collections`` probes.
        """
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

        try:
            client = self._get_client()
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
                            on_disk=True,
                        ),
                        quantization_config=models.ScalarQuantization(
                            scalar=models.ScalarQuantizationConfig(
                                type=models.ScalarType.INT8,
                                quantile=0.99,
                                always_ram=True,
                            ),
                        ),
                        on_disk_payload=True,
                    )
                    logger.info(f"Created Qdrant collection: {name}")
        except Exception as e:
            logger.warning(
                "Qdrant initialize_collections soft-failed (feature degrade): %s",
                e,
            )

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
            SearchResults with matched points. On soft-dep failure
            (Errno 99, timeout, upstream 5xx) returns empty results
            with ``unavailable=True`` instead of raising — feature
            paths show a banner; ``/health`` still reports degraded.
        """
        collection_name = f"{self.collection_prefix}{collection}"

        filter_condition = None
        if query_filter:
            filter_condition = self._build_filter(query_filter)

        try:
            client = self._get_client()
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
            return _empty_unavailable("search", e)
        except Exception as e:
            return _empty_unavailable("search", e)

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
            SearchResults with fused ranked results. Propagates
            ``unavailable`` when dense search soft-failed.
        """
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

        return SearchResults(
            results=fused[:limit],
            total=len(fused),
            unavailable=bool(dense_results.unavailable),
        )

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

    # Qdrant's recommended per-call batch size. Larger batches time
    # out the request on big payloads (10-50 KB each); 256 is the
    # safe middle-ground that fits the Eden payload shapes.
    _UPSERT_BATCH_SIZE = 256

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
            True if successful, False on soft-dep failure (do not 500).

        v1.8 (storage-optimisation pass): chunks the call to
        ``_UPSERT_BATCH_SIZE`` so a 10K-point batch doesn't time
        out the Qdrant request. Each chunk is its own HTTP call;
        a failure in chunk N aborts the remaining chunks (the
        caller can retry the whole batch — Qdrant's upsert is
        idempotent on the same point id).
        """
        if not points:
            return True
        collection_name = f"{self.collection_prefix}{collection}"
        try:
            client = self._get_client()
            for i in range(0, len(points), self._UPSERT_BATCH_SIZE):
                chunk = points[i : i + self._UPSERT_BATCH_SIZE]
                qdrant_points = [
                    models.PointStruct(
                        id=p["id"],
                        vector=p["vector"],
                        payload=p.get("payload", {}),
                    )
                    for p in chunk
                ]
                client.upsert(collection_name=collection_name, points=qdrant_points)
            logger.debug(f"Upserted {len(points)} points to {collection_name}")
            return True
        except Exception as e:
            logger.warning("Qdrant upsert soft-failed (feature degrade): %s", e)
            return False

    def scroll_all(
        self,
        collection: str,
        *,
        limit: int = 256,
        with_vectors: bool = False,
        with_payload: bool = True,
    ) -> list[dict]:
        """Scroll every point in a collection.

        Returns a list of point dicts (id, vector?, payload?). Uses
        Qdrant's server-side cursor (``offset`` parameter) so a
        10M-point collection scrolls without loading the whole
        result set into memory.

        Mirrors the ``tests/unit/storage/test_qdrant_quantization.py::
        TestScrollAll`` shape so callers can rely on a uniform API
        across the SDK. Soft-dep failure returns ``[]``.
        """
        collection_name = f"{self.collection_prefix}{collection}"
        out: list[dict] = []
        offset: Any = None
        try:
            client = self._get_client()
            while True:
                points, next_offset = client.scroll(
                    collection_name=collection_name,
                    limit=limit,
                    offset=offset,
                    with_vectors=with_vectors,
                    with_payload=with_payload,
                )
                for p in points:
                    out.append({
                        "id": str(p.id),
                        "vector": getattr(p, "vector", None) if with_vectors else None,
                        "payload": p.payload or {},
                    })
                if next_offset is None or not points:
                    break
                offset = next_offset
            return out
        except Exception as e:
            logger.warning("Qdrant scroll_all soft-failed (feature degrade): %s", e)
            return []

    def delete(self, collection: str, point_ids: list[str]) -> bool:
        """Delete points from a collection.

        Returns False on soft-dep failure instead of raising.
        """
        collection_name = f"{self.collection_prefix}{collection}"
        try:
            client = self._get_client()
            client.delete(
                collection_name=collection_name,
                points_selector=models.PointIdsList(points=point_ids),
            )
            return True
        except Exception as e:
            logger.warning("Qdrant delete soft-failed (feature degrade): %s", e)
            return False

    def count(self, collection: str, filter_cond: dict | None = None) -> int:
        """Count points in a collection.

        Returns 0 on soft-dep failure instead of raising.
        """
        collection_name = f"{self.collection_prefix}{collection}"
        try:
            client = self._get_client()
            filter_condition = self._build_filter(filter_cond) if filter_cond else None
            result = client.count(
                collection_name=collection_name,
                count_filter=filter_condition,
            )
            return result.count
        except Exception as e:
            logger.warning("Qdrant count soft-failed (feature degrade): %s", e)
            return 0

    def _build_filter(self, filter_dict: dict) -> models.Filter:
        """Build a Qdrant filter from a dict.

        Security: the field ``key`` and the operator ``$xx`` are both
        allowlisted before being passed to Qdrant. This stops a caller
        from smuggling in a meta-field (e.g. ``__proto__``) or an
        unknown operator that would alter the filter's logic. The
        value is left untouched — Qdrant's typed matchers handle
        coercion, and a wrong type is rejected at the Qdrant layer
        (a useful side-effect: the query fails closed).
        """
        must = []

        for key, value in filter_dict.items():
            # Key allowlist: only alphanumerics, dot, underscore, hyphen.
            # Anything else (including __proto__, constructor, prototype)
            # is dropped silently — the search behaves as if the
            # caller didn't pass that condition.
            if (
                not isinstance(key, str)
                or not _SAFE_KEY.match(key)
                or key in _DENIED_KEYS
            ):
                continue
            if isinstance(value, dict):
                # Handle operators like $eq, $ne, $in, etc.
                for op, op_value in value.items():
                    if op not in _ALLOWED_OPERATORS:
                        continue
                    if op == "$eq":
                        must.append(models.FieldCondition(
                            key=key,
                            match=models.MatchValue(value=op_value),
                        ))
                    elif op == "$ne":
                        # $ne only makes sense for a finite set; if
                        # the caller passes a list, take it.
                        ne_values = (
                            op_value if isinstance(op_value, list) else [op_value]
                        )
                        # Preserve the pre-existing kwarg name
                        # (``values``) that worked before this audit.
                        # qdrant-client's pydantic schema has renamed
                        # the field across versions; the original
                        # ``values=`` was the kwarg in use.
                        must.append(models.FieldCondition(
                            key=key,
                            match=models.MatchExcept(values=ne_values),
                        ))
                    elif op == "$in":
                        in_values = (
                            [op_value] if isinstance(op_value, str) else op_value
                        )
                        must.append(models.FieldCondition(
                            key=key,
                            match=models.MatchAny(any=in_values),
                        ))
            else:
                must.append(models.FieldCondition(
                    key=key,
                    match=models.MatchValue(value=value),
                ))

        return models.Filter(must=must) if must else None

    # ── Async wrappers (Wave-1 A4 / K17) ──────────────────────────────
    # Sync qdrant-client calls block the event loop; route them via
    # ``asyncio.to_thread`` so async callers (vector_client) stay non-blocking.

    async def search_async(self, *args, **kwargs):
        return await asyncio.to_thread(self.search, *args, **kwargs)

    async def search_hybrid_async(self, *args, **kwargs):
        return await asyncio.to_thread(self.search_hybrid, *args, **kwargs)

    async def upsert_async(self, *args, **kwargs):
        return await asyncio.to_thread(self.upsert, *args, **kwargs)

    async def delete_async(self, *args, **kwargs):
        return await asyncio.to_thread(self.delete, *args, **kwargs)

    async def count_async(self, *args, **kwargs):
        return await asyncio.to_thread(self.count, *args, **kwargs)

    async def scroll_all_async(self, *args, **kwargs):
        return await asyncio.to_thread(self.scroll_all, *args, **kwargs)

    async def initialize_collections_async(self, *args, **kwargs):
        return await asyncio.to_thread(self.initialize_collections, *args, **kwargs)


# Singleton instance
_qdrant_client: QdrantClientWrapper | None = None


def get_qdrant_client() -> QdrantClientWrapper:
    """Get the singleton Qdrant client instance."""
    global _qdrant_client
    if _qdrant_client is None:
        _qdrant_client = QdrantClientWrapper()
    return _qdrant_client
