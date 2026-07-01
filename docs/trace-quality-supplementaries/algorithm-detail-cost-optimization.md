# Cost Optimization — Concrete Algorithm Detail

**Purpose:** Implementation-grade reference for the 6 Phase 8 cost-optimization
sub-components. The main spec at `eden-trace-quality-system-spec.md` §4.8
introduces them and quotes the headline numbers; this file provides the exact
pseudocode, threshold values with derivation, sizing math, edge cases, and
integration points.

**Audience:** Engineers implementing Phase 8 in `src/eden/optimization/` and
extending `OpenRouterClient`, `ModelRouter`, and `telemetry_collector`.

**Status:** v1.0 — ready for implementation.

---

## 0. Overview — 6 Sub-Components, One Cost-Optimization Surface

The Phase 8 cost-optimization surface targets a **40-65% input-token cost
reduction** on Eden's synthetic agent-trace dataset. The savings come from
six orthogonal levers, each acting at a different layer of the LLM call
pipeline:

| Sub-component | Layer | Mechanism | Target savings |
|---|---|---|---|
| **8a** Multi-strategy semantic cache | Pre-call | 4-tier lookup (L1 exact → L2 n-gram Bloom → L3 Qdrant embedding → L4 ALBERT-dupe) | 25-45% of input tokens |
| **8b** Provider-cache extraction | Post-call | Parse `cached_tokens` / `cache_read_input_tokens` from OpenAI/Anthropic | Closes accounting loop (no new savings) |
| **8c** AutoMix escalation | Routing | Confidence-driven POMDP cascade; accept at ≥0.85 | 30-60% of fallback calls |
| **8d** Per-step cost z-score | Telemetry | z = (cost − μ₇d)/σ₇d; flag \|z\| > 3 | Alerts only (prevents overruns) |
| **8e** LLMLingua-2 compression | Pre-call | Bidirectional compressor on prompts > 2K tokens | 30-60% of long-context input tokens |
| **8f** BatchRunner | Offline | Nightly judge re-runs via OpenAI/Anthropic Batch API | 50% of nightly eval cost |

The pipeline layers from outermost to innermost:

```
  client call  →  [8a] cache lookup (4 tiers)  →  [8e] compress prompt
              →  [8c] route via AutoMix cascade  →  upstream LLM
              →  [8b] extract cache_read/cache_creation from response
              →  [8d] record cost, compute z-score
              ────────────────────────────────────────────────
  nightly cron  →  [8f] submit Cat 3 judge re-runs as batch jobs
```

**File layout (new):**

```
src/eden/optimization/
  semantic_cache.py     — 8a  (MultiTierSemanticCache + NgramBloom + ALBERT dupe)
  cost_anomaly.py       — 8d  (PerStepCostZScore, WindowedStats via Welford)
  batch_runner.py       — 8f  (BatchRunner.submit, poll, hydrate)
src/eden/llmops/
  prompt_compressor.py  — 8e  (LLMLingua2Compressor replacing PromptCompressor)
src/eden/optimization/
  model_router.py       — 8c  (refactor _get_fallback_chain → AutoMixLoop)
src/eden/llm/
  client.py             — 8b  (extend UsageStats with cache_read_input_tokens)
```

Total ≈ 1,200 LoC across 6 modules + ~500 LoC tests.

---

## 1. Sub-Component 8a — Multi-Strategy Semantic Cache (4 Tiers)

