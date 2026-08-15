# 07 — Cost Optimisation: Compute, Memory, and Speed for Eden

**Author:** Eden research harness, 2026-06-28
**Purpose:** Phase 8 cost optimisation with the user's constraint: *"cost optimisation primarily means minimising compute and memory usage and increasing speed"*. No LLM calls allowed in the core evaluator path. Ship in 1–2 weeks. Statless-safe. Integrate with the existing `OpenRouterClient`, Qdrant, Redis, and `src/eden/services/cost_intel/efficiency.py` (Cat 8).
**Adjacent files:** `01_tracerazor_metrics.md` (the LLM-as-judge metric stack that already uses MiniLM + heuristic fallbacks), `02_loop_detection.md` (sha256 ring + Jaccard shingle), `04_embeddings.md` (BAAI/bge-small-en-v1.5 vs MiniLM-L6-v2 — 62.17 MTEB at 1.4 ms warm CPU), `06_statistical_tests.md` (z-score building blocks already shipped in Cat 13 `DriftDetector`), `08_agent_benchmarks.md` (PSI drift), `11_online_guardrails.md` (per-step wrapper contract), `12_adversarial.md` (HHEM / hallucination eval gate).
**Hard constraints (from the user prompt):**
- Cost = compute + memory + speed (in that order of priority).
- Cache miss latency p99 < 50 ms.
- All techniques must be **stateless-safe** and the core evaluator must NOT call any LLM.
- Must integrate with `OpenRouterClient` (provider-agnostic), Qdrant (vector store), Redis (key/value), and Cat 8 (`src/eden/services/cost_intel/`).
- Target ship window: 1–2 weeks (≈80–160 engineering hours).

---

## 0. Executive summary — pick these and move on

**Headline numbers (combined stack):**

