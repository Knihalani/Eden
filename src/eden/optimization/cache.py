"""Multi-layer caching for LLM responses.

L1: Exact-match cache (Redis) — SHA256 key on normalized prompt+model+temp
L2: Semantic cache (Qdrant) — embedding similarity search
"""

import hashlib
import json
import logging
import time
from datetime import UTC

from eden.llm.client import LLMResponse
from eden.storage.redis import get_redis_client
from eden.util.stable_hash import stable_seed


def _get_qdrant_client():
    """Lazy import to avoid pulling the Qdrant client (grpc + numpy)
    into every optimization cache import. Audit 2026-07-06."""
    from eden.storage.qdrant import get_qdrant_client
    return get_qdrant_client

logger = logging.getLogger(__name__)

# Default similarity threshold for semantic cache
DEFAULT_SEMANTIC_THRESHOLD = 0.95
# Fallback when ``settings.semantic_cache_embed_model`` is unavailable.
_DEFAULT_EMBED_MODEL = "openai/text-embedding-3-small"


class ExactMatchCache:
    """L1 exact-match cache backed by Redis.

    Key: SHA256 of normalized prompt + model + temperature + max_tokens
    Value: Cached response (JSON-serialized LLMResponse)
    """

    def __init__(self, ttl_seconds: int = 3600, prefix: str = "eden:cache:exact"):
        self.ttl = ttl_seconds
        self.prefix = prefix
        self._hits = 0
        self._misses = 0

    def _normalize(self, prompt: str) -> str:
        """Normalize prompt for consistent hashing."""
        # Collapse whitespace, strip, lowercase
        normalized = " ".join(prompt.split())
        return normalized.strip().lower()

    def _make_key(
        self,
        prompt: str,
        model: str,
        temperature: float,
        max_tokens: int,
        system_prompt: str | None = None,
    ) -> str:
        """Create deterministic cache key."""
        normalized = self._normalize(prompt)
        # Include system prompt in hash if present
        content = f"{normalized}:{model}:{temperature}:{max_tokens}"
        if system_prompt:
            content += f":{self._normalize(system_prompt)}"
        content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
        return f"{self.prefix}:{content_hash}"

    async def get(
        self,
        prompt: str,
        model: str,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        system_prompt: str | None = None,
        *,
        tenant_id: str | None = None,
        trace_id: str | None = None,
    ) -> LLMResponse | None:
        """Try to get a cached response.

        When ``settings.optimization_cache_emit_metrics`` is True and
        a hit is found, emits a ``cache.hit`` telemetry event so the
        portal can show the cache's contribution to latency. Emission
        is best-effort (telemetry must never break a cache call).
        """
        key = self._make_key(prompt, model, temperature, max_tokens, system_prompt)
        client = await get_redis_client()
        if client is None:
            self._misses += 1
            return None

        t0 = time.monotonic()
        try:
            raw = await client.get(key)
            if raw is None:
                self._misses += 1
                return None

            data = json.loads(raw)
            from eden.llm.client import UsageStats

            response = LLMResponse(
                content=data["content"],
                usage=UsageStats(**data["usage"]),
                model=data["model"],
                finish_reason=data.get("finish_reason", "unknown"),
            )
            self._hits += 1
            latency_ms = (time.monotonic() - t0) * 1000.0
            # In-process counters only — avoid a Redis INCR on every hit
            # (that doubled Upstash command volume on the cache hot path).
            # Phase 7.1a.4 — emit cache-hit telemetry so the cache's
            # contribution to overall latency is visible. Best-effort.
            await _maybe_emit_cache_hit(
                tenant_id=tenant_id,
                trace_id=trace_id,
                model=model,
                tier="L1",
                latency_ms=latency_ms,
                cache_key=key,
            )
            return response
        except Exception as e:
            logger.warning(f"Exact cache read error: {e}")
            self._misses += 1
            return None

    async def set(
        self,
        prompt: str,
        model: str,
        response: LLMResponse,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        system_prompt: str | None = None,
        ttl: int | None = None,
    ) -> bool:
        """Cache a response."""
        key = self._make_key(prompt, model, temperature, max_tokens, system_prompt)
        client = await get_redis_client()
        if client is None:
            return False

        try:
            data = {
                "content": response.content,
                "usage": {
                    "prompt_tokens": response.usage.prompt_tokens,
                    "completion_tokens": response.usage.completion_tokens,
                    "total_tokens": response.usage.total_tokens,
                    "cost": response.usage.cost,
                    "cache_reads": response.usage.cache_reads,
                    "cache_writes": response.usage.cache_writes,
                },
                "model": response.model,
                "finish_reason": response.finish_reason,
            }
            await client.setex(key, ttl or self.ttl, json.dumps(data))
            return True
        except Exception as e:
            logger.warning(f"Exact cache write error: {e}")
            return False

    async def invalidate(self, pattern: str = "*") -> int:
        """Invalidate cache entries matching a pattern.

        Uses SCAN (not KEYS) so invalidation does not block Redis or
        burn Upstash quota on a full keyspace walk.
        """
        client = await get_redis_client()
        if client is None:
            return 0
        try:
            deleted = 0
            match = f"{self.prefix}:{pattern}"
            batch: list[str] = []
            async for key in client.scan_iter(match=match, count=200):
                batch.append(key.decode() if isinstance(key, bytes) else str(key))
                if len(batch) >= 200:
                    deleted += int(await client.delete(*batch))
                    batch.clear()
            if batch:
                deleted += int(await client.delete(*batch))
            return deleted
        except Exception as e:
            logger.warning(f"Cache invalidation error: {e}")
        return 0

    def get_stats(self) -> dict:
        """Return cache statistics."""
        total = self._hits + self._misses
        return {
            "hits": self._hits,
            "misses": self._misses,
            "hit_rate": round(self._hits / total, 4) if total else 0.0,
            "ttl_seconds": self.ttl,
        }


