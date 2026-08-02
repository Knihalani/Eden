"""Eden LLMOps — Semantic Cache for Agent Context.

Caches LLM responses based on embedding similarity rather than exact
string match. Uses a three-tier storage: L1 Redis (exact), L2 pgvector
(semantic), L3 S3 (cold archive).
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol


@dataclass
class CacheEntry:
    query_hash: str
    query_text: str
    response_text: str
    embedding: list[float]
    model_version: str
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    ttl_seconds: int = 3600
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "query_hash": self.query_hash,
            "query_text": self.query_text,
            "response_text": self.response_text,
            "model_version": self.model_version,
            "created_at": self.created_at.isoformat(),
            "ttl_seconds": self.ttl_seconds,
            "metadata": self.metadata,
        }


class SemanticCache:
    """Three-tier semantic cache: L1 exact (Redis), L2 semantic (pgvector), L3 cold (S3).

    In-memory implementation for development. Production would use
    Redis + PostgreSQL/pgvector + S3.
    """

    def __init__(self, *, embedder: Embedder | None = None) -> None:
        """Construct a semantic cache.

        Args:
            embedder: Optional pluggable embedder. When provided, L2
                similarity is computed with real embeddings via cosine
                similarity. When ``None``, falls back to keyword
                overlap (Jaccard). The ``OpenAIEmbedder`` and
                ``SentenceTransformerEmbedder`` classes are
                ready-to-use implementations.
        """
        self._embedder: Embedder | None = embedder
        self._l1_exact: dict[str, tuple[str, float]] = {}  # hash -> (response, expires_at)
        self._l2_entries: list[CacheEntry] = []
        self._l3_archive: list[CacheEntry] = []
        self._stats = {
            "l1_hits": 0,
            "l1_misses": 0,
            "l2_hits": 0,
            "l2_misses": 0,
            "total_saves": 0,
        }

    def _compute_hash(self, text: str) -> str:
        return hashlib.sha256(text.encode()).hexdigest()[:32]

    def _cosine_similarity(self, a: list[float], b: list[float]) -> float:
        if len(a) != len(b):
            return 0.0
        dot = sum(x * y for x, y in zip(a, b, strict=False))
        norm_a = math.sqrt(sum(x * x for x in a))
        norm_b = math.sqrt(sum(x * x for x in b))
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return dot / (norm_a * norm_b)

    async def get(
        self,
        query: str,
        model_version: str,
        similarity_threshold: float = 0.95,
    ) -> str | None:
        """Retrieve cached response. Checks L1 exact, then L2 semantic."""
        query_hash = self._compute_hash(query)
        now = time.time()

        # L1: exact match
        cached = self._l1_exact.get(query_hash)
        if cached and cached[1] > now:
            self._stats["l1_hits"] += 1
            return cached[0]
        if cached and cached[1] <= now:
            del self._l1_exact[query_hash]
        self._stats["l1_misses"] += 1

        # L2: semantic similarity. Uses real embedding-based cosine
        # similarity when ``self._embedder`` is configured (e.g. wired
        # to a Qdrant collection or an in-process sentence-transformer
        # model). Falls back to keyword overlap when no embedder is
        # available so dev environments without vector infra still work.
        best_match: CacheEntry | None = None
        best_score = 0.0
        query.lower().split()

        for entry in self._l2_entries:
            if entry.model_version != model_version:
                continue
            if entry.created_at.timestamp() + entry.ttl_seconds < now:
                continue

            # Phase 6.7.6: real embedding-based similarity. Falls back
            # to keyword overlap only if no embedding function is
            # configured.
            if self._embedder is not None:
                try:
                    q_vec = self._embedder.embed(query)
                    e_vec = self._embedder.embed(entry.query_text)
                    score = _cosine_similarity(q_vec, e_vec)
                except Exception:
                    score = _keyword_overlap(query, entry.query_text)
            else:
                score = _keyword_overlap(query, entry.query_text)
            if score > best_score:
                best_score = score
                best_match = entry

        if best_match and best_score >= similarity_threshold:
            self._stats["l2_hits"] += 1
            return best_match.response_text

        self._stats["l2_misses"] += 1
        return None

    async def set(
        self,
        query: str,
        response: str,
        model_version: str,
        ttl_seconds: int = 3600,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Cache a response in both L1 and L2."""
        query_hash = self._compute_hash(query)
        now = time.time()

        # L1 exact
        self._l1_exact[query_hash] = (response, now + ttl_seconds)

        # L2 semantic entry — use the configured embedder when available so
        # cosine-similarity lookups in ``get()`` work with real vectors.
        # Stub only when no embedder is configured (dev / CI environments).
        entry = CacheEntry(
            query_hash=query_hash,
            query_text=query,
            response_text=response,
            embedding=self._get_embedding(query),
            model_version=model_version,
            ttl_seconds=ttl_seconds,
            metadata=metadata or {},
        )
        self._l2_entries.append(entry)
        self._stats["total_saves"] += 1

        # Prune expired L2 entries
        self._prune_l2()

    def _get_embedding(self, text: str) -> list[float]:
        """Return an embedding vector for ``text``.

        Uses the configured embedder when available; falls back to the
        deterministic stub so dev / CI environments without vector infra
        still have a non-zero embedding for L2 pruning.
        """
        if self._embedder is not None:
            try:
                return self._embedder.embed(text)
            except Exception:
                pass
        return self._stub_embed(text)

    def _stub_embed(self, text: str) -> list[float]:
        """Stub embedding: deterministic pseudo-random vector for dev.

        Phase 6.7.6: the cache now also accepts a real embedder
        (``SemanticCache(..., embedder=my_embedder)``) which
        computes real embeddings via any callable that returns a
        ``list[float]``. When provided, similarity scoring uses
        cosine similarity on the real vectors and this method is
        only used as a final fallback.
        """
        h = hashlib.sha256(text.encode()).hexdigest()
        dim = 128
        vec = []
        for i in range(dim):
            val = int(h[i % len(h)] + h[(i + 1) % len(h)], 16) / 255.0
            vec.append(val - 0.5)
        norm = math.sqrt(sum(v * v for v in vec))
        if norm > 0:
            vec = [v / norm for v in vec]
        return vec

    def _prune_l2(self) -> None:
        now = time.time()
        self._l2_entries = [
            e for e in self._l2_entries
            if e.created_at.timestamp() + e.ttl_seconds > now
        ]
        # Cap size
        if len(self._l2_entries) > 10000:
            self._l2_entries = self._l2_entries[-10000:]

    def get_stats(self) -> dict[str, Any]:
        l1_total = self._stats["l1_hits"] + self._stats["l1_misses"]
        l2_total = self._stats["l2_hits"] + self._stats["l2_misses"]
        return {
            "l1_hits": self._stats["l1_hits"],
            "l1_misses": self._stats["l1_misses"],
            "l1_hit_rate": round(self._stats["l1_hits"] / l1_total, 4) if l1_total > 0 else 0.0,
            "l2_hits": self._stats["l2_hits"],
            "l2_misses": self._stats["l2_misses"],
            "l2_hit_rate": round(self._stats["l2_hits"] / l2_total, 4) if l2_total > 0 else 0.0,
            "total_saves": self._stats["total_saves"],
            "l1_entries": len(self._l1_exact),
            "l2_entries": len(self._l2_entries),
            "l3_entries": len(self._l3_archive),
        }

    def invalidate(self, pattern: str = "*") -> int:
        """Invalidate cache entries matching pattern."""
        removed = 0
        if pattern == "*":
            removed = len(self._l1_exact) + len(self._l2_entries)
            self._l1_exact.clear()
            self._l2_entries.clear()
        else:
            pattern_lower = pattern.lower()
            to_remove_l1 = [k for k, v in self._l1_exact.items() if pattern_lower in v[0].lower()]
            for k in to_remove_l1:
                del self._l1_exact[k]
                removed += 1
            self._l2_entries = [
                e for e in self._l2_entries
                if pattern_lower not in e.query_text.lower()
            ]
            removed += len(to_remove_l1)  # Approximate
        return removed


