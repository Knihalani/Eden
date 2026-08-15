"""pgvector semantic store for Eden (N4) — replaces Qdrant.

A single generic table ``vector_documents`` (migration 164) stores every
collection's points with free-form JSONB payloads — the same shape as
Qdrant points — so callers that built Qdrant points keep working
unchanged:

    (collection, point_id)  PRIMARY KEY
    org_id                  optional tenant tag
    embedding               vector(1536)
    payload                 JSONB

Design notes:

* **Native async** — all I/O is asyncpg; no ``asyncio.to_thread``
  bridges and no HTTP/gRPC hop to a sidecar (one less service to run,
  one less failure mode, no per-command billing).
* **HNSW ANN** — search uses ``embedding <=> query`` with the HNSW
  cosine index; ``score = 1 - distance`` so callers see the same
  cosine-similarity semantics as Qdrant.
* **Filters** — payload conditions are allowlisted JSONB-path clauses
  (safe keys only, values parameterized) mirroring the old Qdrant
  filter builder's security posture. ``$eq`` matches scalar equality or
  array membership (Qdrant ``MatchValue`` semantics); ``$in`` / ``$ne``
  match JSONB array containment.
* **Soft-fail** — like Qdrant before it, the wrapper is a soft
  dependency: transport/storage failures log and return ``unavailable``
  results instead of 500ing feature paths.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

#: Filter key allowlist: only safe identifier characters. Blocks spaced /
#: quoted / SQL-meta keys that would otherwise be smuggled into the
#: generated WHERE clause.
_SAFE_KEY = re.compile(r"^[A-Za-z0-9_.\-]+$")

#: Belt-and-braces: keys whose literal characters all pass the regex
#: but which are still semantically dangerous.
_DENIED_KEYS: frozenset[str] = frozenset(
    {
        "__proto__",
        "constructor",
        "prototype",
        "__defineGetter__",
        "__defineSetter__",
        "__lookupGetter__",
        "__lookupSetter__",
    }
)

#: Filter operator allowlist. Anything outside this set is dropped
#: silently (the search behaves as if the condition was never sent).
_ALLOWED_OPERATORS: frozenset[str] = frozenset({"$eq", "$ne", "$in"})

#: Postgres batching parity with the old Qdrant chunked upsert.
_UPSERT_BATCH_SIZE = 256
_TABLE = "vector_documents"

#: Embedding dimension the ``vector(1536)`` column enforces. Matching the
#: model Eden's embed paths all use (text-embedding-3-small). Anything
#: else fails at INSERT with an asyncpg ``vector size mismatch`` — so we
#: check up front and raise a clear, catchable error instead.
_EMBEDDING_DIM = 1536


class VectorDimensionError(ValueError):
    """Raised when an embedding does not match the ``vector(1536)`` column.

    Deliberately a ``ValueError`` subclass so callers can catch it
    explicitly; every other failure in this module soft-degrades, but a
    dimension mismatch is a programmer error that should be loud.
    """


def _require_dimension(vector: list[float], *, where: str) -> None:
    if len(vector) != _EMBEDDING_DIM:
        raise VectorDimensionError(
            f"embedding for {where} has {len(vector)} dims; "
            f"{_TABLE}.embedding is vector({_EMBEDDING_DIM})"
        )


@dataclass
class SearchResult:
    """A single search result."""

    id: str
    score: float
    payload: dict


@dataclass
class SearchResults:
    """Collection of search results.

    ``unavailable=True`` means the store soft-failed (transport / 5xx /
    Postgres down). Callers should treat that as a "search unavailable"
    banner, not an empty index.
    """

    results: list[SearchResult]
    total: int
    unavailable: bool = False


def _empty_unavailable(op: str, exc: BaseException) -> SearchResults:
    """Soft-degrade: log and return empty results instead of raising 500."""
    logger.warning("pgvector %s soft-failed (feature degrade): %s", op, exc)
    return SearchResults(results=[], total=0, unavailable=True)


async def _pg() -> Any | None:
    try:
        from eden.storage.postgres import get_postgres_client

        return await get_postgres_client()
    except Exception:
        return None


def _filter_clauses(
    filter_dict: dict | None,
    params: list[Any],
    start: int,
) -> tuple[list[str], int]:
    """Translate a Qdrant-style filter dict into SQL WHERE clauses.

    The JSONB path ``payload->'key'`` is safe because ``key`` is
    allowlisted (``_SAFE_KEY`` + ``_DENIED_KEYS``); values are always
    bound parameters. ``$eq`` on a payload array means "array contains
    the value" (Qdrant ``MatchValue`` semantics for list fields).
    """
    clauses: list[str] = []
    idx = start
    for key, value in (filter_dict or {}).items():
        if (
            not isinstance(key, str)
            or not _SAFE_KEY.match(key)
            or key in _DENIED_KEYS
        ):
            continue
        op: str | None = "$eq"
        op_value = value
        if isinstance(value, dict):
            op = next((o for o in _ALLOWED_OPERATORS if o in value), None)
            if op is None:
                continue
            op_value = value[op]
        if op == "$in":
            values = op_value if isinstance(op_value, list) else [op_value]
            clauses.append(f"payload->'{key}' ?| ${idx}::text[]")
            params.append([str(v) for v in values])
            idx += 1
        elif op == "$ne":
            values = op_value if isinstance(op_value, list) else [op_value]
            clauses.append(f"NOT (payload->'{key}' ?| ${idx}::text[])")
            params.append([str(v) for v in values])
            idx += 1
        else:
            # $eq: scalar equality OR array membership (list payloads).
            clauses.append(
                f"(payload->>'{key}' = ${idx} OR payload->'{key}' ? ${idx}::text)"
            )
            params.append(str(op_value))
            idx += 1
    return clauses, idx


class PgVectorClientWrapper:
    """pgvector-backed semantic store (N4) — Qdrant-compatible API."""

    async def search(
        self,
        collection: str,
        query_vector: list[float],
        limit: int = 20,
        query_filter: dict | None = None,
        score_threshold: float | None = None,
    ) -> SearchResults:
        """Search for similar vectors. Cosine similarity, HNSW index."""
        _require_dimension(query_vector, where=f"search({collection!r})")
        try:
            client = await _pg()
            if client is None:
                return SearchResults(results=[], total=0, unavailable=True)
            params: list[Any] = [query_vector, collection]
            where = ["collection = $2", "embedding IS NOT NULL"]
            clauses, idx = _filter_clauses(query_filter, params, 3)
            where.extend(clauses)
            if score_threshold is not None:
                params.append(float(score_threshold))
                where.append(f"1 - (embedding <=> $1) >= ${idx}")
                idx += 1
            params.append(int(limit))
            sql = (
                "SELECT point_id, payload, 1 - (embedding <=> $1) AS score "
                f"FROM {_TABLE} WHERE {' AND '.join(where)} "
                f"ORDER BY embedding <=> $1 LIMIT ${idx}"
            )
            rows = await client.fetch(sql, *params)
            results = [
                SearchResult(
                    id=str(r["point_id"]),
                    score=float(r["score"]),
                    payload=dict(r["payload"] or {}),
                )
                for r in rows
            ]
            return SearchResults(results=results, total=len(results))
        except Exception as exc:
            return _empty_unavailable("search", exc)

    async def search_async(self, *args: Any, **kwargs: Any) -> SearchResults:
        """Async alias — the pgvector store is natively async."""
        return await self.search(*args, **kwargs)

    async def search_hybrid(
        self,
        collection: str,
        query_vector: list[float],
        query_text: str,
        limit: int = 20,
        dense_weight: float = 0.6,
        sparse_weight: float = 0.4,
    ) -> SearchResults:
        """Dense + keyword hybrid via Reciprocal Rank Fusion.

        No callers today (the old Qdrant hybrid was unused); implemented
        so the API surface survives: dense HNSW search fused with a
        payload-text ILIKE pass over the query terms.
        """
        dense = await self.search(collection, query_vector, limit=limit)
        if dense.unavailable:
            return dense
        dense_ranks = {r.id: rank for rank, r in enumerate(dense.results)}
        try:
            client = await _pg()
            terms = [t for t in query_text.lower().split() if t]
            keyword: list[SearchResult] = []
            if client is not None and terms:
                # Score rows whose payload text mentions any query term.
                like = " OR ".join(
                    [f"payload::text ILIKE ${i}" for i in range(3, 3 + len(terms))]
                )
                params: list[Any] = [collection, *terms]
                rows = await client.fetch(
                    f"SELECT point_id, payload FROM {_TABLE} "
                    "WHERE collection = $1 AND embedding IS NOT NULL "
                    f"AND ({like}) ORDER BY point_id LIMIT $2",
                    *params,
                    int(limit),
                )
                for r in rows:
                    text = json.dumps(r["payload"]).lower()
                    matches = sum(1 for t in terms if t in text)
                    if matches:
                        keyword.append(
                            SearchResult(
                                id=str(r["point_id"]),
                                score=matches / len(terms),
                                payload=dict(r["payload"] or {}),
                            )
                        )
        except Exception as exc:
            logger.debug("pgvector hybrid keyword pass skipped: %s", exc)
            keyword = []
        keyword_ranks = {r.id: rank for rank, r in enumerate(keyword)}

        fused: list[SearchResult] = []
        for doc_id in set(dense_ranks) | set(keyword_ranks):
            k = 60
            score = 0.0
            if doc_id in dense_ranks:
                score += dense_weight * (1 / (k + dense_ranks[doc_id]))
            if doc_id in keyword_ranks:
                score += sparse_weight * (1 / (k + keyword_ranks[doc_id]))
            payload: dict = {}
            for r in dense.results:
                if r.id == doc_id:
                    payload = r.payload
                    break
            fused.append(SearchResult(id=doc_id, score=score, payload=payload))
        fused.sort(key=lambda x: x.score, reverse=True)
        return SearchResults(results=fused[:limit], total=len(fused))

    async def search_hybrid_async(self, *args: Any, **kwargs: Any) -> SearchResults:
        return await self.search_hybrid(*args, **kwargs)

    async def upsert(
        self,
        collection: str,
        points: list[dict],
    ) -> bool:
        """Insert or update points (ON CONFLICT on (collection, point_id))."""
        if not points:
            return True
        for i, p in enumerate(points):
            _require_dimension(p["vector"], where=f"upsert({collection!r})[{i}]")
        try:
            client = await _pg()
            if client is None:
                return False
            sql = (
                f"INSERT INTO {_TABLE} "
                "(collection, point_id, org_id, embedding, payload) "
                "VALUES ($1, $2, $3, $4, $5::jsonb) "
                "ON CONFLICT (collection, point_id) DO UPDATE SET "
                "embedding = EXCLUDED.embedding, "
                "payload = EXCLUDED.payload, "
                "created_at = NOW()"
            )
            for i in range(0, len(points), _UPSERT_BATCH_SIZE):
                chunk = points[i : i + _UPSERT_BATCH_SIZE]
                args = [
                    (
                        collection,
                        str(p["id"]),
                        p.get("org_id"),
                        p["vector"],
                        json.dumps(p.get("payload", {}), default=str),
                    )
                    for p in chunk
                ]
                await client.executemany(sql, args)
            logger.debug("pgvector upserted %s points to %r", len(points), collection)
            return True
        except Exception as exc:
            logger.warning("pgvector upsert soft-failed (feature degrade): %s", exc)
            return False

    async def upsert_async(self, *args: Any, **kwargs: Any) -> bool:
        return await self.upsert(*args, **kwargs)

    async def delete(
        self,
        collection: str,
        point_ids: list[str],
    ) -> bool:
        """Delete points by id within a collection."""
        if not point_ids:
            return True
        try:
            client = await _pg()
            if client is None:
                return False
            await client.execute(
                f"DELETE FROM {_TABLE} "
                "WHERE collection = $1 AND point_id = ANY($2::text[])",
                collection,
                [str(p) for p in point_ids],
            )
            return True
        except Exception as exc:
            logger.warning("pgvector delete soft-failed (feature degrade): %s", exc)
            return False

    async def delete_async(self, *args: Any, **kwargs: Any) -> bool:
        return await self.delete(*args, **kwargs)

    async def count(
        self,
        collection: str,
        filter_cond: dict | None = None,
    ) -> int:
        """Count points in a collection (with optional filter)."""
        try:
            client = await _pg()
            if client is None:
                return 0
            params: list[Any] = [collection]
            where = ["collection = $1"]
            clauses, idx = _filter_clauses(filter_cond, params, 2)
            where.extend(clauses)
            row = await client.fetchrow(
                f"SELECT COUNT(*) AS n FROM {_TABLE} "
                f"WHERE {' AND '.join(where)}",
                *params,
            )
            return int(row["n"]) if row else 0
        except Exception as exc:
            logger.warning("pgvector count soft-failed (feature degrade): %s", exc)
            return 0

    async def count_async(self, *args: Any, **kwargs: Any) -> int:
        return await self.count(*args, **kwargs)

    async def scroll_all(
        self,
        collection: str,
        *,
        limit: int = 256,
        with_vectors: bool = False,
        with_payload: bool = True,
    ) -> list[dict]:
        """Scroll every point in a collection (offset pagination)."""
        out: list[dict] = []
        offset = 0
        try:
            client = await _pg()
            if client is None:
                return []
            cols = "point_id" + (", embedding" if with_vectors else "")
            if with_payload:
                cols += ", payload"
            while True:
                rows = await client.fetch(
                    f"SELECT {cols} FROM {_TABLE} "
                    "WHERE collection = $1 ORDER BY point_id LIMIT $2 OFFSET $3",
                    collection,
                    int(limit),
                    offset,
                )
                if not rows:
                    break
                for r in rows:
                    point: dict[str, Any] = {
                        "id": str(r["point_id"]),
                        "vector": r.get("embedding") if with_vectors else None,
                        "payload": dict(r.get("payload") or {}) if with_payload else {},
                    }
                    out.append(point)
                if len(rows) < limit:
                    break
                offset += len(rows)
            return out
        except Exception as exc:
            logger.warning("pgvector scroll_all soft-failed (feature degrade): %s", exc)
            return []

    async def scroll_all_async(self, *args: Any, **kwargs: Any) -> list[dict]:
        return await self.scroll_all(*args, **kwargs)

    async def initialize_collections_async(self, *args: Any, **kwargs: Any) -> None:
        """No-op — the table + HNSW index come from migration 164."""


# Singleton
_pgvector_client: PgVectorClientWrapper | None = None


def get_pgvector_client() -> PgVectorClientWrapper:
    """Get the singleton pgvector client instance."""
    global _pgvector_client
    if _pgvector_client is None:
        _pgvector_client = PgVectorClientWrapper()
    return _pgvector_client