# ─────────────────────────────────────────────────────────────────────────────
# Phase 7.1a.4 — Cache-hit observability
# ─────────────────────────────────────────────────────────────────────────────

async def _maybe_emit_cache_hit(
    *,
    tenant_id: str | None,
    trace_id: str | None,
    model: str,
    tier: str,
    latency_ms: float,
    cache_key: str,
) -> None:
    """Emit a ``cache.hit`` telemetry event for a cache hit. Best-effort.

    Gated on ``settings.optimization_cache_emit_metrics`` (default on).
    Silently no-ops if the collector is unreachable or any error occurs
    — telemetry must never break a cache call.
    """
    try:
        from eden.config import get_settings

        settings = get_settings()
        if not getattr(settings, "optimization_cache_emit_metrics", True):
            return
    except Exception:
        return

    try:
        from eden.observability.telemetry_collector import get_telemetry_collector
        collector = await get_telemetry_collector()
        # Use the existing record_cache_lookup path — it writes to the
        # same `cache_lookups` table and surfaces tier + hit breakdowns
        # in the heatmap / timeline views.
        await collector.record_cache_lookup(
            tenant_id=tenant_id or "default",
            trace_id=trace_id or f"cache_hit:{cache_key[:16]}",
            tier=tier,
            hit=True,
            latency_ms=latency_ms,
            cache_key=cache_key,
        )
    except Exception as exc:
        logger.debug("cache-hit telemetry emit failed: %s", exc)