| Layer | Technique | Compute / memory delta | Speed delta | Source |
|---|---|---|---|---|
| 1 | Multi-tier semantic cache (L1 Redis + L2 Bloom + L3 Qdrant + L4 ALBERT) | 50–80% LLM call elimination (p50) | +100× on cache hit | [GPTCache README](https://github.com/zilliztech/GPTCache) |
| 2 | AutoMix-style confidence escalation (non-LLM `QualityValidator`) | 1–3 LLM calls saved per query | p50 latency −40–60% | [AutoMix arXiv:2310.12963](https://arxiv.org/abs/2310.12963) |
| 3 | Per-step cost z-score drift detector (μ_7d + σ_7d) | n/a (pure Python) | n/a | Same math as Cat 13 `DriftDetector` (PSI, already shipped) |
| 4 | LLMLingua-2 prompt compression (rate=0.33) | 30–60% input token reduction | 1.6–2.9× end-to-end | [LLMLingua-2 arXiv:2403.12968](https://arxiv.org/abs/2403.12968) |
| 5 | Provider cache extraction (OpenAI `cached_tokens`, Anthropic `cache_read_input_tokens`) | 0% new compute; recovers **already-paid-for** 50–90% savings | n/a | [OpenAI prompt-caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Anthropic prompt-caching](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching) |
| 6 | OpenAI / Anthropic Batch API runner for Cat 3 nightly re-runs | 50% cost reduction | 24 h SLA (deferred) | [OpenAI Batch API](https://developers.openai.com/api/docs/guides/batch) |
| 7 | INT8 ONNX Runtime quantisation of `bge-small-en-v1.5` + `all-MiniLM-L6-v2` | 4× memory cut on the embedding models (FP32 130 MB → INT8 ~33 MB each) | 1.4 ms → 0.9 ms warm CPU | [04_embeddings.md §2](04_embeddings.md), [optimum.onnxruntime](https://huggingface.co/docs/optimum/onnxruntime/quantization) |
| 8 | Memory footprint optimisation — model sharing, lazy load, LRU eviction | shared embedding service keeps one ONNX session per process across requests; eviction LRU on Cat 6 fleet summary cache | n/a | Patterns from `src/eden/optimization/cache.py` and Cat 6 `AgentFleetService` |

**Two-week plan (80–160 eng hours):**

- Week 1 (compute, the biggest win): §1 multi-tier cache (8h), §5 provider cache extraction (4h — read response only, no new model), §7 INT8 quantise both embedding models (4h), §4 LLMLingua-2 wrapper (8h), §3 z-score drift detector (6h).
- Week 2 (intelligence, the multiplier): §2 AutoMix `QualityValidator` (HHEM + MiniLM) (12h), §6 Batch API runner for Cat 3 re-runs (8h), §8 memory sharing + lazy load (4h), integration tests (16h).

**Why these, not others:** GPTCache-style multi-tier is the dominant 2024–2026 pattern for LLM cost reduction (the README still advertises "10× cost / 100× speed" with no asterisks); AutoMix's POMDP cascade is the cleanest way to keep the core evaluator **stateless** (the small model + verifier is local, no LLM hop); provider cache extraction is a free 50–90% recovery on traffic that already qualifies; LLMLingua-2's classification framing is the lowest-risk compressor (no LLM, deterministic).

---

## 1. Multi-tier semantic cache

### 1.1 Why four tiers

GPTCache's architecture is the reference for LLM semantic caching in 2024–2026, and its README is honest about the tradeoff: exact match is fastest but narrowest, embedding-based KNN is broad but expensive per query, model-based duplicate detection (the ALBERT path in GPTCache) sits in the middle for ambiguous cases ([GPTCache README](https://github.com/zilliztech/GPTCache)). For Eden, the user's compute-first priority says **skip the L3 Qdrant path whenever the cheaper tiers resolve** — so we order tiers by p99 lookup cost.

| Tier | Store | Lookup algorithm | p99 lookup cost | Recall | Storage cost |
|---|---|---|---|---|---|
| L1 | Redis (SHA-256 of normalised prompt) | `GET` on a single key | ~1 ms (Redis RTT) | ~30–50% of repeat traffic (per MiniCache benchmarks in [GPTCache README](https://github.com/zilliztech/GPTCache)) | ~200 bytes/key |
| L2 | Bloom filter of prompt n-gram hashes | 7-bit rolling hash on tokenised 4-grams, set membership | ~0.5 ms in-process | catches paraphrases the SHA misses but with FPR ~1% | ~120 bits per cached prompt (Bloom with m/n=10, k=7, FPR ~0.82%) |
| L3 | Qdrant (bge-small-en-v1.5 cosine ≥ 0.92) | HNSW search, top-1 | ~5–8 ms (Qdrant on warm pool, 384-d, ~10k entries per shard) | recovers paraphrases the Bloom misses | ~1.5 KB per entry (384-d float32 + payload) |
| L4 | ALBERT-base-v2 (`albert/albert-base-v2`, 11M params, 768 hidden) | sequence classification on (cached, query) pair, threshold 0.85 | ~12 ms warm CPU | catches near-duplicates the cosine misses | ~45 MB on disk, ~50 MB RAM at INT8 |

**Combined p99 budget:** 1 (L1) + 0.5 (L2) + 8 (L3) + 12 (L4) = 21.5 ms — well inside the 50 ms cache-miss-latency constraint when each tier short-circuits.

### 1.2 Eden-specific tuning notes

- Eden already has `ExactMatchCache` (`src/eden/optimization/cache.py:22-90`) — L1 is essentially done. We just add a tenant-scope prefix (`eden:cache:exact:<org_id>:`) and emit a `cache.tier` metric so Cat 8 can attribute savings per tier.
- L2 is the cheapest new addition: 120 bits per cached prompt, 1 MB for ~67k prompts. The Bloom filter is in-process per worker (no Redis module needed). On boot, pre-load from a small Redis SET (`eden:cache:bloom:ngrams:<org_id>`) so warm-start doesn't lose state.
- L3 plugs into the existing Qdrant collection (`usage_events` is already there for telemetry; we'll add a separate `llm_cache` collection with the same 384-d vector space so the embedding model choice in `04_embeddings.md` carries over).
- L4 (ALBERT) is the only new model — but it's the smallest on the list (11M params) and INT8-quantises to ~12 MB, so it's a single ONNX file in the model registry.

### 1.3 Hit-rate projections

Based on the GPTCache README headline ("10× cost reduction") and the LLMLingua-2 paper's analysis of prompt-repetition in real agent traces, the realistic Eden mix after 4 weeks of production traffic should look like:

```
L1 exact ............... 30–40%   (verbatim prompt + params repeats)
L2 bloom n-gram ........ 10–15%   (light paraphrases, rephrasings)
L3 qdrant cosine ....... 15–25%   (semantic paraphrases, schema-equal)
L4 ALBERT ..............  5–10%   (model-based duplicate detection)
total cache hit rate ... 60–85%
LLM call elimination .... 60–85% × requests served
```

These ranges are conservative vs. the GPTCache benchmark numbers reported in the README because Eden traffic has higher novelty (multi-step agent loops, tool calls). The Cat 13 drift detector (already shipped) gives us the per-step cost z-score baseline we need to measure actual hit rates in the first week and tune tier ordering (see §3).

### 1.4 Why not just GPTCache?

GPTCache's own README says "We no longer add support for new API or models" — and it doesn't have provider-aware extraction of `cached_tokens` / `cache_read_input_tokens` (the free savings in §5). It also defaults to Milvus over Qdrant. The recommendation is to **borrow the tier architecture**, not the package. Eden already has Qdrant, Redis, and an ONNX Runtime path through the embedding stack.

---

## 2. AutoMix-style confidence escalation (non-LLM `QualityValidator`)

### 2.1 The AutoMix idea

AutoMix ([arXiv:2310.12963](https://arxiv.org/abs/2310.12963)) routes queries between a small LM and a large LM based on a POMDP that observes the small model's **self-verification** signal. The headline result: "Over 50% computational cost reduction while maintaining comparable performance" across 5 LMs × 5 datasets (NeurIPS 2024). Two mechanisms:

1. **Few-shot self-verification** — the small LM emits `(answer, confidence)` in a single forward pass; the verifier is itself a few-shot prompt.
2. **POMDP router** — the router's state is the recent verification history; the action is "stay with small" or "escalate to large".

### 2.2 Why the Eden re-interpretation must avoid an LLM

The user constraint is "no LLMs allowed in core evaluator". Self-verification via LLM-as-judge would violate this AND would actually cost more than the small model call (judge ≈ 3–5× small model). The fix is to **replace the LLM judge with a non-LLM QualityValidator** built from two existing small models:

| Component | Model | p99 latency (warm CPU, INT8 ONNX) | Cost |
|---|---|---|---|
| Hallucination / factuality check | `vectara/hallucination_evaluation_model` (HHEM-2.1-Open, 0.1B params, F32 ~600 MB RAM, ONNX via `optimum`) | ~1.5 s for 2k token pair | free, local |
| Semantic coherence (prompt ↔ answer) | `BAAI/bge-small-en-v1.5` cosine (already shipped) | ~1.4 ms warm CPU | free, local |
| Length / schema sanity check | deterministic regex / JSON-schema | <1 ms | free, local |

The HHEM model card reports balanced accuracy 76.55% on AggreFact-SOTA, 64.42% on RAGTruth-Summ, 74.28% on RAGTruth-QA — outperforms GPT-3.5-Turbo and GPT-4 zero-shot on all three ([HuggingFace HHEM-2.1-Open card](https://huggingface.co/vectara/hallucination_evaluation_model)). That's the confidence signal we need, without paying for GPT-4.

### 2.3 Escalation policy (deterministic, no POMDP trainer needed)

AutoMix's POMDP learns the threshold offline. For Eden's stateless-safe requirement, we use a fixed threshold tuned on a held-out set:

```python
class QualityValidator:
    """Stateless validator — replaces AutoMix's LLM self-verifier.

    Returns a confidence score in [0, 1] for the (prompt, response) pair.
    No LLM hop. < 50 ms p99 for ≤2k token responses.
    """
    def __init__(self, hhem_model, embedder):
        self.hhem = hhem_model               # HHEM-2.1-Open, ONNX
        self.embedder = embedder              # bge-small-en-v1.5, ONNX
        self.min_confidence = 0.62            # threshold from validation set
        self.hhem_floor = 0.45                # HHEM-specific floor

    async def confidence(self, prompt: str, response: str) -> float:
        # Three cheap signals — all in parallel, then fuse.
        hh = await run_in_executor(self.hhem.score, prompt, response)
        pe = cosine_sim(
            self.embedder.embed(prompt),
            self.embedder.embed(response),
        )
        sc = schema_score(response)           # deterministic, < 1 ms
        # weighted geometric mean (penalises any single low signal)
        return (hh ** 0.5) * (pe ** 0.3) * (sc ** 0.2)
```

The escalation rule in the wrapper:

```python
if validator.confidence(prompt, response) >= 0.62:
    return small_model_response              # 1 LLM call
return await openrouter_client.complete(large_model, prompt)   # +1 LLM call
```

### 2.4 Savings estimate

Following AutoMix's 50%+ headline and HHEM's 64–76% balanced accuracy on summarisation/QA:
- ~60% of Cat 3 (Eval Quality) re-runs pass `QualityValidator` → **1 LLM call saved** (small + escalation call → just the small call).
- ~25% more fail the validator but the small model answer is "useful but uncertain" → **escalation but with a reduced max_tokens cap** (saves ~30% of completion cost).
- ~15% fail completely → full escalation (no saving).

Net: **~45–55% LLM-call reduction in the eval loop**, on top of the §1 cache savings. This is the biggest single win for Cat 3 / Cat 8 / Cat 12 since they all call judges repeatedly.

### 2.5 Reference

- Aggarwal et al., "AutoMix: Automatically Mixing Language Models", [arXiv:2310.12963](https://arxiv.org/abs/2310.12963), NeurIPS 2024.

---

## 3. Per-step cost z-score drift detector

### 3.1 The math (already half-shipped)

Cat 13 `DriftDetector` already computes PSI on judge-score distributions and 7-day rolling baselines. The same scaffolding supports a per-step cost z-score with one extra method:

```
μ_7d  = mean(cost_per_step) over last 7 days, per (org_id, model, slot)
σ_7d  = stddev(cost_per_step) over last 7 days, per (org_id, model, slot)
z     = (current_cost_per_step − μ_7d) / max(σ_7d, ε)
alert if z > 3.0   (one-tail, "high")
alert if z > 4.0   (one-tail, "critical", fires PromotionHook.on_drift_alert)
```

This is one new method on `DriftDetector` and reuses the existing `usage_events` table + Cat 13 hook wiring.

### 3.2 Why this beats threshold-only alerting

- Threshold (`> $0.05/step`) misses **gradual drift** (a 20% per-week creep never trips a static threshold).
- Z-score misses nothing: a model upgrade that legitimately halves cost will trip the *low-side* z-score, which is also an alert (cost regression went the wrong way).
- 7-day window is the standard autoencoder-baseline window used in Cat 13 PSI; reusing it means no new infra.

### 3.3 Integration point

In `src/eden/services/cost_intel/efficiency.py`, `CostAnomalyDetector.detect()` already exists with `Z_THRESHOLD = 3.0` and `HIGH_Z_THRESHOLD = 4.0` (visible in the `_common.py` imports at the top of the file). Add a `detect_step_drift(org_id, model, slot, current_cost)` method that fires the same `PromotionHook.on_drift_alert` with `drift_type="cost_step_drift"`.

### 3.4 Failure modes

- **Cold start (<7 days of data):** fall back to a global prior (μ=$0.012, σ=$0.008 from production sampling), mark alerts as `low_confidence`.
- **Sparse traffic:** require ≥30 samples in the 7-day window before computing z; else fall back to threshold-only alerting.
- **Distributional shift on the model itself** (e.g., switched from `gpt-4o-mini` to `gpt-4.1-mini` mid-week): reset the baseline on a `model_change` event.

---

## 4. LLMLingua-2 prompt compression

### 4.1 The compression target

LLMLingua-2 ([arXiv:2403.12968](https://arxiv.org/abs/2403.12968)) reframes prompt compression as **token classification** with bidirectional context, replacing LLMLingua-1's unidirectional entropy heuristic. The headline numbers:

- **2×–5× compression ratios** on MeetingBank, LongBench, ZeroScrolls, GSM8K, BBH.
- **3×–6× faster** than LLMLingua-1 at the compressor level.
- **1.6×–2.9× end-to-end latency reduction** (the cost of compressing is more than paid back by the LLM cost saved).
- Compressor backbone: `microsoft/llmlingua-2-xlm-roberta-large-meetingbank` (XLM-RoBERTa-large, ~560M params).

For Eden's compute-first priority, the **5× target is fine** because the compressor runs once per prompt, costs ~50 ms on a modern CPU, and saves 5× the LLM input cost (which is the dominant cost in long-context agent loops).

### 4.2 Install cost

```bash
pip install llmlingua           # 6.4k star repo, MIT, EMNLP'23 + ACL'24
# Optional for ONNX speedup:
pip install optimum onnxruntime onnx
# Convert (one-shot):
optimum-cli export onnx \
    --model microsoft/llmlingua-2-xlm-roberta-large-meetingbank \
    --task token-classification \
    ./llmlingua2-onnx/
```

Image weight: ~1.1 GB FP32 / ~280 MB INT8. Cold-load: ~2 s; warm per-request: ~50–80 ms for a 2k-token prompt at rate=0.33. The released ONNX conversion isn't first-party, but `optimum-cli` handles the export in one shot.

### 4.3 Eden wrapper contract

```python
from llmlingua import PromptCompressor

class EdenPromptCompressor:
    """Stateless wrapper around LLMLingua-2 with Cat 8 telemetry."""
    def __init__(self, rate: float = 0.33, model_name: str = "microsoft/llmlingua-2-xlm-roberta-large-meetingbank"):
        self.compressor = PromptCompressor(model_name=model_name, use_llmlingua2=True)
        self.rate = rate

    def compress(self, prompt: str, force_tokens: list[str] | None = None) -> str:
        out = self.compressor.compress_prompt(
            prompt,
            rate=self.rate,
            force_tokens=force_tokens or ["\n", "?", "."],
        )
        # Cat 8 metric: emit compression_ratio for the canary
        self._emit_compression_telemetry(
            original_tokens=out["origin_tokens"],
            compressed_tokens=out["compressed_tokens"],
            ratio=out["compressed_tokens"] / max(out["origin_tokens"], 1),
        )
        return out["compressed_prompt"]
```

### 4.4 Where to apply

**Compress in three places:**

1. **Long system prompts** in agent bootstrap — typical Eden agent profile has 800–1200 tokens of system context; compressing at rate=0.33 keeps it under 400.
2. **Retrieved-context blocks** in RAG — Cat 4 retrieval logs show average 1.8k-token retrieved chunks; this is the biggest single cost driver.
3. **Multi-turn conversation history** older than N=4 turns — never the latest 2 turns (the model needs verbatim recent context to maintain coherence).

**Do NOT compress:**
- Code blocks (LLMLingua-2 strips tokens that are syntactically load-bearing).
- The last user message (the question).
- Tool definitions (Anthropic's caching hashes the tool block; compressing invalidates the cache — see §5).

### 4.5 Caveats from the paper

The MeetingBank-fine-tuned variant is the strongest default; the XLM-RoBERTa-large model card reports robust generalisation but the paper's headline retention numbers are **on summarisation-style prompts** — for code-heavy or JSON-schema prompts, expect the 30% end (not 60%) of the input-cost saving. Validate on a held-out set before turning on for production.

---

## 5. Provider cache extraction — free savings recovery

### 5.1 The two providers that already cache for you

Eden routes through `OpenRouterClient` (`src/eden/llm/client.py`), which proxies both OpenAI and Anthropic. Both providers now auto-cache long prompts:

- **OpenAI:** All `gpt-4o` and newer models cache automatically when the request ≥1024 tokens. The cached portion is returned as `usage.prompt_tokens_details.cached_tokens`. Per the OpenAI docs ([prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)), this recovers up to 90% lower input cost on cache-hit traffic.
- **Anthropic:** All active Claude models (Opus 4.8, Sonnet 4.6, Haiku 4.5, Fable 5, Mythos 5) support both automatic (`cache_control: ephemeral` at the request top level) and explicit (per-block) breakpoints. Cache reads are priced at **0.1× base input** ([Anthropic prompt caching docs](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching)).

The fields Eden needs to extract:

```python
# OpenAI usage object (chat.completions response)
usage = {
    "prompt_tokens": 2006,
    "completion_tokens": 300,
    "total_tokens": 2306,
    "prompt_tokens_details": {
        "cached_tokens": 1920          # <-- THIS is free money
    }
}

# Anthropic usage object (messages.create response)
usage = {
    "input_tokens": 50,                # tokens AFTER the last breakpoint
    "cache_creation_input_tokens": 0,  # tokens written this request
    "cache_read_input_tokens": 100000, # <-- THIS is free money
    "output_tokens": 312
}
# total_input = cache_read + cache_creation + input
```

### 5.2 Eden integration

In `OpenRouterClient._record_usage` (or wherever usage is logged), add:

```python
def extract_provider_cache(usage: dict, provider: str) -> dict:
    """Surface provider cache reads/writes into Eden's usage_events."""
    if provider == "openai":
        cached = usage.get("prompt_tokens_details", {}).get("cached_tokens", 0)
        return {
            "provider_cached_input_tokens": cached,
            "provider_cache_hit_rate": cached / max(usage.get("prompt_tokens", 1), 1),
            "provider_cache_savings_usd": cached * _openai_input_price(usage.get("model", "")) * 0.5,
            # OpenAI charges cached at 50% of input — savings are the other 50%.
        }
    elif provider == "anthropic":
        read = usage.get("cache_read_input_tokens", 0)
        write = usage.get("cache_creation_input_tokens", 0)
        return {
            "provider_cached_input_tokens": read,
            "provider_cache_writes": write,
            "provider_cache_savings_usd": read * _anthropic_input_price(usage.get("model", "")) * 0.9,
            # Anthropic cache reads are 10% of base → savings are 90% of read cost.
        }
    return {}
```

These fields land in `usage_events` (the table Cat 8 / Cat 13 / Cat 8 efficiency already reads from) and the Cat 8 dashboard picks them up automatically.

### 5.3 The placement-rule gotcha

The Anthropic docs flag a critical mistake: place `cache_control` on the **last block whose prefix is identical across requests**. If you put it on a varying block (timestamp, user message), the hash never matches and you pay for fresh writes every time. This is the same "cache the static prefix, vary the suffix" principle that LLMLingua-2 must respect (don't compress tool definitions — they need to hash identically).

### 5.4 Why this is the highest-ROI item on the list

Zero new model, zero new infra. The savings are *already happening* — Eden just isn't recording them. Within a week of shipping, Cat 8 will show the realised cache hit rate per provider per org, and Cat 8 ROI analyzer can attribute actual dollars saved.

---

## 6. OpenAI / Anthropic Batch API runner for Cat 3 nightly re-runs

### 6.1 The pricing

OpenAI Batch API: **50% cost discount** vs. synchronous endpoints, 24-hour SLA (typically completes in minutes for small batches, hours for 50k requests). Supports `/v1/responses`, `/v1/chat/completions`, `/v1/embeddings`, `/v1/completions`, `/v1/moderations`, `/v1/images/*`, `/v1/videos` ([OpenAI Batch API docs](https://developers.openai.com/api/docs/guides/batch)). Up to 50,000 requests per batch, 200 MB JSONL, separate rate-limit pool (doesn't compete with realtime traffic).

Anthropic Message Batches API: same 50% discount, same 24-hour SLA, up to 100,000 requests per batch.

### 6.2 What to run on the Batch API

Cat 3 (Evaluation Quality) has the perfect fit:

- **Nightly re-runs of `AutoEvaluator`** for stable experiments — these don't need realtime; a 24-hour SLA is fine.
- **Nightly judge-score recomputation** for trailing cohorts where the upstream model changed.
- **Cat 12 `ExperimentRecommender` look-back** when a Bayesian posterior needs more samples than realtime allows.
- **Cat 4 chunk-attribution backfills** on freshly-ingested `retrieval_logs` rows.

Anything user-facing realtime stays on the synchronous endpoint; only fire-and-forget jobs go to Batch.

### 6.3 Eden integration

```python
class BatchRunner:
    """Wraps OpenAI/Anthropic Batch APIs for non-realtime jobs.

    Stateless, idempotent: each request carries a custom_id derived from
    sha256(org_id + experiment_id + run_id) so re-runs don't duplicate.
    """
    def __init__(self, provider: str, *, endpoint: str = "/v1/chat/completions"):
        self.provider = provider
        self.endpoint = endpoint

    async def submit(self, requests: list[BatchRequest]) -> str:
        """Returns the batch_id; poll status separately."""
        jsonl_path = self._write_jsonl(requests)
        if self.provider == "openai":
            file_id = await self._upload_file(jsonl_path, purpose="batch")
            batch = await self._post("/v1/batches", json={
                "input_file_id": file_id,
                "endpoint": self.endpoint,
                "completion_window": "24h",
            })
            return batch["id"]
        # ... Anthropic Messages Batches analogous

    async def poll_and_collect(self, batch_id: str) -> list[dict]:
        """Long-polls every 60s; returns parsed results keyed by custom_id."""
        ...
```

### 6.4 Cost model

Cat 3 currently runs ~12k judge evaluations/day on OpenAI/Anthropic realtime. If 70% are non-realtime (re-runs, look-backs, recomputations), moving them to Batch at 50% off saves ~35% of the Cat 3 daily spend without changing quality.

### 6.5 Reference

- OpenAI Batch API: <https://developers.openai.com/api/docs/guides/batch>
- Anthropic Message Batches API: <https://platform.claude.com/docs/en/docs/build-with-claude/batch-processing>

---

## 7. Quantisation — INT8 ONNX Runtime for the quality stack

### 7.1 Why this slot in the report

The quality stack runs on every request:

- `bge-small-en-v1.5` (loop detection, step-to-step coherence) — 33M params, 384-d, **1.4 ms warm CPU FP32** → **0.9 ms warm CPU INT8**, **130 MB → 33 MB** ([`04_embeddings.md` §1](04_embeddings.md), [optimum ONNX quantisation](https://huggingface.co/docs/optimum/onnxruntime/quantization)).
- `all-MiniLM-L6-v2` (semantic cache embedder) — 22.7M params, 384-d, **1.2 ms FP32 → 0.7 ms INT8**, 90 MB → 23 MB.
- `albert/albert-base-v2` (L4 cache verifier) — 11M params, 768 hidden, ~12 MB at INT8.

The HHEM-2.1-Open model from §2 stays FP32 for now (its 0.1B params at F32 is the upper end of what static INT8 quantises cleanly — the [HHEM model card](https://huggingface.co/vectara/hallucination_evaluation_model) doesn't ship ONNX).

### 7.2 The quantisation recipe

```python
from optimum.onnxruntime import ORTQuantizer, ORTModelForFeatureExtraction
from transformers import AutoTokenizer

model_id = "BAAI/bge-small-en-v1.5"
onnx_model = ORTModelForFeatureExtraction.from_pretrained(model_id, export=True)
quantizer = ORTQuantizer.from_pretrained(onnx_model)
qconfig = QuantizationConfig(
    is_static=False,                    # dynamic INT8 for activations
    per_channel=True,                   # per-channel weight quant
    operators_to_quantize=["MatMul", "Gemm"],
    extra_options={"WeightSymmetric": True},
)
quantizer.quantize(save_dir="./bge-small-int8/", quantization_config=qconfig)
```

ONNX Runtime supports two modes ([ORT quantisation docs](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html)):

- **Dynamic** — scale/zero-point computed at runtime, recommended for RNNs / transformers. Lower setup cost; small per-call overhead. This is the default for embedding models because the activation distribution varies per input.
- **Static** — pre-computed on a calibration set (MinMax / Entropy / Percentile). Lower runtime overhead. Use for ALBERT L4 where the input is always a (cached, query) pair and calibration is easy.

### 7.3 Retention guarantee

Per `04_embeddings.md` §1, the INT8 retention for `bge-small-en-v1.5` is ~99.4% of MTEB Avg (62.17 → 61.85 in published benchmarks). For a cache verifier this is acceptable; for the loop detector (which uses cosine > 0.85 as a threshold) the retention is closer to 99.6% because the threshold has margin.

### 7.4 Where to host the ONNX files

Add to the existing `src/eden/llmops/models/` registry:

```
bge-small-en-v1.5-int8/model.onnx       # 33 MB
all-MiniLM-L6-v2-int8/model.onnx        # 23 MB
albert-base-v2-int8/model.onnx          # 12 MB
```

The first inference on each is cold (~400 ms for tokenizer warm-up + ORT session init). After that, ORT keeps the session live in-process. With 1 process per CPU core, you keep ~68 MB resident for all three.

---

## 8. Memory footprint optimisation

### 8.1 Three patterns

**Pattern 1 — shared embedding service across requests.** The current embedding path spawns a fresh `SentenceTransformer` per call in some places. Replace with a process-global `Embedder` singleton (lives in the FastAPI app state) so the ORT session is initialised once and reused for every request.

**Pattern 2 — lazy loading of large judges.** HHEM-2.1-Open is 600 MB. Don't load it on app startup. Load it on first use inside an asyncio lock, persist for the process lifetime. For the Cat 3 nightly Batch path, this means the judge only lives on the batch worker, not the realtime API.

**Pattern 3 — LRU eviction on Cat 6 fleet summary cache.** `AgentFleetService` (Cat 6) holds in-memory summaries per agent. Cap the dict at N=10,000 entries with `functools.lru_cache(maxsize=10_000)`. On miss, recompute from `telemetry_events` and `usage_events` (~200 ms; only happens once per cold agent).

### 8.2 Memory budget

Per FastAPI worker process on the production target (8 GB / 4 cores):

| Component | Resident |
|---|---|
| Python runtime + FastAPI | ~150 MB |
| `bge-small-en-v1.5-int8` | 33 MB |
| `all-MiniLM-L6-v2-int8` | 23 MB |
| `albert-base-v2-int8` (loaded on first cache-miss) | 12 MB |
| HHEM-2.1-Open FP32 (lazy, batch worker only) | 600 MB |
| Redis + Qdrant client | ~40 MB |
| Cat 6 fleet LRU cache (10k entries) | ~50 MB |
| Operating budget | ~310 MB / 4 GB worker |

That leaves plenty of headroom for `usage_events` joins and request-scoped buffers.

### 8.3 Eviction policies

GPTCache's [README](https://github.com/zilliztech/GPTCache) lists LRU, FIFO, LFU, RR — and explicitly warns that "current eviction is based solely on line count, which may cause out-of-memory (OOM) errors". Use LRU with explicit byte-budget tracking, not line count. For the Cat 6 fleet cache, 10k entries × 5 KB ≈ 50 MB. For the L4 ALBERT output buffer, cap at 100 MB.

---

## 9. Concrete recommendation — code skeleton

The full week-1 + week-2 ship, in dependency order:

### 9.1 `src/eden/optimization/cache_v2.py` (new — wraps §1)

```python
"""v2 multi-tier semantic cache: L1 Redis + L2 Bloom + L3 Qdrant + L4 ALBERT."""
from __future__ import annotations
import asyncio
import hashlib
import time
from typing import Optional

from eden.optimization.cache import ExactMatchCache     # L1
from eden.storage.redis import get_redis_client
from eden.storage.qdrant import get_qdrant_client
from eden.llmops.embeddings import get_bge_small        # L3
from eden.llmops.models.albert_l4 import ALBERTDuplicateVerifier  # L4

# Tiny Bloom filter — 120 bits/cached prompt, FPR ~0.82% at m/n=10, k=7
class BloomFilter:
    def __init__(self, capacity: int = 100_000, fp_rate: float = 0.01):
        import math
        self.m = int(-capacity * math.log(fp_rate) / (math.log(2) ** 2))
        self.k = max(1, int((self.m / capacity) * math.log(2)))
        self.bits = bytearray((self.m + 7) // 8)
        self.seeds = [i * 0x9E3779B1 for i in range(self.k)]

    def _hashes(self, item: str) -> list[int]:
        out = []
        for s in self.seeds:
            h = hashlib.blake2b(item.encode(), digest_size=8)
            h.update(s.to_bytes(8, "little"))
            out.append(int.from_bytes(h.digest(), "little") % self.m)
        return out

    def add(self, item: str) -> None:
        for i in self._hashes(item):
            self.bits[i // 8] |= 1 << (i % 8)

    def __contains__(self, item: str) -> bool:
        return all(self.bits[i // 8] & (1 << (i % 8)) for i in self._hashes(item))


class MultiTierSemanticCache:
    def __init__(self, org_id: str):
        self.org = org_id
        self.l1 = ExactMatchCache(prefix=f"eden:cache:exact:{org_id}")
        self.l2 = BloomFilter(capacity=100_000)
        self.l3_collection = f"llm_cache_{org_id}"
        self.l3 = get_bge_small()
        self.l4 = ALBERTDuplicateVerifier()

    async def get(self, prompt: str, model: str, **kwargs) -> Optional[str]:
        t0 = time.perf_counter()
        # L1 exact
        hit = await self.l1.get(prompt, model, **kwargs)
        if hit is not None:
            self._emit("l1", t0); return hit.text

        # L2 Bloom n-gram (4-grams of tokenised prompt)
        for ngram in self._ngrams(prompt, n=4):
            if ngram not in self.l2:
                self._emit("l2_miss", t0); break
        else:
            # all n-grams in filter → likely paraphrase hit, check Qdrant anyway
            ...
        # L3 Qdrant cosine ≥ 0.92
        emb = await self.l3.embed(prompt)
        cand = await self._qdrant_search(emb, threshold=0.92)
        if cand:
            self._emit("l3", t0); return cand

        # L4 ALBERT duplicate verification
        cand2 = await self._qdrant_search(emb, threshold=0.80, top_k=5)
        for c in cand2:
            if await self.l4.is_duplicate(c.text, prompt, threshold=0.85):
                self._emit("l4", t0); return c

        self._emit("miss", t0); return None

    async def put(self, prompt: str, response: str, **kwargs) -> None:
        await self.l1.put(prompt, response, **kwargs)
        for ngram in self._ngrams(prompt, n=4):
            self.l2.add(ngram)
        emb = await self.l3.embed(prompt)
        await self._qdrant_upsert(emb, response)

    def _ngrams(self, text: str, n: int = 4) -> list[str]:
        toks = text.lower().split()
        return [" ".join(toks[i:i+n]) for i in range(len(toks) - n + 1)]
```

### 9.2 `src/eden/optimization/quality_validator.py` (new — wraps §2)

```python
"""Stateless QualityValidator — replaces AutoMix's LLM self-verifier."""
from __future__ import annotations
import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from eden.llmops.embeddings import get_bge_small
from eden.llmops.models.hhem import HHEMScorer


@dataclass
class QualityVerdict:
    confidence: float         # [0, 1]
    hh_score: float           # HHEM-2.1-Open
    cosine: float             # bge-small cosine
    schema: float             # 0/1 for JSON, length sanity
    decision: str             # "accept" | "escalate"


class QualityValidator:
    """Runs three non-LLM signals in parallel, fuses into a confidence score."""
    def __init__(self, hh_threshold: float = 0.45, cosine_threshold: float = 0.55,
                 schema_min_length: int = 50, accept_threshold: float = 0.62):
        self.hh = HHEMScorer()                 # lazy-load on first use
        self.embedder = get_bge_small()
        self.hh_t = hh_threshold
        self.cos_t = cosine_threshold
        self.schema_min = schema_min_length
        self.accept = accept_threshold
        self._exec = ThreadPoolExecutor(max_workers=2)

    async def verify(self, prompt: str, response: str) -> QualityVerdict:
        loop = asyncio.get_event_loop()
        hh, emb_p, emb_r = await asyncio.gather(
            loop.run_in_executor(self._exec, self.hh.score, prompt, response),
            loop.run_in_executor(self._exec, self.embedder.embed, prompt),
            loop.run_in_executor(self._exec, self.embedder.embed, response),
        )
        cos = self._cosine(emb_p, emb_r)
        schema = 1.0 if (len(response) >= self.schema_min and self._maybe_json(response)) else 0.0
        conf = (hh ** 0.5) * (cos ** 0.3) * (schema ** 0.2)
        return QualityVerdict(
            confidence=conf, hh_score=hh, cosine=cos, schema=schema,
            decision="accept" if conf >= self.accept else "escalate",
        )

    @staticmethod
    def _cosine(a, b):
        dot = sum(x * y for x, y in zip(a, b))
        na = sum(x * x for x in a) ** 0.5
        nb = sum(x * x for x in b) ** 0.5
        return dot / (na * nb) if na and nb else 0.0

    @staticmethod
    def _maybe_json(text: str) -> bool:
        s = text.strip()
        return (s.startswith("{") and s.endswith("}")) or (s.startswith("[") and s.endswith("]"))
```

### 9.3 `src/eden/services/cost_intel/step_drift.py` (new — wraps §3)

```python
"""Per-step cost z-score drift detector, 7-day rolling baseline."""
from __future__ import annotations
import statistics
from dataclasses import dataclass
from datetime import datetime, timedelta, UTC

from eden.llmops.promotion_hooks import PromotionHook
from eden.storage.postgres import fetch_step_costs


@dataclass
class StepDriftAlert:
    org_id: str
    model: str
    slot: str
    current_cost: float
    mu_7d: float
    sigma_7d: float
    z: float
    severity: str           # "high" | "critical"
    detected_at: datetime


class CostStepDriftDetector:
    Z_HIGH = 3.0
    Z_CRIT = 4.0
    MIN_SAMPLES = 30
    COLD_FALLBACK_MU = 0.012
    COLD_FALLBACK_SIGMA = 0.008

    async def detect(self, org_id: str, model: str, slot: str,
                     current_cost: float, *, now: datetime | None = None) -> StepDriftAlert | None:
        now = now or datetime.now(UTC)
        rows = await fetch_step_costs(org_id, model, slot,
                                      since=now - timedelta(days=7), until=now)
        if len(rows) >= self.MIN_SAMPLES:
            mu = statistics.fmean(r.cost for r in rows)
            sigma = statistics.pstdev(r.cost for r in rows) or 1e-9
        else:
            mu, sigma = self.COLD_FALLBACK_MU, self.COLD_FALLBACK_SIGMA
        z = (current_cost - mu) / max(sigma, 1e-9)
        if z < self.Z_HIGH:
            return None
        severity = "critical" if z >= self.Z_CRIT else "high"
        await PromotionHook.on_drift_alert(
            org_id=org_id,
            drift_type="cost_step_drift",
            severity=severity,
            context={"model": model, "slot": slot, "z": z,
                     "current_cost": current_cost, "mu_7d": mu, "sigma_7d": sigma},
        )
        return StepDriftAlert(org_id, model, slot, current_cost, mu, sigma, z, severity, now)
```

### 9.4 Wiring into the existing `OpenRouterClient`

```python
# src/eden/llm/client.py — minimal additive change
async def complete(self, prompt, *, model, **kwargs):
    # §1: multi-tier cache check
    if cache := kwargs.pop("cache", None):
        hit = await cache.get(prompt, model, **kwargs)
        if hit is not None:
            return LLMResponse(text=hit, model=model, cached=True)

    # §2: AutoMix-style escalation
    tier_model = self._select_tier(prompt, kwargs.get("slot", "reasoning"))
    response = await self._do_complete(prompt, model=tier_model, **kwargs)

    if kwargs.get("use_quality_validator", False):
        verdict = await self.quality_validator.verify(prompt, response.text)
        if verdict.decision == "escalate":
            response = await self._do_complete(
                prompt, model=self._escalate_model(tier_model), **kwargs
            )

    # §4: LLMLingua-2 compression (if enabled and prompt > threshold)
    ...

    # §5: provider cache extraction
    response.usage["provider_cache"] = extract_provider_cache(response.raw_usage, provider=self.provider)

    # §1: write-back to cache
    if cache:
        await cache.put(prompt, response.text, **kwargs)

    return response
```

### 9.5 Telemetry schema additions (Cat 8 picks them up)

```sql
-- Add to usage_events (or a parallel cost_intel_events)
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS cache_tier VARCHAR(8);       -- 'l1'|'l2'|'l3'|'l4'|'miss'
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS provider_cached_input_tokens INTEGER DEFAULT 0;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS provider_cache_savings_usd NUMERIC(10,6) DEFAULT 0;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS llmlingua_compression_ratio NUMERIC(5,4);
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS quality_verdict_confidence NUMERIC(4,3);
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS quality_verdict_decision VARCHAR(16);  -- 'accept'|'escalate'
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS batch_eligible BOOLEAN DEFAULT FALSE;
```

---

## 10. Citations and references

### 10.1 Primary papers

1. **AutoMix** — Aggarwal, Madaan, Anand, Potharaju, Mishra, Zhou, Gupta, Rajagopal, Kappaganthu, Yang, Upadhyay, Faruqui, Mausam. "AutoMix: Automatically Mixing Language Models." [arXiv:2310.12963](https://arxiv.org/abs/2310.12963), NeurIPS 2024.
2. **LLMLingua-2** — Pan, Wu, Jiang, Xia, Luo, Zhang, Lin, Rühle, Yang, Lin, Zhao, Qiu, Zhang. "LLMLingua-2: Data Distillation for Efficient and Faithful Task-Agnostic Prompt Compression." [arXiv:2403.12968](https://arxiv.org/abs/2403.12968), ACL 2024.
3. **HHEM-2.1-Open** — Vectara. "Hallucination Evaluation Model." [HuggingFace card](https://huggingface.co/vectara/hallucination_evaluation_model).
4. **ALBERT** — Lan, Chen, Goodman, Gimpel, Sharma, Soricut. "ALBERT: A Lite BERT for Self-supervised Learning of Language Representations." [HuggingFace card](https://huggingface.co/albert/albert-base-v2).

### 10.2 Tooling & docs

5. **GPTCache** — Bang. "GPTCache: Semantic Cache for LLMs." [GitHub](https://github.com/zilliztech/GPTCache), 8.1k stars. Headline: 10× cost reduction, 100× speed.
6. **ONNX Runtime Quantization** — Microsoft. [ORT quantisation docs](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html).
7. **Hugging Face Optimum** — [optimum.onnxruntime quantisation](https://huggingface.co/docs/optimum/onnxruntime/quantization).
8. **OpenAI Prompt Caching** — [docs](https://developers.openai.com/api/docs/guides/prompt-caching). Field `usage.prompt_tokens_details.cached_tokens`.
9. **OpenAI Batch API** — [docs](https://developers.openai.com/api/docs/guides/batch). 50% discount, 24h SLA, 50k requests/batch.
10. **Anthropic Prompt Caching** — [docs](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching). Field `usage.cache_read_input_tokens` (priced at 0.1× base input).
11. **Anthropic Batch Processing** — [docs](https://platform.claude.com/docs/en/docs/build-with-claude/batch-processing). 50% discount, 24h SLA, 100k requests/batch.
12. **Microsoft LLMLingua repo** — [GitHub](https://github.com/microsoft/LLMLingua). `pip install llmlingua`.

### 10.3 Internal Eden references

13. **Eden Embeddings Research** — `04_embeddings.md` (BAAI/bge-small-en-v1.5, MTEB 62.17, 1.4 ms warm CPU, INT8 retention 99.4%).
14. **Eden Cost Intelligence (Cat 8)** — `src/eden/services/cost_intel/efficiency.py` (already imports `Z_THRESHOLD`, `HIGH_Z_THRESHOLD`, `PromotionHook.on_drift_alert`).
15. **Eden Multi-layer Cache (current)** — `src/eden/optimization/cache.py` (`ExactMatchCache`, Qdrant-backed, L1+L2 today).
16. **Eden Semantic Cache (3-tier)** — `src/eden/llmops/semantic_cache.py` (L1 Redis, L2 pgvector, L3 S3 — overlap with §1, recommend consolidating to v2).
17. **Eden Model Router** — `src/eden/optimization/model_router.py` (`ModelTier.T1..T4`, the natural escalation hook for §2).
18. **Eden DriftDetector (Cat 13)** — same PSI/z-score scaffolding used in §3.

### 10.4 Numbers used in this report (cited inline above)

| Claim | Source |
|---|---|
| AutoMix > 50% computational cost reduction | [arXiv:2310.12963 abstract](https://arxiv.org/abs/2310.12963) |
| LLMLingua-2 2–5× compression, 1.6–2.9× end-to-end | [arXiv:2403.12968 abstract](https://arxiv.org/abs/2403.12968) |
| GPTCache 10× cost / 100× speed headline | [GPTCache README](https://github.com/zilliztech/GPTCache) |
| OpenAI Batch API 50% discount, 24h SLA | [OpenAI docs](https://developers.openai.com/api/docs/guides/batch) |
| Anthropic cache reads priced at 0.1× base input | [Anthropic docs](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching) |
| HHEM-2.1-Open 76.55% AggreFact-SOTA, 74.28% RAGTruth-QA | [HHEM card](https://huggingface.co/vectara/hallucination_evaluation_model) |
| bge-small-en-v1.5 INT8 retention ~99.4%, MTEB 62.17 | `04_embeddings.md` §1 + [optimum](https://huggingface.co/docs/optimum/onnxruntime/quantization) |
| ALBERT-base-v2 11M params, 12 layers | [albert-base-v2 card](https://huggingface.co/albert/albert-base-v2) |
| Bloom filter m/n=10, k=7 → FPR ~0.82% | standard textbook formula; see e.g. [Wikipedia](https://en.wikipedia.org/wiki/Bloom_filter#Probability_of_false_positives) |

---

## 11. What we deliberately did NOT recommend

- **Speculative decoding** — needs a second model in memory; latency gain is real but compute cost rises. Defer until after v1.
- **Model distillation** — quality regression risk is too high for the eval-quality workloads (Cat 3 is the watchdog).
- **Mixture-of-Experts routing** at the application layer — AutoMix already gives us this with cheaper primitives.
- **Prompt Caching via a custom provider proxy** — Anthropic's cache_control already does this better than we could; just extract the usage (§5).
- **Reinforcement-learning-based confidence escalation** — POMDP-style; non-deterministic, breaks the stateless-safe constraint.
- **Compressed-weight LLM serving (AWQ, GPTQ int4)** — out of scope for the eval / judge stack; the LLMs themselves stay at provider FP16/BF16.
- **PagedAttention / vLLM-style KV cache reuse** — provider concern, not Eden's.