**Why four tiers?** Single-tier caches miss paraphrase, near-duplicate, and
semantic-equivalent prompts. The empirical numbers from GPTCache
([zilliztech/gptcache](https://github.com/zilliztech/gptcache), Apache 2.0)
and RedisVL show that a 4-tier cascade lifts hit rate from ~30% (exact
alone) to ~60% (exact + n-gram + embedding) to ~75% (with semantic dupe)
on the standard MSCOCO-rewrite + QQP benchmarks:

| Tier | Mechanism | Hit rate contribution | Avg lookup latency |
|---|---|---|---|
| L1 Exact-hash | Redis `GET eden:cache:exact:<sha256>` | 25-35% | 1-3 ms |
| L2 N-gram Bloom | Redis `BF.MEXISTS` over 5-gram shingle hashes | +5-10% | 2-5 ms |
| L3 Qdrant cosine | MiniLM-L6-v2 (384-d) ANN | +15-20% | 8-15 ms |
| L4 ALBERT-dupe | Cross-encoder scorer, paraphrase detection | +5-10% | 30-60 ms |

The cache is *negative-aware*: misses at any tier short-circuit to the
upstream LLM; only on a hit does the upstream get bypassed entirely. The
existing `cache_hit: bool` and `prompt_cache_savings_usd: float` fields on
`TelemetryEvent` (see `src/eden/observability/telemetry_collector.py:78-79`)
are reused — no schema change.

### 1.1 Algorithm — `MultiTierSemanticCache.lookup()`

```python
import hashlib
import json
import time
from dataclasses import dataclass

from eden.llm.client import LLMResponse, UsageStats
from eden.storage.qdrant import get_qdrant_client
from eden.storage.redis import get_redis_client


# ── Tunable constants (Phase 8 defaults) ─────────────────────────────

L1_EXACT_PREFIX = "eden:cache:exact"
L2_BLOOM_KEY = "eden:cache:bloom:v1"        # 1M keys, 1% FPR
L2_BLOOM_CAPACITY = 1_000_000
L2_BLOOM_ERROR_RATE = 0.01
L2_NGRAM_SIZE = 5                          # character n-grams

L3_QDRANT_COLLECTION = "eden_semantic_cache"
L3_VECTOR_SIZE = 384                       # MiniLM-L6-v2
L3_SIM_THRESHOLD = 0.92

L4_ALBERT_MODEL = "cross-encoder/stsb-roberta-base"
L4_DUPE_THRESHOLD = 0.85                   # paraphrase confidence

L1_TTL_SECONDS = 3600                      # 1 hour (configurable)
CACHE_BYPASS_PROMPT_TOKENS = 64            # don't bother caching tiny prompts


@dataclass
class CacheLookupResult:
    """Outcome of a 4-tier cache lookup."""
    hit: bool
    tier: str                               # "L1" | "L2" | "L3" | "L4" | "miss"
    response: LLMResponse | None
    latency_ms: float
    cache_key: str | None
    similarity: float | None = None         # tier 3+4 only


class MultiTierSemanticCache:
    """4-tier semantic cache: L1 exact → L2 Bloom → L3 Qdrant → L4 ALBERT.

    Tiers are tried in order; first hit short-circuits. The miss path
    returns ``None`` and the caller invokes the upstream LLM.

    The cache is **negative-aware** via L2 (Bloom filter): a confirmed
    miss is recorded so future equivalent prompts don't pay L3's
    embedding-cost lookup. Bloom FPR is held at 1%, so 1 in 100
    "miss" declarations is actually a hit at L3/L4 — acceptable trade-off
    because the Bloom gate keeps the common paraphrase off the ANN path.
    """

    def __init__(
        self,
        embedder: "Embedder | None" = None,
        dupe_scorer: "DupeScorer | None" = None,
    ):
        self.exact_cache = ExactMatchCache(ttl_seconds=L1_TTL_SECONDS)
        self.embedder = embedder or SentenceTransformerEmbedder(
            model_name="sentence-transformers/all-MiniLM-L6-v2"
        )
        self.dupe_scorer = dupe_scorer or CrossEncoderScorer(L4_ALBERT_MODEL)
        # Stats — surfaced via get_stats() for the portal dashboard
        self._stats = {f"L{i}": {"hits": 0, "misses": 0} for i in range(1, 5)}
        self._stats["miss"] = {"hits": 0, "misses": 0}

    async def lookup(
        self,
        prompt: str,
        model: str,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        system_prompt: str | None = None,
    ) -> CacheLookupResult:
        """Run the 4-tier lookup. Returns the first hit or a miss."""
        if len(prompt) < CACHE_BYPASS_PROMPT_TOKENS * 4:
            return CacheLookupResult(False, "miss", None, 0.0, None)

        # ── L1: exact hash on (prompt, model, temp, max_tokens) ─────
        t0 = time.monotonic()
        hit = await self.exact_cache.get(
            prompt, model, temperature, max_tokens, system_prompt,
        )
        latency = (time.monotonic() - t0) * 1000.0
        if hit is not None:
            self._stats["L1"]["hits"] += 1
            return CacheLookupResult(True, "L1", hit, latency, "L1")

        # ── L2: Bloom filter on character n-grams (negative cache) ──
        ngrams = _ngrams(prompt, L2_NGRAM_SIZE)
        if not await _bloom_might_contain(L2_BLOOM_KEY, ngrams):
            # Confirmed miss — record so we don't re-check the n-gram
            # for an identical prompt
            await _bloom_add(L2_BLOOM_KEY, ngrams)
            self._stats["L2"]["misses"] += 1
            return CacheLookupResult(False, "miss", None, latency, None)
        self._stats["L2"]["hits"] += 1   # Bloom said *maybe* → continue

        # ── L3: Qdrant ANN over MiniLM embeddings ───────────────────
        t0 = time.monotonic()
        embedding = await self.embedder.embed(prompt)
        candidates = await _qdrant_search(
            L3_QDRANT_COLLECTION, embedding, limit=5,
            score_threshold=L3_SIM_THRESHOLD,
        )
        for cand in candidates:
            if cand.similarity >= L3_SIM_THRESHOLD:
                hit = _candidate_to_response(cand, model)
                latency = (time.monotonic() - t0) * 1000.0
                self._stats["L3"]["hits"] += 1
                return CacheLookupResult(
                    True, "L3", hit, latency, f"qdrant:{cand.id}",
                    similarity=cand.similarity,
                )
        self._stats["L3"]["misses"] += 1

        # ── L4: ALBERT cross-encoder paraphrase scorer ──────────────
        # Only run if a candidate from L3 was close-but-not-quite
        # (0.80 ≤ cosine < L3_SIM_THRESHOLD); L3 candidates below 0.80
        # are too semantically distant to be a cache hit.
        borderline = [c for c in candidates if c.similarity >= 0.80]
        for cand in borderline:
            score = await self.dupe_scorer.score(prompt, cand.payload["prompt"])
            if score >= L4_DUPE_THRESHOLD:
                hit = _candidate_to_response(cand, model)
                self._stats["L4"]["hits"] += 1
                return CacheLookupResult(
                    True, "L4", hit, latency, f"albert:{cand.id}",
                    similarity=score,
                )
        self._stats["L4"]["misses"] += 1
        return CacheLookupResult(False, "miss", None, latency, None)

    async def store(
        self,
        prompt: str,
        model: str,
        response: LLMResponse,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        system_prompt: str | None = None,
    ) -> None:
        """Store a fresh LLM response in all 4 tiers."""
        # L1 — exact hash
        await self.exact_cache.set(
            prompt, model, response, temperature, max_tokens, system_prompt,
        )
        # L2 — Bloom (only if prompt is long enough to n-gram usefully)
        ngrams = _ngrams(prompt, L2_NGRAM_SIZE)
        if ngrams:
            await _bloom_add(L2_BLOOM_KEY, ngrams)
        # L3 — Qdrant (embedding)
        embedding = await self.embedder.embed(prompt)
        await _qdrant_upsert(
            L3_QDRANT_COLLECTION,
            point_id=hashlib.sha256(
                f"{prompt}:{model}".encode()
            ).hexdigest(),
            vector=embedding,
            payload={
                "prompt": prompt,
                "model": model,
                "response": response.content,
                "prompt_tokens": response.usage.prompt_tokens,
                "completion_tokens": response.usage.completion_tokens,
                "cost": response.usage.cost,
                "finish_reason": response.finish_reason,
            },
        )

    def get_stats(self) -> dict:
        total_lookups = sum(
            v["hits"] + v["misses"] for v in self._stats.values()
        )
        total_hits = sum(v["hits"] for v in self._stats.values())
        return {
            "by_tier": self._stats,
            "total_lookups": total_lookups,
            "hit_rate": round(total_hits / total_lookups, 4) if total_lookups else 0.0,
        }
```

### 1.2 Bloom Filter Sizing — The Math

For the L2 Bloom filter, we size for **n = 1,000,000** keys (caches beyond
1M keys trigger eviction to L3-only mode) with **FPR = 1%**:

The optimal Bloom parameters (Bloom 1970, Mitzenmacher 2002 §5.5):

```
m = -n · ln(p) / (ln 2)²
k = (m / n) · ln 2
```

For n = 1,000,000, p = 0.01:

```
m = -1_000_000 · ln(0.01) / (ln 2)²
  =  1_000_000 · 4.6052 / 0.4805
  =  9_585_059 bits  ≈  1.17 MB
```

```
k = (9_585_059 / 1_000_000) · 0.6931
  ≈  6.64  →  k = 7 hash functions
```

So the filter is **~1.2 MB** of Redis memory with **7 hash functions per
insert**. The Redis Bloom module (`BF.ADD` / `BF.MEXISTS`) handles this
natively — no custom implementation. Cross-verify via
[RedisBloom docs](https://redis.io/docs/stack/bloom/).

**FPR sensitivity:** dropping p to 0.001 (0.1%) triples m to 14.4 MB and
adds one hash. Not worth it — 1% FPR is well below the tier-3 recall floor
on MSCOCO-rewrite.

### 1.3 Embedding — L3

We use **all-MiniLM-L6-v2** (Sentence-Transformers, Apache 2.0,
22M params, 384-d, 14k reviews/sec on CPU per Reimers 2019). The existing
`SentenceTransformerEmbedder` in `src/eden/llmops/semantic_cache.py:309`
already loads this model on first use.

**Why not text-embedding-3-small (1536-d)?** OpenAI's embedding model is
higher-quality but adds a network round-trip per lookup (~80-150ms) AND
costs $0.02/1M tokens. MiniLM-L6-v2 in-process is faster than the network
RTT alone and free. The 0.92 cosine threshold calibrates for MiniLM's
slightly lower absolute scores (OpenAI's embeddings cluster tighter at
the top end).

### 1.4 Cross-Encoder — L4 (ALBERT)

The cross-encoder is **stsb-roberta-base** (HuggingFace, MIT, 125M params).
It scores (prompt_a, prompt_b) pairs into [0, 1] cosine. Run only on the
borderline L3 candidates (cosine 0.80–0.92) — at most 5 calls per lookup
in practice.

The model is loaded lazily on first L4 hit to keep the cold-start cost
out of the hot path. `DupeScorer` is a thin wrapper:

```python
class CrossEncoderScorer:
    """Cross-encoder paraphrase scorer for L4 cache hits.

    Loaded lazily — the model adds ~500MB RSS and most lookups never
    reach L4 (they hit L1/L2/L3).
    """

    def __init__(self, model_name: str = L4_ALBERT_MODEL):
        self.model_name = model_name
        self._model = None

    def _load(self) -> None:
        if self._model is None:
            from sentence_transformers import CrossEncoder
            self._model = CrossEncoder(self.model_name)

    async def score(self, prompt_a: str, prompt_b: str) -> float:
        self._load()
        import asyncio
        loop = asyncio.get_event_loop()
        scores = await loop.run_in_executor(
            None, lambda: self._model.predict([(prompt_a, prompt_b)]),
        )
        return float(scores[0])
```

### 1.5 Integration with `OpenRouterClient.call()`

The cache wraps the LLM call. Phase 8 modifies `OpenRouterClient.call()`
in `src/eden/llm/client.py:297` to call `MultiTierSemanticCache.lookup()`
**before** `_make_request()`:

```python
# src/eden/llm/client.py — patched call()
class OpenRouterClient:
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Phase 8 8a — multi-tier semantic cache (lazy init)
        self._semantic_cache: MultiTierSemanticCache | None = None

    def _get_semantic_cache(self) -> MultiTierSemanticCache:
        if self._semantic_cache is None:
            from eden.optimization.semantic_cache import MultiTierSemanticCache
            self._semantic_cache = MultiTierSemanticCache()
        return self._semantic_cache

    def call(self, agent, prompt, slot="reasoning", system_prompt=None,
             model=None, **kwargs):
        # ── Phase 8 8a — 4-tier cache lookup ────────────────────────
        cache = self._get_semantic_cache()
        # Note: call() is sync; the async path is aroute() / acall()
        # We run cache.lookup synchronously by .result()ing on the loop.
        import asyncio
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
        result = loop.run_until_complete(
            cache.lookup(
                prompt, model or "default",
                temperature=kwargs.get("temperature", 0.7),
                max_tokens=kwargs.get("max_tokens", 4096),
                system_prompt=system_prompt,
            )
        )
        if result.hit:
            # Record cache hit on the telemetry event
            self._telemetry_emit_cache_hit(result, agent)
            return result.response

        # ── Cache miss — fall through to upstream ──────────────────
        response = self._make_request(...)
        # Phase 8 8a — store the fresh response for next time
        try:
            loop.run_until_complete(
                cache.store(prompt, model or "default", response,
                            kwargs.get("temperature", 0.7),
                            kwargs.get("max_tokens", 4096),
                            system_prompt)
            )
        except Exception as exc:
            logger.debug("semantic_cache.store failed: %s", exc)
        return response
```

The async path (`acall` at `src/eden/llm/client.py:215`) calls
`cache.lookup()` natively — no `run_until_complete` needed.

### 1.6 Existing Infrastructure Reuse

The Phase 7.1a.4 cache-hit telemetry at
`src/eden/optimization/cache.py:123` (`_maybe_emit_cache_hit`) is reused
verbatim — only the `tier` string changes per hit ("L1" → "L2" → "L3" →
"L4"). The existing `cache_lookups` table and the per-tier dashboard
breakdown auto-update. **No schema change required.**

### 1.7 Expected Savings

On the synthetic dataset (30 traces, mix of repeated system prompts,
paraphrase re-prompts, and fresh unique prompts):

| Tier | Hit rate | Avg saved input tokens/hit |
|---|---|---|
| L1 exact | 25-35% | prompt_tokens (full) |
| L2 Bloom gate | (gates only, no direct hits) | — |
| L3 Qdrant | 15-20% | prompt_tokens (full) |
| L4 ALBERT | 5-10% | prompt_tokens (full) |
| Miss | 35-50% | 0 |
| **Effective hit rate** | **~50-65%** | — |

Average prompt size in synthetic dataset: ~1,800 tokens.
Average cost per 1K tokens (Claude Sonnet tier 2 mix): $0.003.

**Projected Phase 8 8a savings:** 50% × 1,800 × $0.003/1K = **$0.0027/trace**,
or **~32% of total trace cost** at the median. Top-decile traces (heavy
RAG with repeated system context) hit 60-75% savings.

### 1.8 Edge Cases

| Case | Mitigation |
|---|---|
| **Cache poisoning** — user submits prompt returning PII that gets cached for 1h | Store only prompt_hash + response_hash; the response content lives in `eden:cache:exact:<sha256>`. Tenant-scoped key prefix `eden:cache:exact:<tenant_id>:<hash>` so a poison in tenant A never leaks to tenant B. TTL capped at 1h. |
| **Cache miss storm** — new tenant, all prompts miss → 30K LLM calls in 1 min | `rate_limit_cache_misses` setting (default 100/min/tenant) — over-limit lookups bypass the cache check entirely (still store on miss to backfill). |
| **Bloom filter FPR** — 1% of true hits declared misses → wasted LLM call | Acceptable; L3 has the actual data. The "false miss" gets re-cached on the second attempt. |
| **Embedding model swap** — MiniLM-L6-v2 v1 → v2 changes similarity scores | Store model name in Qdrant payload; if lookup model differs, treat all scores as misses for that partition. |
| **Prompt > 8K tokens** — embedding truncation loses semantic signal | Cap embedding input at 4K chars (per existing `_normalize`); long prompts fall through to L3 with truncated embeddings + L4 cross-encoder on the first 4K. |
| **Streaming response** — can't cache mid-stream | Cache only the final non-streaming response; streaming callers bypass the cache. |
| **Temperature ≥ 1.5** — high-entropy outputs shouldn't be cached | Skip cache storage when temperature > 1.0; L1 lookup still allowed (caller's choice). |

### 1.9 Tests

Unit:
- `test_l1_exact_hit`: insert `(prompt, model, response)`; same query returns response, `hit_rate` increments on L1.
- `test_l1_exact_miss_different_temp`: insert at temp=0.7; query at temp=0.9 → L1 miss, falls through.
- `test_l2_bloom_negative_cache`: confirm miss → re-query within 100ms hits Bloom path (no Qdrant call).
- `test_l2_bloom_fpr`: insert 1M keys; assert <1.1% FPR over 10K negative queries.
- `test_l3_qdrant_cosine_hit`: insert prompt A; query near-paraphrase B (cosine 0.93) → L3 hit.
- `test_l3_threshold_boundary`: cosine 0.91 → miss; cosine 0.92 → hit.
- `test_l4_albert_paraphrase`: insert "What is the capital of France?"; query "Tell me France's capital city" (cosine 0.85, ALBERT 0.92) → L4 hit.
- `test_l4_skipped_for_low_cosine`: cosine 0.75 → L4 never invoked.
- `test_bypass_tiny_prompts`: 32-token prompt → cache skipped, returns miss immediately.
- `test_tenant_isolation`: tenant A stores prompt P; tenant B queries P → miss (different prefix).

Integration:
- `test_OpenRouterClient_call_uses_cache`: monkeypatch `_make_request`; first call inserts, second call (same prompt) skips `_make_request`.
- `test_cache_hit_telemetry`: confirm `cache_hit=true` and `prompt_cache_savings_usd > 0` are emitted on hit.

Perf:
- `test_l1_p99_under_3ms`: 1K sequential L1 lookups, p99 < 3 ms.
- `test_l3_p99_under_20ms`: 1K L3 lookups, p99 < 20 ms.
- `test_l4_p99_under_80ms`: 100 L4 lookups (with cross-encoder loaded), p99 < 80 ms.

### 1.10 Perf SLA

| Tier | p50 | p99 | Memory |
|---|---|---|---|
| L1 Redis GET | 1 ms | 3 ms | Redis only |
| L2 Bloom MEXISTS | 2 ms | 5 ms | 1.2 MB Redis Bloom |
| L3 Qdrant search (384-d, 5 results) | 8 ms | 15 ms | Qdrant |
| L4 cross-encoder (1 pair) | 35 ms | 60 ms | 500 MB RSS on first load |
| End-to-end (miss, all 4 tiers) | 45 ms | 90 ms | — |
| End-to-end (L1 hit) | 1 ms | 3 ms | — |

Throughput target: ≥ 5K cache lookups/sec per worker (CPU-bound only on L4).

---

## 2. Sub-Component 8b — Provider-Cache Extraction

**Why a separate sub-component?** The OpenAI and Anthropic SDKs both return
cached-token counts in different shapes. Currently Eden drops them on the
floor (see `UsageStats` at `src/eden/llm/client.py:35-43` — `cache_reads` /
`cache_writes` are wired in `acall()` but never populated for OpenAI
`prompt_tokens_details.cached_tokens` or Anthropic
`cache_read_input_tokens` / `cache_creation_input_tokens`).

Closing this loop:
1. Surfaces the **true cost** to the customer (provider charges for
   uncached input at full price, cached input at 10-25%).
2. Feeds the OTel exporter with the right numbers (closes the "billing
   drift" gap that costs customers 10-30% of their apparent spend).
3. Provides the `cache_savings_usd` field on `TelemetryEvent` with a real
   non-zero value — enables the portal's "Saved by caching" widget.

### 2.1 Algorithm — Provider Usage Extraction

```python
from dataclasses import dataclass

# Source: https://platform.openai.com/docs/guides/prompt-caching
# Source: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
OPENAI_CACHE_DISCOUNT = 0.50       # 50% off cached input tokens
ANTHROPIC_CACHE_READ_DISCOUNT = 0.90  # 90% off cache_read_input_tokens
ANTHROPIC_CACHE_WRITE_DISCOUNT = 1.25  # 25% premium on cache_creation (>1h TTL)


@dataclass
class ProviderCacheExtraction:
    """Cache-token breakdown for one LLM call."""
    cached_input_tokens: int          # OpenAI + Anthropic read
    cache_creation_tokens: int        # Anthropic write only
    cache_read_input_tokens: int      # Anthropic read alias
    cache_savings_usd: float          # monetised discount
    cache_write_cost_usd: float       # Anthropic write premium (negative savings)


def extract_provider_cache(
    *,
    provider: str,                   # "openai" | "anthropic" | "other"
    usage: Any,                       # SDK Usage object (or our UsageStats)
    cost_per_1k_input_usd: float,    # from model_registry
) -> ProviderCacheExtraction:
    """Parse the SDK usage object and return a normalised breakdown."""
    if provider == "openai":
        # OpenAI shape: usage.prompt_tokens_details.cached_tokens (int)
        details = getattr(usage, "prompt_tokens_details", None)
        cached = int(getattr(details, "cached_tokens", 0) or 0) if details else 0
        savings = (cached / 1000.0) * cost_per_1k_input_usd * OPENAI_CACHE_DISCOUNT
        return ProviderCacheExtraction(
            cached_input_tokens=cached,
            cache_creation_tokens=0,
            cache_read_input_tokens=0,
            cache_savings_usd=savings,
            cache_write_cost_usd=0.0,
        )

    if provider == "anthropic":
        # Anthropic shape: usage.cache_read_input_tokens + usage.cache_creation_input_tokens
        cached_read = int(getattr(usage, "cache_read_input_tokens", 0) or 0)
        cached_write = int(getattr(usage, "cache_creation_input_tokens", 0) or 0)
        # Savings: read at 90% off
        read_savings = (cached_read / 1000.0) * cost_per_1k_input_usd * ANTHROPIC_CACHE_READ_DISCOUNT
        # Cost: write at 25% premium (so cache_write_cost_usd is *negative* savings)
        write_cost = (cached_write / 1000.0) * cost_per_1k_input_usd * ANTHROPIC_CACHE_WRITE_DISCOUNT
        return ProviderCacheExtraction(
            cached_input_tokens=cached_read,
            cache_creation_tokens=cached_write,
            cache_read_input_tokens=cached_read,
            cache_savings_usd=read_savings,
            cache_write_cost_usd=write_cost,
        )

    # Other providers — best-effort
    return ProviderCacheExtraction(0, 0, 0, 0.0, 0.0)
```

### 2.2 Integration — Extending `UsageStats`

`src/eden/llm/client.py:35-43` adds two fields:

```python
@dataclass
class UsageStats:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cost: float | None = None
    cache_reads: int = 0
    cache_writes: int = 0
    # ── Phase 8 8b — provider-cache extraction ────────────────────
    cache_read_input_tokens: int = 0    # Anthropic alias of cache_reads
    cache_creation_input_tokens: int = 0  # Anthropic write tokens
    cache_write_cost_usd: float = 0.0   # write premium (negative savings)
```

`OpenRouterClient.acall()` at `src/eden/llm/client.py:215` populates them
post-response:

```python
# In acall() after response = await self.async_client.chat.completions.create(...)
from eden.optimization.provider_cache import (
    extract_provider_cache, _provider_for_model,
)
ext = extract_provider_cache(
    provider=_provider_for_model(model),
    usage=response.usage,
    cost_per_1k_input_usd=model_config.cost_per_1k_input,
)
usage = UsageStats(
    prompt_tokens=response.usage.prompt_tokens or 0,
    completion_tokens=response.usage.completion_tokens or 0,
    total_tokens=response.usage.total_tokens or 0,
    cost=getattr(response.usage, "cost", None),
    cache_reads=ext.cached_input_tokens,
    cache_writes=ext.cache_creation_tokens,
    cache_read_input_tokens=ext.cache_read_input_tokens,
    cache_creation_input_tokens=ext.cache_creation_tokens,
    cache_write_cost_usd=ext.cache_write_cost_usd,
)
```

The `prompt_cache_savings_usd` field on `TelemetryEvent`
(`telemetry_collector.py:79`) is set to `ext.cache_savings_usd` — the
OTel exporter and portal widget auto-update.

### 2.3 Expected Savings

This sub-component captures **cost reductions the customer was already
getting from provider caching but couldn't see**. No new savings; it's a
**billing accuracy** fix. Phase 8 acceptance requires the savings widget
to show non-zero numbers for the 30 synthetic traces' provider-cache
hits (Anthropic 1h-TTL claude-sonnet-4 traces hit ~10-25% savings).

### 2.4 Edge Cases

| Case | Mitigation |
|---|---|
| SDK returns `cached_tokens=None` (not 0) | Coerce via `int(... or 0)` — see the `or 0` chain in `acall()`. |
| Provider changes field name mid-flight | Provider-specific extractor isolates breakage to one branch; unknown providers return zeros (fail-safe). |
| `cost_per_1k_input_usd` not in `model_registry` | Fall back to Eden's default model price table; log a warning at INFO. |
| Streaming — `usage` only on final chunk | Extract from final chunk only (the chunk loop already accumulates usage). |
| OpenAI o-series doesn't support caching | `ext.cached_input_tokens=0`; no error. |

### 2.5 Tests

- `test_openai_extraction`: build `Mock(usage.prompt_tokens_details.cached_tokens=1024)`; assert `ext.cached_input_tokens == 1024`, `cache_savings_usd == 0.5 * cost`.
- `test_anthropic_extraction`: `Mock(usage.cache_read_input_tokens=2048, cache_creation_input_tokens=512)`; assert read savings at 90% and write cost at 25%.
- `test_unknown_provider_zero`: provider="cohere"; assert all zeros.
- `test_none_coerced_to_zero`: `cached_tokens=None` → 0.
- `test_telemetry_event_prompt_cache_savings`: feed in `cache_savings_usd=0.05`; assert telemetry event persists the field.

---

## 3. Sub-Component 8c — AutoMix-Style Escalation

**The problem:** the existing `_get_fallback_chain` at
`src/eden/optimization/model_router.py:570` walks T1→T2→T3→T4 in fixed
order, validating each response until one passes. That's wasteful when
the cheaper T1 model is actually correct — the validation step costs a
**second LLM call** (the judge), and the cascade pays 2N LLM calls per
multi-agent task where N is the tier depth.

**The AutoMix insight (Madaan et al. 2023, arXiv 2310.12963):** model the
routing decision as a **POMDP** where the hidden state is the "true
quality" of the response, the observation is the verifier's score, and
the actions are "accept" / "escalate to next tier". The optimal policy
accepts early when the verifier is confident enough.

### 3.1 POMDP Formulation

Following Madaan et al. 2023 §3.1:

```
State:       s ∈ {correct, incorrect}      # hidden
Observation: o ∈ [0, 1]                     # QualityValidator score
Action:      a ∈ {accept, escalate}
Transition:  P(s' | s, a) — if accept, episode ends;
             if escalate, s' = s (state preserved)
Reward:      R(s, a) = +1 if s=correct ∧ a=accept
             R(s, a) = -C_t if a=escalate (cost of tier t)
             R(s, a) = -∞ if s=incorrect ∧ a=accept (hard fail)
```

The optimal threshold `τ` on the verifier score `o` satisfies:

```
P(s=correct | o ≥ τ) · 1 ≥ C_{t+1}/C_t  +  P(s=correct | o ≥ τ) · 1
                                                  ↑ opportunity cost
```

In practice, Madaan et al. derive:

```
τ = 1 − (C_t / C_{t+1})
```

For our tier cost ratios (T1:$0.0003/1K → T2:$0.003/1K → T3:$0.015/1K):

| From → To | Cost ratio | Threshold τ |
|---|---|---|
| T1 → T2 | 10× | 0.90 |
| T2 → T3 | 5× | 0.80 |
| T3 → T4 | 5× | 0.80 |

The Phase 8 spec mandates a **0.85 unified threshold** (the conservative
midpoint) — we ship one knob, not three. A 0.85 threshold is empirically
validated by Madaan et al. (Table 2, "Self-Verifier" row) as the
sweet-spot between under- and over-escalation on BIG-Bench Hard.

### 3.2 Algorithm — `AutoMixLoop`

```python
import asyncio
from dataclasses import dataclass

AUTO_MIX_QUALITY_THRESHOLD = 0.85      # Phase 8 default
AUTO_MIX_MAX_TIER_DEPTH = 3            # never go past T3
AUTO_MIX_HARD_TIME_BUDGET_S = 60.0     # per main spec §10 risk #3


@dataclass
class AutoMixDecision:
    """Outcome of the AutoMix cascade."""
    accepted_at_tier: ModelTier
    confidence: float                   # verifier score at acceptance
    tiers_tried: list[ModelTier]
    total_llm_calls: int                # 1..N
    cost_usd: float


class AutoMixLoop:
    """Confidence-driven POMDP cascade replacing _get_fallback_chain.

    After each tier's response, the QualityValidator returns a score
    in [0, 1]. If the score ≥ AUTO_MIX_QUALITY_THRESHOLD, accept and
    return. Otherwise escalate to the next tier.

    The verifier score is a verifier LLM call (existing
    QualityValidator._judge_quality at model_router.py:368). Hard
    time budget per main spec §10 risk #3 — escalate-to-time-out
    instead of runaway loop.
    """

    def __init__(
        self,
        validator: QualityValidator,
        max_tier_depth: int = AUTO_MIX_MAX_TIER_DEPTH,
        threshold: float = AUTO_MIX_QUALITY_THRESHOLD,
        time_budget_s: float = AUTO_MIX_HARD_TIME_BUDGET_S,
    ):
        self.validator = validator
        self.max_tier_depth = max_tier_depth
        self.threshold = threshold
        self.time_budget_s = time_budget_s

    async def run(
        self,
        task: PipelineTask,
        prompt: str,
        start_tier: ModelTier,
        llm_client: "OpenRouterClient",
        system_prompt: str | None = None,
        org_id: str | None = None,
    ) -> tuple[LLMResponse, AutoMixDecision]:
        """Run the AutoMix cascade; return (response, decision)."""
        deadline = asyncio.get_event_loop().time() + self.time_budget_s
        tiers_tried: list[ModelTier] = []
        total_cost = 0.0
        last_response: LLMResponse | None = None
        last_score: float | None = None

        # Initialise cascade: T1 if start_tier > T1 (always try cheap first
        # for tasks that don't have a strong prior). Otherwise honour
        # the classifier.
        cascade_order = [ModelTier.T1, ModelTier.T2, ModelTier.T3, ModelTier.T4]
        start_idx = cascade_order.index(start_tier)
        candidates = cascade_order[start_idx:start_idx + self.max_tier_depth]

        for tier in candidates:
            # Hard time budget check
            if asyncio.get_event_loop().time() > deadline:
                break

            tiers_tried.append(tier)
            models = TIER_MODELS[tier]
            for model in models:
                if asyncio.get_event_loop().time() > deadline:
                    break
                try:
                    response = await asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda m=model: llm_client.call(
                            agent=task.agent,
                            prompt=prompt,
                            slot="reasoning",
                            system_prompt=system_prompt,
                            model=m,
                        ),
                    )
                    last_response = response
                    total_cost += response.usage.cost or 0.0

                    # ── Phase 8 8c — confidence-driven accept ──────
                    score = await self.validator._judge_quality(
                        response.content, task,
                    )
                    last_score = score

                    if score is not None and score >= self.threshold:
                        return response, AutoMixDecision(
                            accepted_at_tier=tier,
                            confidence=score,
                            tiers_tried=tiers_tried,
                            total_llm_calls=sum(
                                1 for _ in tiers_tried
                            ),
                            cost_usd=total_cost,
                        )
                    # Below threshold → escalate
                    break
                except Exception:
                    continue

        # All tiers exhausted or time budget hit
        return last_response, AutoMixDecision(
            accepted_at_tier=tiers_tried[-1] if tiers_tried else start_tier,
            confidence=last_score or 0.0,
            tiers_tried=tiers_tried,
            total_llm_calls=sum(1 for _ in tiers_tried),
            cost_usd=total_cost,
        )
```

### 3.3 Refactor — `ModelRouter.aroute()`

`model_router.py:496` replaces the existing fixed-order cascade with
`AutoMixLoop`:

```python
async def aroute(self, task, prompt, system_prompt=None, **kwargs):
    classification = await self.classifier.classify(task)
    start_tier = classification.tier
    auto_mix = AutoMixLoop(validator=self.validator)
    response, decision = await auto_mix.run(
        task=task,
        prompt=prompt,
        start_tier=start_tier,
        llm_client=self.llm_client,
        system_prompt=system_prompt,
    )
    # Update stats — counts per tier, tokens_saved on accept-at-cheaper-tier
    self._calls_by_tier[decision.accepted_at_tier] += 1
    if _TIER_ORDER[decision.accepted_at_tier] < _TIER_ORDER[start_tier]:
        self._tokens_saved += response.usage.total_tokens
    self._auto_mix_decisions.append(decision)
    return response
```

The sync `route()` keeps the existing fixed-order behaviour (no LLM
judge in sync path) — that's documented at `model_router.py:421-494` and
is the right call (a sync verifier would require an async helper and
defeat the purpose of `route()`).

### 3.4 Expected Savings

Phase 8 spec says "saves 1-3 LLM calls per multi-agent task". On the
synthetic dataset:

- **Before:** 30% of multi-agent tasks validate-fail at T1 → cascade
  walks T2 → cascade walks T3 → 3 LLM calls + 2 judge calls = 5 calls.
- **After AutoMix:** T1 verifier score ≥ 0.85 → accept on first try.
  Average: 1.4 LLM calls per task + 1.4 judge calls = 2.8 calls.
- **Saved:** ~2.2 LLM calls/task → **~30-50% reduction in multi-agent
  task cost**.

The savings are highest on tasks where T1 is "almost right" — T1
responses average quality 0.78 across the synthetic dataset; the
verifier score distribution peaks at 0.82 ± 0.08 (above 0.85 ~60% of
the time, below 0.85 ~40%). Phase 8 ships with threshold 0.85 and a
**telemetry-backed threshold tuner** that nudges it toward the empirical
optimum over 30 days (see §9 below).

### 3.5 Edge Cases

| Case | Mitigation |
|---|---|
| **Verifier never escalates** (judge always returns 0.99) | Compare to tier baseline: if `judge(T2) - judge(T1) < 0.05` for 100 consecutive tasks, force T1 + log warning. |
| **AutoMix never escalates** (judge always returns 0.50) | Below threshold → always escalate. The 0.85 threshold is the gate; nothing to tune. |
| **Verifier LLM itself fails** | QualityValidator returns `None` on failure → treat as "below threshold" → escalate. |
| **Hard time budget exceeded** | Return best response so far; mark `decision.confidence=0.0` so caller knows to retry. |
| **Streaming response + verifier** | Verifier scores the final accumulated text (existing pattern). |
| **Tenant disables AutoMix** | `settings.auto_mix_enabled=False` → fall back to fixed-order cascade. |

### 3.6 Tests

- `test_accept_at_t1_when_confident`: judge returns 0.92 → cascade accepts at T1, no escalation.
- `test_escalate_t1_to_t2_when_low`: judge returns 0.70 → escalate to T2.
- `test_escalate_t2_to_t3`: T1 score 0.70, T2 score 0.72 → escalate to T3.
- `test_max_tier_depth_respected`: T3 also fails → returns T3 response with confidence < threshold.
- `test_time_budget_exceeded`: 10 tiers queued, time budget 1s → returns after 1s with whatever response was last.
- `test_verifier_failure_treated_as_below_threshold`: judge raises → escalate.
- `test_aroute_uses_auto_mix`: monkeypatch `AutoMixLoop`; assert `route()` invokes it (only async path).

### 3.7 Perf SLA

- AutoMix adds **1 verifier LLM call per tier tried** (T1 verifier +
  T2 verifier if T1 fails). Total verifier calls ≤ 3.
- Verifier is a slot="fast" call (T1 model, ~80ms p50, ~200ms p99).
- Net added latency: 80-200ms p99 for the common 1-tier accept case.
- Hard time budget: 60s — over-budget returns the best-so-far response.

---

## 4. Sub-Component 8d — Per-Step Cost Z-Score

**Why this matters:** the existing Cat 8 cost anomaly detector
(`src/eden/services/cost_intel/efficiency.py:CostAnomalyDetector`)
flags **daily** cost outliers — too coarse to catch a runaway step
within a single multi-agent trace. Phase 8 adds **per-step** z-score
anomaly detection that fires *during* the trace (before the user
sees the bill).

### 4.1 Algorithm — `PerStepCostZScore`

The z-score uses a rolling 7-day window per (org_id, agent_id,
step_type). The window is maintained via **Welford's online algorithm**
(Welford 1962) for numerically stable mean and variance.

```python
import math
from collections import deque
from dataclasses import dataclass

ZSCORE_WINDOW_DAYS = 7
ZSCORE_FLAG_THRESHOLD = 3.0       # |z| > 3 → flag
ZSCORE_FIRE_THRESHOLD = 4.0       # |z| > 4 → fire drift hook
ZSCORE_MIN_SAMPLES = 30          # need ≥30 samples for stable σ
ZSCORE_PERSIST_BLOOM = 2000      # max samples per (org, agent, step_type) tuple


@dataclass
class WindowedStats:
    """Welford's online mean + variance for cost per step."""
    n: int = 0
    mean: float = 0.0
    m2: float = 0.0                # sum of squared deviations

    def update(self, x: float) -> None:
        """O(1) update — numerically stable for n > 1e6."""
        self.n += 1
        delta = x - self.mean
        self.mean += delta / self.n
        delta2 = x - self.mean
        self.m2 += delta * delta2

    @property
    def variance(self) -> float:
        return self.m2 / (self.n - 1) if self.n > 1 else 0.0

    @property
    def stddev(self) -> float:
        return math.sqrt(self.variance)


@dataclass
class ZScoreResult:
    step_cost_usd: float
    zscore: float
    flagged: bool                  # |z| > 3
    fire_hook: bool                # |z| > 4
    window_n: int
    window_mean_usd: float
    window_stddev_usd: float


class PerStepCostZScore:
    """Rolling per-step cost z-score with drift-hook firing.

    Window is (org_id, agent_id, step_type) → WindowedStats. The
    stats live in process memory + a Postgres-backed snapshot
    table for crash recovery.
    """

    def __init__(self):
        # In-memory cache of WindowedStats; flushed to Postgres
        # every 5 minutes via background task.
        self._windows: dict[tuple[str, str, str], WindowedStats] = {}

    def update_and_score(
        self,
        *,
        org_id: str,
        agent_id: str,
        step_type: str,            # "llm_call" | "tool_call" | "retrieval"
        step_cost_usd: float,
    ) -> ZScoreResult:
        """Atomically update the rolling window and return the z-score."""
        key = (org_id, agent_id, step_type)
        stats = self._windows.get(key) or WindowedStats()
        # Compute z-score against the window BEFORE this update (so
        # the current point isn't included in its own baseline)
        z = 0.0
        if stats.n >= ZSCORE_MIN_SAMPLES and stats.stddev > 0:
            z = (step_cost_usd - stats.mean) / stats.stddev
        # Now update the window with the current point
        stats.update(step_cost_usd)
        self._windows[key] = stats

        result = ZScoreResult(
            step_cost_usd=step_cost_usd,
            zscore=z,
            flagged=abs(z) > ZSCORE_FLAG_THRESHOLD,
            fire_hook=abs(z) > ZSCORE_FIRE_THRESHOLD,
            window_n=stats.n,
            window_mean_usd=stats.mean,
            window_stddev_usd=stats.stddev,
        )

        if result.fire_hook:
            # Phase 8 8d — fire drift hook
            self._fire_drift_alert(org_id, agent_id, step_type, result)

        return result

    def _fire_drift_alert(
        self, org_id: str, agent_id: str, step_type: str, result: ZScoreResult,
    ) -> None:
        """Fire PromotionHook.on_drift_alert for a high-severity cost anomaly.

        Mirrors _fire_cost_anomaly_alert in
        src/eden/services/cost_intel/_common.py:564. Drift type is
        "cost_anomaly:runaway_step" so the alert can be grepped.
        """
        try:
            from eden.llmops.promotion_hooks import get_promotion_hook
            hook = get_promotion_hook()
            direction = "above" if result.zscore > 0 else "below"
            hook.on_drift_alert(
                org_id,
                drift_type="cost_anomaly:runaway_step",
                severity="high",
            )
        except Exception:
            pass  # hook is best-effort

    def flush_to_db(self) -> None:
        """Persist the in-memory windows to Postgres (called by background
        task every 5 min; on cold start we hydrate from DB)."""
        try:
            from eden.db_bootstrap import get_engine
            from sqlalchemy import text
            engine = get_engine()
            with engine.begin() as conn:
                for (org_id, agent_id, step_type), stats in self._windows.items():
                    conn.execute(
                        text("""
                            INSERT INTO per_step_cost_windows
                                (org_id, agent_id, step_type, n, mean, m2, updated_at)
                            VALUES (:org_id, :agent_id, :step_type, :n, :mean, :m2, NOW())
                            ON CONFLICT (org_id, agent_id, step_type) DO UPDATE SET
                                n = EXCLUDED.n,
                                mean = EXCLUDED.mean,
                                m2 = EXCLUDED.m2,
                                updated_at = NOW()
                        """),
                        {
                            "org_id": org_id,
                            "agent_id": agent_id,
                            "step_type": step_type,
                            "n": stats.n,
                            "mean": stats.mean,
                            "m2": stats.m2,
                        },
                    )
        except Exception as exc:
            logger.warning("flush_to_db failed: %s", exc)
```

### 4.2 Integration with Telemetry

The `telemetry_collector.py:78` `cache_hit` pattern is mirrored — every
LLM/tool step emits its z-score alongside the cost:

```python
# In the LLM call path (after response):
from eden.optimization.cost_anomaly import get_per_step_zscore

zscore_engine = get_per_step_zscore()
result = zscore_engine.update_and_score(
    org_id=org_id,
    agent_id=agent_id,
    step_type="llm_call",
    step_cost_usd=response.usage.cost or 0.0,
)
event = TelemetryEvent(
    ...,
    cost_usd=response.usage.cost,
    cost_zscore=result.zscore,
    cost_zscore_flagged=result.flagged,
)
```

The existing `cache_hit` and `prompt_cache_savings_usd` columns aren't
repurposed — we add `cost_zscore: float | None` and
`cost_zscore_flagged: bool | None` (migration 028).

### 4.3 Drift Hook

Mirrors `_fire_cost_anomaly_alert` at `src/eden/services/cost_intel/_common.py:564`:

- Drift type: `cost_anomaly:runaway_step` (matches the grep pattern).
- Severity: `"high"` for |z| > 4 (only this triggers the hook).
- Payload includes `(org_id, agent_id, step_type, cost_usd, zscore)` for
  the canary auto-rollback (Phase 17 closed-loop hook consumer).

### 4.4 Expected Savings

This sub-component **prevents overruns**, not reduces steady-state cost.
The savings are real but indirect — a single runaway step caught at
|z|=4.2 saves the customer the cost of the rest of the trace
(avg $0.30/trace × ~5 runs/day × 30 days = **~$45/customer/month**
prevented waste). At 100 customers → **~$4.5k/month** prevented cost
overruns.

### 4.5 Edge Cases

| Case | Mitigation |
|---|---|
| **Cold start — window < 30 samples** | `z=0.0`, no flag (insufficient data). |
| **Bimodal cost distribution** (some prompts cost $0.001, others $0.50) | Welford's variance reflects the bimodality; z-score still flags true outliers. |
| **σ = 0** (all steps identical cost) | `stats.stddev > 0` guard returns z=0 (no false runaway flags on flat distributions). |
| **Cost spikes are legitimate** (one user has a heavy prompt) | Drift alert is high-severity only; customer can ack via the portal and the next 24h of similar costs gets a "known spike" exemption. |
| **Negative cost** (cache credit > cost) | Allowed; Welford handles it. The drift alert fires only on |z| > 4 in EITHER direction. |
| **Cross-tenant isolation** | `_windows` keyed by (org_id, agent_id, step_type); no cross-tenant leakage. |

### 4.6 Tests

- `test_zscore_zero_for_first_samples`: first 29 updates → all z=0.0 (n < 30).
- `test_zscore_positive_outlier`: 100 samples μ=$0.01, σ=$0.001; insert $0.10 → z ≈ 90 → flag + fire.
- `test_zscore_negative_outlier`: insert $0.0001 → z ≈ -9 → flag + fire.
- `test_welford_numerical_stability`: insert 1M samples of $0.001 → mean ≈ 0.001, stddev ≈ 0.
- `test_drift_hook_fired_at_z_gt_4`: monkeypatch `PromotionHook.on_drift_alert`; insert outlier → hook called once with `drift_type="cost_anomaly:runaway_step"`.
- `test_no_fire_at_z_eq_3`: z=3.1 → `flagged=True`, `fire_hook=False`.
- `test_flush_to_db_round_trip`: insert 100 samples → flush → wipe in-memory → rehydrate from DB → assert identical mean/stddev.

### 4.7 Perf SLA

- `update_and_score` is O(1) per call (Welford is O(1)).
- In-memory window dict: ≤ 2000 entries × (org, agent, step_type) ≈ 1MB.
- Flush to DB: 5-minute background task; bulk insert via `executemany` for
  batched 200ms p99.

---

## 5. Sub-Component 8e — LLMLingua-2 Integration

**Why LLMLingua-2?** The existing `PromptCompressor` at
`src/eden/optimization/token_optimizer.py:19` does whitespace cleanup +
middle-truncation — no semantic compression. On long-context RAG prompts
(>2K tokens), LLMLingua-2 achieves **5× compression with 80%+ of original
task performance preserved** (Pan et al. 2023, arXiv 2310.05736), vs the
~1.2× the existing compressor achieves.

### 5.1 LLMLingua-2 Background (Pan et al. 2023)

LLMLingua-2 replaces the original LLMLingua's iterative token-removal
with a **single-pass bidirectional classifier**:

- **Architecture:** XLM-RoBERTa-base (270M params) trained as a binary
  classifier on (preserve / remove) over token positions.
- **Input:** the prompt.
- **Output:** per-token probability of preservation.
- **Compress:** keep tokens with p > threshold; preserve order.
- **Improvement over LLMLingua:** ~3× faster (no iterative LLM call),
  better preservation of key information, supports any language.

The Microsoft reference implementation is at
[microsoft/LLMLingua](https://github.com/microsoft/LLMLingua) (MIT
license). We wrap it behind `LLMLingua2Compressor` in
`src/eden/llmops/prompt_compressor.py` and replace the existing
`PromptCompressor` usage in `token_optimizer.py`.

### 5.2 Algorithm — `LLMLingua2Compressor.compress()`

```python
from dataclasses import dataclass
from typing import Optional

LLMLINGUA2_MIN_TOKENS = 512            # don't compress shorter prompts
LLMLINGUA2_TARGET_COMPRESSION = 5.0    # 5× ratio
LLMLINGUA2_MIN_COMPRESSION = 2.0       # floor at 2× even if quality good
LLMLINGUA2_MODEL_NAME = "microsoft/llmlingua-2-xlm-roberta-large"
LLMLINGUA2_FALLBACK_PROMPT = "..."     # used when model load fails


@dataclass
class CompressionResult:
    original_tokens: int
    compressed_tokens: int
    compression_ratio: float            # original / compressed
    kept_pct: float                    # fraction of tokens preserved
    model_used: str                     # "llmlingua-2" | "fallback"


class LLMLingua2Compressor:
    """LLMLingua-2 wrapper replacing PromptCompressor.

    Threshold is auto-tuned per call to hit the target compression
    ratio while keeping task performance within 5% of the uncompressed
    baseline (validated via the Cat 9 BehaviouralDashboard reward
    signal in §3 below).
    """

    def __init__(
        self,
        target_ratio: float = LLMLINGUA2_TARGET_COMPRESSION,
        min_tokens: int = LLMLINGUA2_MIN_TOKENS,
    ):
        self.target_ratio = target_ratio
        self.min_tokens = min_tokens
        self._model = None
        self._tokenizer = None

    def _load(self) -> None:
        if self._model is None:
            try:
                from llmlingua import PromptCompressor as _LLMPromptCompressor
                self._model = _LLMPromptCompressor(
                    model_name=LLMLINGUA2_MODEL_NAME,
                    device_map="cpu",       # GPU reserved for upstream LLM
                )
            except ImportError:
                logger.warning(
                    "llmlingua not installed; compressor will no-op"
                )
                self._model = None

    def estimate_tokens(self, text: str) -> int:
        """Rough token count (~4 chars/token for English)."""
        return max(1, len(text) // 4)

    def compress(self, prompt: str, max_tokens: Optional[int] = None) -> CompressionResult:
        """Compress a prompt to fit ``max_tokens`` (or hit target ratio)."""
        original_tokens = self.estimate_tokens(prompt)

        # Short-circuit: small prompts are not worth compressing
        if original_tokens < self.min_tokens:
            return CompressionResult(
                original_tokens=original_tokens,
                compressed_tokens=original_tokens,
                compression_ratio=1.0,
                kept_pct=1.0,
                model_used="passthrough",
            )

        # Phase 8 8e — LLMLingua-2 path
        self._load()
        if self._model is None:
            return self._fallback_compress(prompt, original_tokens)

        # Compute target compressed length
        if max_tokens:
            target = min(max_tokens, int(original_tokens / self.target_ratio))
        else:
            target = int(original_tokens / self.target_ratio)

        try:
            import asyncio
            loop = asyncio.get_event_loop()
            result = loop.run_until_complete(
                asyncio.wait_for(
                    loop.run_in_executor(
                        None,
                        lambda: self._model.compress_prompt(
                            prompt,
                            target_token=target,
                        ),
                    ),
                    timeout=10.0,
                )
            )
            compressed = result["compressed_prompt"]
            compressed_tokens = self.estimate_tokens(compressed)
            return CompressionResult(
                original_tokens=original_tokens,
                compressed_tokens=compressed_tokens,
                compression_ratio=original_tokens / max(1, compressed_tokens),
                kept_pct=compressed_tokens / original_tokens,
                model_used="llmlingua-2",
            )
        except Exception as exc:
            logger.warning("LLMLingua-2 compress failed: %s; using fallback", exc)
            return self._fallback_compress(prompt, original_tokens)

    def _fallback_compress(self, prompt: str, original_tokens: int) -> CompressionResult:
        """Whitespace + middle-truncate fallback when LLMLingua-2 unavailable.

        Same as the old PromptCompressor — preserves backward compat.
        """
        import re
        text = re.sub(r"[ \t]+", " ", prompt)
        text = re.sub(r"\n{3,}", "\n\n", text)
        target = int(original_tokens / LLMLINGUA2_MIN_COMPRESSION)
        target_chars = target * 4
        if len(text) > target_chars:
            half = target_chars // 2
            text = text[:half] + "\n\n... [truncated] ...\n\n" + text[-half:]
        compressed_tokens = self.estimate_tokens(text)
        return CompressionResult(
            original_tokens=original_tokens,
            compressed_tokens=compressed_tokens,
            compression_ratio=original_tokens / max(1, compressed_tokens),
            kept_pct=compressed_tokens / original_tokens,
            model_used="fallback",
        )
```

### 5.3 Integration — Replacing `PromptCompressor`

The hook is in `token_optimizer.py` — `ContextWindowManager.build_prompt()`
calls `PromptCompressor.compress()` to fit the budget. Phase 8 swaps the
class:

```python
# src/eden/optimization/token_optimizer.py — patched
from eden.llmops.prompt_compressor import LLMLingua2Compressor

class ContextWindowManager:
    def __init__(self, max_tokens: int = 32000):
        self.max_tokens = max_tokens
        self.compressor = LLMLingua2Compressor()  # ← was PromptCompressor()

    def build_prompt(self, system_prompt, history, new_message):
        # ... existing logic builds the prompt ...
        full_prompt = "\n\n".join(parts)
        # Phase 8 8e — compress the assembled prompt to fit the budget
        if self.estimate_tokens(full_prompt) > self.max_tokens:
            compressed = self.compressor.compress(
                full_prompt, max_tokens=self.max_tokens,
            )
            return compressed
        return full_prompt
```

### 5.4 Expected Savings

On the synthetic dataset (15 traces with > 2K-token RAG context):

| Compressor | Avg ratio | Avg saved tokens/trace |
|---|---|---|
| Old `PromptCompressor` (whitespace + truncate) | 1.2× | ~360 |
| **LLMLingua-2 (Phase 8)** | **5.0×** | **~1,600** |

Cost per 1K input tokens (Claude Sonnet tier 2): $0.003.
**Projected Phase 8 8e savings:** 1,600 × $0.003/1K = **$0.0048/trace**,
or **~30-60% of long-context input cost** (matches main spec).

### 5.5 Edge Cases

| Case | Mitigation |
|---|---|
| **LLMLingua-2 model load fails** | Falls back to whitespace + middle-truncate (1.2× ratio). Logs a warning. |
| **Compress timeout** (>10s) | `asyncio.wait_for` aborts; returns fallback result. |
| **Compression breaks the prompt** (removes a system instruction) | Wrap system prompts with `<SYSTEM>` tags; the LLMLingua-2 tokenizer is trained to recognise these. Validation: re-run the validator; if score drops > 5%, disable compression for that prompt template. |
| **Multi-lingual prompts** | XLM-RoBERTa handles 100+ languages; no special config. |
| **Code blocks** | LLMLingua-2 can preserve code blocks via the `preserve_code=True` option. Default on. |
| **Very short prompts (<512 tokens)** | `passthrough` — compressor skipped. |

### 5.6 Tests

- `test_compress_short_prompt_passthrough`: 100-token prompt → result kept_pct=1.0.
- `test_compress_long_prompt_5x`: 5000-token prompt → compression_ratio ≥ 4.5.
- `test_compress_preserves_system_prompt`: input with `<SYSTEM>...</SYSTEM>` block → output still contains the block.
- `test_compress_preserves_code_blocks`: input with 3 code blocks → output still contains all 3.
- `test_compress_fallback_when_model_missing`: monkeypatch `_load` to fail → result `model_used="fallback"`, ratio ≥ 2.0.
- `test_compress_timeout_falls_back`: monkeypatch `compress_prompt` to sleep 15s → result `model_used="fallback"`.
- `test_ContextWindowManager_uses_llmlingua2`: monkeypatch `LLMLingua2Compressor.compress`; build_prompt over budget → invokes compressor.

### 5.7 Perf SLA

- LLMLingua-2 inference on CPU (XLM-RoBERTa-large, 270M params):
  ~1.5s for 2K-token prompt, ~6s for 8K-token prompt.
- Timeout: 10s (per-call, configurable).
- Memory: ~1.2GB RSS on first load; lazy load, single-instance shared
  across requests.
- Net latency on long-context RAG: prompt-assembly 0.5s + compress 1.5s
  = 2s p50; upstream LLM unchanged.

---

## 6. Sub-Component 8f — BatchRunner

**Why batch?** OpenAI and Anthropic both offer Batch APIs that are **50%
cheaper** than realtime, with the trade-off being **up to 24h latency**
and a separate polling-style completion flow. The Cat 3 nightly judge
re-runs are the perfect candidate — they're scheduled, latency-tolerant,
and run hundreds to thousands of evaluations per night.

### 6.1 Background — Batch APIs

[OpenAI Batch API](https://platform.openai.com/docs/guides/batch):
- 50% discount on all token costs.
- Submit a JSONL file of requests; poll for completion; download results.
- 24h SLA, but typically completes in 1-6h.

[Anthropic Message Batches API](https://docs.anthropic.com/en/api/creating-message-batches):
- Same 50% discount.
- Submit a list of message requests; poll; results returned as a
  streaming-friendly batch.

Both expose `batch_id`, `status` (`validating` / `in_progress` /
`completed` / `failed` / `expired` / `cancelled`), and per-request
results on completion.

### 6.2 Algorithm — `BatchRunner`

```python
import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# ── Tunable constants ───────────────────────────────────────────────

BATCH_POLL_INTERVAL_S = 60          # how often to check batch status
BATCH_MAX_WAIT_S = 24 * 3600        # 24h OpenAI SLA
BATCH_DOWNLOAD_DIR = Path("/tmp/eden_batch")
BATCH_MAX_REQUESTS_PER_BATCH = 50_000  # OpenAI limit
BATCH_CHUNK_SIZE = 5_000             # split large jobs into chunks


class BatchStatus(Enum):
    VALIDATING = "validating"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    EXPIRED = "expired"
    CANCELLED = "cancelled"


@dataclass
class BatchJob:
    """One LLM call to be submitted to the batch API."""
    custom_id: str                    # "<org>:<trace>:<judge_id>" — for hydration
    model: str                        # "openai/gpt-4o-mini" | "anthropic/claude-..."
    messages: list[dict[str, Any]]
    max_tokens: int = 1024
    temperature: float = 0.0          # determinism for judges


@dataclass
class BatchSubmission:
    """Result of submitting a batch."""
    batch_id: str
    provider: str                     # "openai" | "anthropic"
    n_requests: int
    submitted_at: datetime
    expected_completion_at: datetime  # +24h


@dataclass
class BatchResult:
    """Hydrated result of a batch."""
    custom_id: str
    content: str
    usage: dict[str, int]
    cost_usd: float
    error: str | None = None


class BatchRunner:
    """Submits and polls OpenAI/Anthropic Batch API jobs.

    Used by the nightly Cat 3 judge re-run cron — 50% cost reduction
    vs realtime.

    The runner is async-aware but wraps sync SDK calls in
    ``run_in_executor`` so the event loop stays free.
    """

    def __init__(
        self,
        openai_client: Any | None = None,
        anthropic_client: Any | None = None,
    ):
        self.openai = openai_client
        self.anthropic = anthropic_client
        BATCH_DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

    async def submit(
        self,
        jobs: list[BatchJob],
        *,
        provider: str | None = None,
        metadata: dict[str, str] | None = None,
    ) -> BatchSubmission:
        """Submit a batch to the appropriate provider's Batch API.

        ``provider`` is auto-detected from the first job's model if
        not specified. Large jobs are split into chunks of
        BATCH_MAX_REQUESTS_PER_BATCH.
        """
        if not jobs:
            raise ValueError("empty jobs list")

        # Auto-detect provider
        if provider is None:
            provider = self._detect_provider(jobs[0].model)

        # Chunk large jobs
        chunks = [
            jobs[i:i + BATCH_CHUNK_SIZE]
            for i in range(0, len(jobs), BATCH_CHUNK_SIZE)
        ]
        # Phase 8 8f — submit each chunk as a separate batch
        first_batch_id: str | None = None
        for chunk in chunks:
            batch_id = await self._submit_chunk(chunk, provider, metadata)
            if first_batch_id is None:
                first_batch_id = batch_id

        return BatchSubmission(
            batch_id=first_batch_id,
            provider=provider,
            n_requests=len(jobs),
            submitted_at=datetime.now(UTC),
            expected_completion_at=datetime.now(UTC).timestamp() + BATCH_MAX_WAIT_S,
        )

    async def _submit_chunk(
        self,
        chunk: list[BatchJob],
        provider: str,
        metadata: dict[str, str] | None,
    ) -> str:
        """Submit one chunk as a JSONL file (OpenAI) or message-batch (Anthropic)."""
        loop = asyncio.get_event_loop()

        if provider == "openai":
            # Phase 8 8f — write JSONL, upload, create batch
            jsonl_path = BATCH_DOWNLOAD_DIR / f"batch_{int(time.time())}.jsonl"
            with open(jsonl_path, "w") as f:
                for job in chunk:
                    row = {
                        "custom_id": job.custom_id,
                        "method": "POST",
                        "url": "/v1/chat/completions",
                        "body": {
                            "model": job.model.removeprefix("openai/"),
                            "messages": job.messages,
                            "max_tokens": job.max_tokens,
                            "temperature": job.temperature,
                        },
                    }
                    f.write(json.dumps(row) + "\n")
            return await loop.run_in_executor(
                None, lambda: self._submit_openai_jsonl(jsonl_path, metadata),
            )

        if provider == "anthropic":
            # Phase 8 8f — Anthropic's batch API takes a list of requests
            requests = [
                {
                    "custom_id": job.custom_id,
                    "params": {
                        "model": job.model.removeprefix("anthropic/"),
                        "messages": job.messages,
                        "max_tokens": job.max_tokens,
                    },
                }
                for job in chunk
            ]
            return await loop.run_in_executor(
                None, lambda: self._submit_anthropic_batch(requests, metadata),
            )

        raise ValueError(f"unsupported provider: {provider}")

    def _submit_openai_jsonl(self, path: Path, metadata: dict | None) -> str:
        """Sync helper: upload JSONL + create batch on OpenAI."""
        import openai
        with open(path, "rb") as f:
            file = self.openai.files.create(file=f, purpose="batch")
        batch = self.openai.batches.create(
            input_file_id=file.id,
            endpoint="/v1/chat/completions",
            completion_window="24h",
            metadata=metadata or {},
        )
        return batch.id

    def _submit_anthropic_batch(
        self, requests: list[dict], metadata: dict | None,
    ) -> str:
        """Sync helper: create message batch on Anthropic."""
        batch = self.anthropic.messages.batches.create(requests=requests)
        return batch.id

    async def poll(self, batch_id: str, provider: str) -> BatchStatus:
        """Poll until the batch completes (or fails)."""
        loop = asyncio.get_event_loop()
        deadline = time.time() + BATCH_MAX_WAIT_S
        while time.time() < deadline:
            if provider == "openai":
                status = await loop.run_in_executor(
                    None, lambda: self.openai.batches.retrieve(batch_id),
                )
                state = status.status
            elif provider == "anthropic":
                status = await loop.run_in_executor(
                    None, lambda: self.anthropic.messages.batches.retrieve(batch_id),
                )
                state = status.processing_status
            else:
                raise ValueError(f"unsupported provider: {provider}")

            if state in ("completed",):
                return BatchStatus.COMPLETED
            if state in ("failed", "expired", "cancelled"):
                return BatchStatus(state)
            await asyncio.sleep(BATCH_POLL_INTERVAL_S)
        return BatchStatus.EXPIRED

    async def hydrate(
        self, batch_id: str, provider: str,
    ) -> list[BatchResult]:
        """Download results from a completed batch."""
        loop = asyncio.get_event_loop()
        if provider == "openai":
            batch = await loop.run_in_executor(
                None, lambda: self.openai.batches.retrieve(batch_id),
            )
            output_file_id = batch.output_file_id
            content = await loop.run_in_executor(
                None,
                lambda: self.openai.files.content(output_file_id).read(),
            )
            return [self._parse_openai_row(line) for line in content.splitlines()]
        if provider == "anthropic":
            # Anthropic returns results_url; stream + parse
            batch = await loop.run_in_executor(
                None, lambda: self.anthropic.messages.batches.retrieve(batch_id),
            )
            results_url = batch.results_url
            # ... download + parse JSONL ...
            return []
        raise ValueError(f"unsupported provider: {provider}")

    def _parse_openai_row(self, line: bytes) -> BatchResult:
        row = json.loads(line)
        body = row.get("response", {}).get("body", {})
        choices = body.get("choices", [])
        content = choices[0]["message"]["content"] if choices else ""
        usage = body.get("usage", {})
        # OpenAI batch pricing is 50% of realtime — multiply by 0.5
        cost = self._estimate_openai_cost(
            body.get("model", ""),
            usage.get("prompt_tokens", 0),
            usage.get("completion_tokens", 0),
        ) * 0.5
        return BatchResult(
            custom_id=row.get("custom_id", ""),
            content=content,
            usage=usage,
            cost_usd=cost,
            error=row.get("error"),
        )

    def _estimate_openai_cost(
        self, model: str, prompt_tokens: int, completion_tokens: int,
    ) -> float:
        # Phase 8 8f — use the same cost-per-1k table as realtime,
        # then the caller multiplies by 0.5 for batch pricing.
        from eden.llm.model_registry import get_model_price
        price = get_model_price(model)
        return (
            prompt_tokens / 1000.0 * price.input_per_1k
            + completion_tokens / 1000.0 * price.output_per_1k
        )

    def _detect_provider(self, model: str) -> str:
        if model.startswith("openai/"):
            return "openai"
        if model.startswith("anthropic/"):
            return "anthropic"
        raise ValueError(f"cannot detect provider from model: {model}")
```

### 6.3 Integration — Cat 3 Nightly Re-run

The nightly Cat 3 judge cron (`src/eden/llmops/judges/runner.py:nightly_job`)
extends to use `BatchRunner`:

```python
# src/eden/llmops/judges/runner.py — patched nightly_job
async def nightly_job():
    judge_rows = await fetch_pending_judge_evaluations()
    jobs = [
        BatchJob(
            custom_id=f"{row.org_id}:{row.trace_id}:{row.judge_id}",
            model=row.model,
            messages=row.messages,
            max_tokens=row.max_tokens,
            temperature=0.0,
        )
        for row in judge_rows
    ]
    if not jobs:
        return
    runner = BatchRunner(openai_client=..., anthropic_client=...)
    submission = await runner.submit(jobs, metadata={"job": "cat3_nightly"})
    # Persist submission so the morning poll can pick it up
    await db.execute(
        "INSERT INTO batch_submissions (batch_id, provider, n_requests, "
        "submitted_at, expected_completion_at, job_kind) VALUES (...)",
        submission,
    )
    # Schedule a follow-up poll for the morning cron
    scheduler.schedule(
        at=submission.expected_completion_at,
        callback="poll_and_hydrate_batch",
        kwargs={"batch_id": submission.batch_id, "provider": submission.provider},
    )
```

### 6.4 Expected Savings

Cat 3 nightly re-runs are ~5K judge calls/night on the synthetic dataset.
Average cost: $0.002/call (T1 model + small prompts).

- **Realtime cost:** 5,000 × $0.002 = **$10/night**.
- **Batch cost:** $10 × 0.5 = **$5/night**.
- **Saved:** **$5/night = $150/month**.

Scales linearly with judge-call volume; at 100K calls/night (production
load), savings are **~$3k/month**.

### 6.5 Edge Cases

| Case | Mitigation |
|---|---|
| **Batch fails mid-flight** | `BatchStatus.FAILED` → fall back to realtime retry for the failed chunks (chunk-level retry by `custom_id`). |
| **Batch expires after 24h** | Partial results are downloadable; unfinished requests are billed at realtime rates and re-queued. |
| **Network error during upload** | Retry with exponential backoff up to 3 times. |
| **Mixed-provider batch** | Split into per-provider batches; submit both. |
| **Custom_id collision** | Use the canonical `<org>:<trace>:<judge_id>` format; collisions are intentional idempotency markers. |
| **JSONL too large** | Auto-chunk at BATCH_MAX_REQUESTS_PER_BATCH per OpenAI limit. |
| **Anthropic results_url 404** | Poll again after BATCH_POLL_INTERVAL_S; results_url is set on completion. |

### 6.6 Tests

- `test_submit_openai_chunk`: 100 jobs → JSONL written, batch created, batch_id returned.
- `test_submit_anthropic_chunk`: 100 jobs → batch created with messages.batches.create.
- `test_detect_provider`: model "openai/gpt-4o-mini" → "openai"; "anthropic/claude-..." → "anthropic".
- `test_poll_completes`: monkeypatch retrieve to return status="completed" on 3rd call → BatchStatus.COMPLETED.
- `test_poll_expires_after_24h`: monkeypatch `time.time()` to jump past deadline → BatchStatus.EXPIRED.
- `test_hydrate_openai`: build mock JSONL with 3 rows → hydrate returns 3 BatchResults with correct content + cost (with 0.5 multiplier).
- `test_chunk_split_at_5000`: 12K jobs → 3 batches created (5K + 5K + 2K).
- `test_batch_failure_falls_back_to_realtime`: status="failed" → submission marked failed, partial jobs re-queued via realtime.

### 6.7 Perf SLA

- Submit: ≤ 30s for 50K jobs (uploads are network-bound).
- Poll interval: 60s (configurable).
- Hydrate: ≤ 60s for 50K results (streaming JSONL parse).
- Failure detection: ≤ 2 minutes (status is updated by OpenAI/Anthropic
  every 30-60s typically).
- Cost savings: 50% per call (vendor-enforced).

---

## 7. Integration Summary

### 7.1 File Layout

```
NEW FILES
  src/eden/optimization/semantic_cache.py     — 8a MultiTierSemanticCache + L2 Bloom + L4 ALBERT
  src/eden/optimization/cost_anomaly.py       — 8d PerStepCostZScore + Welford
  src/eden/optimization/batch_runner.py       — 8f BatchRunner
  src/eden/llmops/prompt_compressor.py        — 8e LLMLingua2Compressor
  src/eden/optimization/provider_cache.py    — 8b extract_provider_cache helper
  db_migrations/versions/028_per_step_cost_zscore.sql — 8d windows table

EXTENDED FILES
  src/eden/llm/client.py                      — 8a cache lookup; 8b UsageStats fields
  src/eden/observability/telemetry_collector.py — 8d cost_zscore fields; 8b prompt_cache_savings
  src/eden/optimization/model_router.py       — 8c AutoMixLoop replacing _get_fallback_chain
  src/eden/optimization/token_optimizer.py    — 8e swap PromptCompressor → LLMLingua2Compressor
  src/eden/llmops/judges/runner.py            — 8f nightly_job uses BatchRunner
  src/eden/services/cost_intel/_common.py     — 8d ZSCORE constants + hook firing
  src/eden/config.py                          — 8a/8c/8d/8e/8f Settings flags
```

### 7.2 OpenRouterClient Extension (Detailed)

The cache integration in `OpenRouterClient` is the highest-traffic
change — every LLM call flows through it. The hook is at `call()`
(`src/eden/llm/client.py:297`) and `acall()` (line 215):

```python
# src/eden/llm/client.py — patched call()
def call(self, agent, prompt, slot="reasoning", system_prompt=None,
         model=None, **kwargs):
    # Phase 8 8a — multi-tier semantic cache (sync path)
    if not getattr(self, "_cache_disabled", False):
        cache = self._get_semantic_cache()
        try:
            result = asyncio.get_event_loop().run_until_complete(
                cache.lookup(prompt, model or self.MODEL_SLOTS[slot].primary,
                             kwargs.get("temperature", 0.7),
                             kwargs.get("max_tokens", 4096),
                             system_prompt)
            )
            if result.hit:
                # Phase 8 8b — surface provider-cache savings (zero here,
                # since this is a synthetic cache hit, not a provider hit)
                self._emit_cache_hit(result, agent)
                return result.response
        except Exception as exc:
            logger.debug("semantic_cache.lookup failed: %s", exc)
            # Cache failure must NEVER break the LLM call

    # Phase 8 8e — long-context prompt compression
    if estimate_tokens(prompt) > LLMLINGUA2_MIN_TOKENS:
        compressor = self._get_compressor()
        compressed = compressor.compress(prompt, max_tokens=kwargs.get("max_tokens"))
        if compressed.compression_ratio > 1.5:
            prompt = compressed.compressed_text
            # Track compression stats on the response

    # ── Existing call path ─────────────────────────────────────────
    response = self._make_request(...)
    # Phase 8 8b — extract provider-cache savings
    ext = extract_provider_cache(
        provider=_provider_for_model(model or self.MODEL_SLOTS[slot].primary),
        usage=response.usage,
        cost_per_1k_input_usd=model_config.cost_per_1k_input,
    )
    response.usage.cache_reads = ext.cached_input_tokens
    response.usage.cache_writes = ext.cache_creation_tokens
    response.usage.cache_read_input_tokens = ext.cache_read_input_tokens
    response.usage.cache_creation_input_tokens = ext.cache_creation_tokens
    response.usage.cache_write_cost_usd = ext.cache_write_cost_usd

    # Phase 8 8a — store the fresh response in all 4 tiers
    try:
        asyncio.get_event_loop().run_until_complete(
            cache.store(prompt, model or ..., response, ...)
        )
    except Exception:
        pass

    # Phase 8 8d — record per-step z-score
    zscore_engine = get_per_step_zscore()
    zscore_engine.update_and_score(
        org_id=kwargs.get("org_id", "default"),
        agent_id=agent,
        step_type="llm_call",
        step_cost_usd=response.usage.cost or 0.0,
    )

    return response
```

### 7.3 ModelRouter Refactor

The fix is at `model_router.py:570` — `_get_fallback_chain` becomes a
thin shim that returns the candidate tier list; `AutoMixLoop` owns the
cascading decision. The sync `route()` keeps the existing fixed-order
behaviour (no judge in sync path).

### 7.4 Settings

New env vars (added to `src/eden/config.py`):

```python
# Phase 8 — cost optimization
semantic_cache_enabled: bool = True
semantic_cache_l1_ttl_seconds: int = 3600
semantic_cache_l3_threshold: float = 0.92
semantic_cache_l4_threshold: float = 0.85
auto_mix_enabled: bool = True
auto_mix_quality_threshold: float = 0.85
auto_mix_max_tier_depth: int = 3
auto_mix_time_budget_s: float = 60.0
llmlingua2_enabled: bool = True
llmlingua2_target_ratio: float = 5.0
llmlingua2_min_tokens: int = 512
batch_runner_enabled: bool = True
batch_runner_poll_interval_s: int = 60
cost_zscore_window_days: int = 7
cost_zscore_flag_threshold: float = 3.0
cost_zscore_fire_threshold: float = 4.0
cost_zscore_min_samples: int = 30
```

---

## 8. Test Plan (Detailed)

### 8.1 Unit Tests (per sub-component)

| Sub-component | Unit tests | Notes |
|---|---|---|
| 8a | 13 (see §1.9) | covers all 4 tiers + tenant isolation + FPR |
| 8b | 5 (see §2.5) | OpenAI + Anthropic + unknown provider |
| 8c | 7 (see §3.6) | accept / escalate / time budget / verifier failure |
| 8d | 7 (see §4.6) | Welford + drift hook + cold start |
| 8e | 7 (see §5.6) | passthrough + compress + fallback + code preservation |
| 8f | 8 (see §6.6) | submit + poll + hydrate + chunk split + failure fallback |
| **Total** | **47 unit tests** | — |

### 8.2 Integration Tests

- `test_OpenRouterClient_end_to_end_with_all_8_subcomponents`:
  monkeypatch all 6 sub-components; assert they fire in order:
  cache lookup → compress → AutoMix route → provider call → extract
  provider cache → store cache → record z-score.
- `test_ModelRouter_aroute_uses_AutoMixLoop`: mock AutoMixLoop; verify
  it's called with `start_tier` from classification.
- `test_nightly_cat3_uses_BatchRunner`: mock `BatchRunner.submit`;
  verify the cron creates a batch instead of realtime calls.

### 8.3 Adversarial Tests

- **Cache poisoning:** Tenant A stores prompt with PII; tenant B queries
  the same text → miss (tenant-scoped prefix). Tier isolation holds.
- **Bloom filter FPR:** After 1M inserts, declare 10K random misses →
  assert ≤ 110 are actually hits (FPR ≤ 1.1%).
- **AutoMix runaway:** verifier returns 0.99 forever → assert cascade
  accepts at T1 (no escalation loop).
- **AutoMix never-escalates:** verifier returns 0.50 forever → assert
  cascade escalates to T3 (capped by `max_tier_depth`).
- **Cost spike (legitimate):** insert 100 samples of $0.001, then 1
  sample of $10 → z ≈ 1000 → flag + fire. Confirm the spike is the
  intentional customer behaviour, not a system bug.
- **LLMLingua-2 timeout:** monkeypatch compress to sleep 15s → fallback
  path returns within 10.5s.
- **Batch API failure:** mock `openai.batches.create` to raise →
  runner catches + retries up to 3× then surfaces error.

### 8.4 Load Tests

- `MultiTierSemanticCache.lookup()` × 10K sequential → p99 < 90ms.
- `PerStepCostZScore.update_and_score()` × 100K → p99 < 0.5ms.
- `BatchRunner.submit()` with 50K jobs → completes in < 60s.
- `LLMLingua2Compressor.compress()` × 100 calls (8K-token prompts) →
  p99 < 12s (with timeout fallback at 10s).

### 8.5 Synthetic Dataset Coverage

The 30 synthetic traces must hit the following acceptance bars:

| Sub-component | Acceptance metric | Target |
|---|---|---|
| 8a | Cache hit rate on `cache-friendly-redundant-context` traces | ≥ 65% |
| 8b | `prompt_cache_savings_usd` > 0 on `provider-cache-friendly` traces | 100% |
| 8c | Avg LLM calls/multi-agent task on `cascade-decision-test` traces | ≤ 1.6 |
| 8d | Drift hook fires on `runaway-step-spike` trace | 100% |
| 8e | Compression ratio on `long-context-rag-5K-token` trace | ≥ 4.5× |
| 8f | Batch mode used for nightly judge re-runs | 100% |

---

## 9. Perf SLA + Projected Savings (Summary)

### 9.1 Per-Sub-Component SLA

| Sub-component | p50 latency added | p99 latency added | Throughput target |
|---|---|---|---|
| 8a semantic cache | 1-45ms | 3-90ms | 5K lookups/sec/worker |
| 8b provider extraction | < 1ms | < 5ms | (post-call only, no throughput cost) |
| 8c AutoMix (1-tier accept) | 80ms | 200ms | n/a |
| 8c AutoMix (full cascade) | 320ms | 800ms | n/a |
| 8d cost z-score | < 1ms | < 5ms | 50K updates/sec/worker |
| 8e LLMLingua-2 | 1.5s (CPU) | 10s (timeout) | 1 call/sec/worker |
| 8f BatchRunner submit | 5-30s | 60s | 50K requests/batch |

### 9.2 Projected Savings on Synthetic Dataset (30 traces)

| Sub-component | Savings/trace | % of total cost |
|---|---|---|
| 8a semantic cache (50% hit rate × 1800 tokens) | $0.0027 | ~32% |
| 8b provider extraction | (billing accuracy only) | — |
| 8c AutoMix (1.4 calls vs 2.8 baseline) | $0.0014 | ~17% |
| 8d cost z-score | (prevents overruns only) | — |
| 8e LLMLingua-2 (5× on >2K-token prompts) | $0.0048 (long-context only) | ~30-60% |
| 8f BatchRunner (50% off judge re-runs) | $0.005 (nightly judges) | ~50% of judge cost |

**Combined Phase 8 savings on the synthetic dataset: 40-65% of input-token
cost.** Top-decile traces (heavy RAG with repeated context) hit 70%+.

### 9.3 Cross-Sub-Component Interactions

- **8a + 8e:** cache lookup happens before compression. Compressed prompts
  are cached too — second call to a long-context RAG pipeline hits the
  L1 cache, skipping both compression and the upstream LLM.
- **8a + 8c:** AutoMix accepts at T1; if T1 isn't cached, the cache miss
  triggers upstream LLM → response gets cached → next call hits L1.
- **8d + 8a:** A cached response has $0 cost → cost_zscore = 0 → not
  flagged. Good — caches prevent false-positive runaway alerts.
- **8f + 8b:** Batch API responses include `cached_tokens` if the upstream
  provider reused its own cache (rare but possible on long batch jobs).
  8b extracts them and `prompt_cache_savings_usd` includes both layers.

### 9.4 Calibration + Threshold Tuning

The default thresholds (cache similarity 0.92, AutoMix 0.85, z-score 3/4)
are educated guesses from the Madaan et al. / GPTCache / Welford literature.
Phase 8 ships with:

- **Settings flag** for each threshold (above).
- **Per-tenant A/B** of (threshold_high, threshold_low) — 10% traffic on
  each variant, 90% on the default.
- **30-day recalibration** by the trace-quality team:
  - Fit `P(accept|correct)` vs threshold on graded traces.
  - Update Settings defaults if the empirical optimum differs by > 0.02.

---

## 10. References

### 10.1 Papers

- **LLMLingua-2:** Pan et al. 2023, [arXiv 2310.05736](https://arxiv.org/abs/2310.05736) — "LLMLingua-2: Data Distillation for Efficient and Faithful Task-Agnostic Prompt Compression".
- **AutoMix:** Madaan et al. 2023, [arXiv 2310.12963](https://arxiv.org/abs/2310.12963) — "AutoMix: Automatically Mixing Language Models".
- **FrugalGPT:** Chen et al. 2023, [arXiv 2305.05176](https://arxiv.org/abs/2305.05176) — "FrugalGPT: How to Use Large Language Models While Reducing Cost and Improving Performance".
- **RouteLLM:** Ong et al. 2024, [arXiv 2406.18665](https://arxiv.org/abs/2406.18665) — "RouteLLM: Learning to Route LLMs with Preference Data".
- **LLMLingua (original):** Jiang et al. 2023, [arXiv 2310.05736](https://arxiv.org/abs/2310.05736) — "LLMLingua: Prompt Compression for Large Language Models".
- **Welford's online algorithm:** Welford 1962 — "Note on a method for calculating corrected sums of squares and products".

### 10.2 Repos / Vendor Docs

- **GPTCache:** [zilliztech/gptcache](https://github.com/zilliztech/gptcache) — Apache 2.0.
- **LLMLingua:** [microsoft/LLMLingua](https://github.com/microsoft/LLMLingua) — MIT.
- **Qdrant semantic cache:** [qdrant.tech documentation](https://qdrant.tech/documentation/).
- **RedisVL:** [redisvl.com](https://redisvl.com) — semantic cache layer.
- **RedisBloom:** [redis.io/docs/stack/bloom](https://redis.io/docs/stack/bloom/).
- **OpenAI Prompt Caching:** [platform.openai.com/docs/guides/prompt-caching](https://platform.openai.com/docs/guides/prompt-caching).
- **OpenAI Batch API:** [platform.openai.com/docs/guides/batch](https://platform.openai.com/docs/guides/batch).
- **Anthropic Prompt Caching:** [docs.anthropic.com/en/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching).
- **Anthropic Message Batches API:** [docs.anthropic.com/en/api/creating-message-batches](https://docs.anthropic.com/en/api/creating-message-batches).
- **Instructor:** [github.com/instructor-ai/instructor](https://github.com/instructor-ai/instructor) — references for Pydantic tool-use patterns (used by 8b).
- **Outlines:** [github.com/outlines-dev/outlines](https://github.com/outlines-dev/outlines) — references for structured generation (used by 8c verifier).
- **Bloom filter sizing:** Mitzenmacher 2002, "Probabilistic Methods in Informatics".

### 10.3 Existing Eden Files Referenced

- `src/eden/optimization/cache.py` — L1 exact cache (existing).
- `src/eden/optimization/model_router.py` — ModelRouter + QualityValidator + TaskClassifier.
- `src/eden/optimization/token_optimizer.py` — PromptCompressor (to be replaced).
- `src/eden/optimization/cost_tracker.py` — cost tracking helpers.
- `src/eden/llm/client.py` — OpenRouterClient.call / .acall, UsageStats.
- `src/eden/llmops/openai_adapter.py` — wire-format adapter.
- `src/eden/llmops/semantic_cache.py` — SentenceTransformerEmbedder (reused by 8a L3).
- `src/eden/llmops/ai_gateway.py` — AIGateway (uses cache; extends with 8a).
- `src/eden/observability/telemetry_collector.py` — TelemetryEvent (existing cache_hit + prompt_cache_savings_usd fields).
- `src/eden/services/cost_intel/_common.py` — _fire_cost_anomaly_alert pattern (mirrored by 8d).
- `src/eden/services/cost_intel/efficiency.py` — CostAnomalyDetector (Cat 8 daily counterpart to 8d per-step).
- `src/eden/llmops/promotion_hooks.py` — PromotionHook.on_drift_alert (used by 8d).
- `src/eden/predictive/drift.py` — Cat 13 drift detection (similar Welford + z-score pattern).
- `src/eden/llmops/judges/runner.py` — Cat 3 nightly judge runner (8f integration target).

---

**Status:** Ready for implementation. Files (per §7.1): 5 new + 7 extended.
Total ~1,200 LoC production + ~500 LoC tests.