class SemanticCache:
    """L2 semantic cache backed by Qdrant vector search.

    Stores prompt embeddings with their responses.
    Queries use cosine similarity to find near-matches.
    """

    COLLECTION = "eden_semantic_cache"
    VECTOR_SIZE = 1536
    # COST: bound on the normalized-prompt -> embedding memo. Small on
    # purpose; its job is to collapse the get/set pair of a single
    # request, not to be a second cache tier.
    EMBED_MEMO_MAX = 256

    def __init__(self, similarity_threshold: float = DEFAULT_SEMANTIC_THRESHOLD):
        self.threshold = similarity_threshold
        self._hits = 0
        self._misses = 0
        self._embed_client: object | None = None
        self._embed_memo: dict[str, list[float]] = {}
        self._embed_calls = 0

    @staticmethod
    def _enabled() -> bool:
        """Kill switch for all semantic-cache embedding spend."""
        try:
            from eden.config import get_settings

            return bool(getattr(get_settings(), "semantic_cache_v1", True))
        except Exception:
            return True

    @property
    def embed_calls(self) -> int:
        """Number of real upstream embed requests issued (ops + tests)."""
        return self._embed_calls

    def embedding_for(self, prompt: str) -> list[float] | None:
        """Return the memoized embedding for ``prompt``, if one exists.

        Lets a caller hand the vector computed during :meth:`get` straight
        to the paired :meth:`set` without a second embed request.
        """
        return self._embed_memo.get(self._normalize(prompt))

    @staticmethod
    def _embed_model() -> str:
        """Embedding model id (settings-driven, was hardcoded)."""
        try:
            from eden.config import get_settings

            model = getattr(
                get_settings(), "semantic_cache_embed_model", _DEFAULT_EMBED_MODEL
            )
            return str(model or _DEFAULT_EMBED_MODEL)
        except Exception:
            return _DEFAULT_EMBED_MODEL

    async def _get_embedding(self, text: str) -> list[float]:
        """Get embedding for text. Uses OpenAI-compatible API.

        C-12: uses ``AsyncOpenAI`` and awaits the ``create`` call so
        the event loop is released while the embed request is in
        flight. The pre-fix code used the sync ``OpenAI`` client,
        which blocked the loop for the full request duration
        (~100-400ms per embed call).

        COST: results are memoized on the normalized text. A gateway
        cache-miss calls ``.get`` then ``.set`` with the identical
        normalized prompt, which used to bill two embeddings for one
        request. Only successful embeds are memoized — the pseudo-random
        fallback vector below must never be cached as if it were real.
        """
        memoized = self._embed_memo.get(text)
        if memoized is not None:
            return memoized

        if self._embed_client is None:
            from openai import AsyncOpenAI

            from eden.config import get_settings

            s = get_settings()
            if s.use_minimax:
                self._embed_client = AsyncOpenAI(
                    api_key=s.minimax_api_key,
                    base_url=s.minimax_base_url,
                )
            else:
                self._embed_client = AsyncOpenAI(
                    api_key=s.openrouter_api_key,
                    base_url=s.openrouter_base_url,
                )

        # Try to get embedding — fall back to hashing if unavailable
        try:
            self._embed_calls += 1
            resp = await self._embed_client.embeddings.create(
                model=self._embed_model(),
                input=text[:8000],
            )
            vector = resp.data[0].embedding
            if len(self._embed_memo) >= self.EMBED_MEMO_MAX:
                # Cheap FIFO eviction; ordinary dicts preserve insertion order.
                self._embed_memo.pop(next(iter(self._embed_memo)), None)
            self._embed_memo[text] = vector
            return vector
        except Exception as e:
            logger.warning(f"Embedding generation failed: {e}")
            # Return a pseudo-random vector as fallback (won't match anything)
            import random

            random.seed(stable_seed(text))
            return [random.uniform(-0.01, 0.01) for _ in range(self.VECTOR_SIZE)]

    def _normalize(self, prompt: str) -> str:
        """Normalize prompt for embedding comparison."""
        return " ".join(prompt.split()).strip().lower()[:4000]

    async def get(
        self,
        prompt: str,
        model: str,
        similarity_threshold: float | None = None,
        embedding: list[float] | None = None,
    ) -> LLMResponse | None:
        """Try to get a semantically similar cached response.

        ``embedding`` lets a caller supply a pre-computed vector so the
        embed is not billed again; when omitted it is computed here and
        memoized, and can be read back with :meth:`embedding_for` to hand
        to the paired :meth:`set`.
        """
        import asyncio

        if not self._enabled():
            self._misses += 1
            return None
        threshold = similarity_threshold or self.threshold
        qdrant = _get_qdrant_client()()
        loop = asyncio.get_event_loop()

        # Ensure collection exists (run sync Qdrant ops in executor)
        try:
            await loop.run_in_executor(
                None,
                lambda: qdrant._get_client().get_collection(
                    qdrant.collection_prefix + self.COLLECTION
                ),
            )
        except Exception:
            try:
                from qdrant_client.http import models

                def _create_collection():
                    qdrant._get_client().create_collection(
                        collection_name=qdrant.collection_prefix + self.COLLECTION,
                        vectors_config=models.VectorParams(
                            size=self.VECTOR_SIZE,
                            distance=models.Distance.COSINE,
                        ),
                    )

                await loop.run_in_executor(None, _create_collection)
            except Exception as e:
                logger.warning(f"Semantic cache collection creation failed: {e}")
                self._misses += 1
                return None

        try:
            if embedding is None:
                embedding = await self._get_embedding(self._normalize(prompt))
            results = await loop.run_in_executor(
                None,
                lambda: qdrant.search(
                    collection=self.COLLECTION,
                    query_vector=embedding,
                    limit=3,
                    score_threshold=threshold,
                ),
            )

            for hit in results.results:
                cached_prompt = hit.payload.get("prompt", "")
                if self._is_equivalent(self._normalize(prompt), self._normalize(cached_prompt)):
                    from eden.llm.client import UsageStats

                    response = LLMResponse(
                        content=hit.payload["response"],
                        usage=UsageStats(
                            prompt_tokens=hit.payload.get("prompt_tokens", 0),
                            completion_tokens=hit.payload.get("completion_tokens", 0),
                            total_tokens=hit.payload.get("total_tokens", 0),
                            cost=hit.payload.get("cost"),
                        ),
                        model=hit.payload.get("model", "unknown"),
                        finish_reason=hit.payload.get("finish_reason", "unknown"),
                    )
                    self._hits += 1
                    return response

            self._misses += 1
            return None
        except Exception as e:
            logger.warning(f"Semantic cache read error: {e}")
            self._misses += 1
            return None

    async def set(
        self,
        prompt: str,
        model: str,
        response: LLMResponse,
        embedding: list[float] | None = None,
    ) -> bool:
        """Cache a response with its embedding.

        ``embedding`` should be the vector already computed by the paired
        :meth:`get` for this same prompt. When omitted the memo populated
        by that call is consulted before falling back to a fresh embed, so
        a get/set pair costs one embedding, not two.
        """
        import asyncio
        from datetime import datetime

        if not self._enabled():
            return False
        qdrant = _get_qdrant_client()()
        loop = asyncio.get_event_loop()
        try:
            if embedding is None:
                embedding = await self._get_embedding(self._normalize(prompt))
            point = {
                "id": hashlib.sha256(f"{self._normalize(prompt)}:{model}".encode()).hexdigest(),
                "vector": embedding,
                "payload": {
                    "prompt": prompt,
                    "model": model,
                    "response": response.content,
                    "prompt_tokens": response.usage.prompt_tokens,
                    "completion_tokens": response.usage.completion_tokens,
                    "total_tokens": response.usage.total_tokens,
                    "cost": response.usage.cost,
                    "finish_reason": response.finish_reason,
                    "timestamp": datetime.now(UTC).isoformat(),
                },
            }
            await loop.run_in_executor(
                None, lambda: qdrant.upsert(collection=self.COLLECTION, points=[point])
            )
            return True
        except Exception as e:
            logger.warning(f"Semantic cache write error: {e}")
            return False

    def _is_equivalent(self, a: str, b: str) -> bool:
        """Check if two normalized prompts are functionally equivalent."""
        # Exact match after normalization
        if a == b:
            return True
        # Allow small differences (e.g., trailing punctuation)
        if abs(len(a) - len(b)) < 5:
            # Simple word overlap check
            words_a = set(a.split())
            words_b = set(b.split())
            if words_a and words_b:
                overlap = len(words_a & words_b) / max(len(words_a), len(words_b))
                return overlap > 0.95
        return False

    def get_stats(self) -> dict:
        """Return cache statistics."""
        total = self._hits + self._misses
        return {
            "hits": self._hits,
            "misses": self._misses,
            "hit_rate": round(self._hits / total, 4) if total else 0.0,
            "threshold": self.threshold,
        }


# ─────────────────────────────────────────────────────────────────────────────
# §11.2 — KB cache tier telemetry helper
# ─────────────────────────────────────────────────────────────────────────────

async def record_kb_cache_lookup(
    *,
    tenant_id: str,
    trace_id: str,
    tier: str,
    hit: bool,
    latency_ms: float,
    cache_key: str | None = None,
) -> bool:
    """Emit a TelemetryEvent for a KB cache lookup, tagged with the
    tier (``L1`` / ``L2`` / ``DB``). Closes §11.2 — the existing cache
    did not emit per-tier labels, so the dashboard couldn't break
    down p95 by hit tier. The optimization-layer caller wraps each
    cache lookup in this helper. Failures are silent (telemetry is
    best-effort)."""
    try:
        from eden.observability.telemetry_collector import get_telemetry_collector
        collector = await get_telemetry_collector()
        return await collector.record_cache_lookup(
            tenant_id=tenant_id,
            trace_id=trace_id,
            tier=tier,
            hit=hit,
            latency_ms=latency_ms,
            cache_key=cache_key,
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("record_kb_cache_lookup failed: %s", exc)
        return False
