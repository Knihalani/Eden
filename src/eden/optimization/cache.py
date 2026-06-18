"""Multi-layer caching for LLM responses.

L1: Exact-match cache (Redis) — SHA256 key on normalized prompt+model+temp
L2: Semantic cache (Qdrant) — embedding similarity search
"""

import hashlib
import json
import logging
from datetime import UTC

from eden.llm.client import LLMResponse
from eden.storage.qdrant import get_qdrant_client
from eden.storage.redis import get_redis_client

logger = logging.getLogger(__name__)

# Default similarity threshold for semantic cache
DEFAULT_SEMANTIC_THRESHOLD = 0.95


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
            # Update hit counter in Redis
            await client.incr(f"{self.prefix}:stats:hits")
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
            await client.incr(f"{self.prefix}:stats:sets")
            return True
        except Exception as e:
            logger.warning(f"Exact cache write error: {e}")
            return False

    async def invalidate(self, pattern: str = "*") -> int:
        """Invalidate cache entries matching a pattern."""
        client = await get_redis_client()
        if client is None:
            return 0
        try:
            keys = await client.keys(f"{self.prefix}:{pattern}")
            if keys:
                return await client.delete(*keys)
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


class SemanticCache:
    """L2 semantic cache backed by Qdrant vector search.

    Stores prompt embeddings with their responses.
    Queries use cosine similarity to find near-matches.
    """

    COLLECTION = "eden_semantic_cache"
    VECTOR_SIZE = 1536

    def __init__(self, similarity_threshold: float = DEFAULT_SEMANTIC_THRESHOLD):
        self.threshold = similarity_threshold
        self._hits = 0
        self._misses = 0
        self._embed_client: object | None = None

    async def _get_embedding(self, text: str) -> list[float]:
        """Get embedding for text. Uses OpenAI-compatible API."""
        if self._embed_client is None:
            from openai import OpenAI

            from eden.config import get_settings

            s = get_settings()
            if s.use_minimax:
                self._embed_client = OpenAI(
                    api_key=s.minimax_api_key,
                    base_url=s.minimax_base_url,
                )
            else:
                self._embed_client = OpenAI(
                    api_key=s.openrouter_api_key,
                    base_url=s.openrouter_base_url,
                )

        # Try to get embedding — fall back to hashing if unavailable
        try:
            resp = self._embed_client.embeddings.create(
                model="openai/text-embedding-3-small",
                input=text[:8000],
            )
            return resp.data[0].embedding
        except Exception as e:
            logger.warning(f"Embedding generation failed: {e}")
            # Return a pseudo-random vector as fallback (won't match anything)
            import random

            random.seed(hash(text))
            return [random.uniform(-0.01, 0.01) for _ in range(self.VECTOR_SIZE)]

    def _normalize(self, prompt: str) -> str:
        """Normalize prompt for embedding comparison."""
        return " ".join(prompt.split()).strip().lower()[:4000]

    async def get(
        self,
        prompt: str,
        model: str,
        similarity_threshold: float | None = None,
    ) -> LLMResponse | None:
        """Try to get a semantically similar cached response."""
        import asyncio
        threshold = similarity_threshold or self.threshold
        qdrant = get_qdrant_client()
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
    ) -> bool:
        """Cache a response with its embedding."""
        import asyncio
        from datetime import datetime

        qdrant = get_qdrant_client()
        loop = asyncio.get_event_loop()
        try:
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