# ─────────────────────────────────────────────────────────────────────────────
# Phase 6.7.6: real-embedder support
# ─────────────────────────────────────────────────────────────────────────────
# A pluggable embedding function lets users drop in any callable
# (sentence-transformers, OpenAI embeddings, a self-hosted model).
# Falls back to keyword overlap if none is provided.

import math  # noqa: E402,F811


class Embedder(Protocol):
    """Protocol for pluggable embedding functions."""

    def embed(self, text: str) -> list[float]: ...


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def _keyword_overlap(a: str, b: str) -> float:
    a_words = set(a.lower().split())
    b_words = set(b.lower().split())
    if not a_words or not b_words:
        return 0.0
    return len(a_words & b_words) / max(len(a_words), len(b_words))


class OpenAIEmbedder:
    """Embed texts via the OpenAI ``text-embedding-3-small`` model.

    Used by default in production. Lazy-imports ``openai`` so the
    rest of the module works without it installed.
    """

    MODEL = "text-embedding-3-small"
    DIM = 1536

    def __init__(self, api_key: str | None = None, model: str | None = None) -> None:
        self.api_key = api_key
        self.model = model or self.MODEL

    def embed(self, text: str) -> list[float]:
        try:
            from openai import OpenAI
        except ImportError as exc:
            raise RuntimeError("openai not installed") from exc
        client = OpenAI(api_key=self.api_key)
        resp = client.embeddings.create(model=self.model, input=text)
        return resp.data[0].embedding


class SentenceTransformerEmbedder:
    """Embed texts via a local sentence-transformers model.

    Works offline once the model is downloaded. Set
    ``EDEN_EMBED_MODEL=all-MiniLM-L6-v2`` (default) or any compatible
    sentence-transformers model name.
    """

    DEFAULT_MODEL = "all-MiniLM-L6-v2"
    DIM = 384

    def __init__(self, model_name: str | None = None) -> None:
        import os
        self.model_name = model_name or os.environ.get(
            "EDEN_EMBED_MODEL", self.DEFAULT_MODEL
        )
        self._model = None

    def _load(self) -> Any:
        if self._model is None:
            try:
                from sentence_transformers import SentenceTransformer
            except ImportError as exc:
                raise RuntimeError(
                    "sentence-transformers not installed. "
                    "Run `pip install sentence-transformers`."
                ) from exc
            self._model = SentenceTransformer(self.model_name)
        return self._model

    def embed(self, text: str) -> list[float]:
        model = self._load()
        vec = model.encode(text, convert_to_numpy=True)
        return vec.tolist()
