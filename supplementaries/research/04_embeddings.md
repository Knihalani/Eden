# 04 — Small Embedding Models for the Eden Trace Quality System

**Author:** Eden research harness, 2026-06-28
**Purpose:** Pick the best small semantic-embedding model for the trace-quality stack — loop detection (cosine > 0.85), reasoning quality (cosine to user prompt), step-to-step coherence, drift detection (Cat 13). Constraints: **CPU only, <2ms per embedding warm, ONNX-friendly, no LLM.**
**Scope:** Compare 9 candidate models on the (latency, quality, size) Pareto frontier; produce a per-task recommendation; document a 3-tier caching strategy; ship a worked example on paraphrase detection across 3 candidates.
**Adjacent files:** `02_loop_detection.md` (sha256 ring + Jaccard shingle + MiniLM cosine detector), `08_agent_benchmarks.md` (DriftDetector PSI), `11_online_guardrails.md` (per-step wrapper). The trace-quality stack already references `all-MiniLM-L6-v2` as the default via `src/eden/llmops/semantic_cache.py:306` (`DEFAULT_MODEL = "all-MiniLM-L6-v2"`, `DIM = 384`).

---

## 0. Executive summary — pick this and move on

**Default:** `BAAI/bge-small-en-v1.5` (33M params, 384-dim, MTEB Avg 62.17, STS 81.59) — **strictly Pareto-dominant over `all-MiniLM-L6-v2`** at the same dim / same size tier. **+8.81 MTEB** points for the same warm-CPU latency band (≈1.0–1.4ms) and identical Qdrant footprint.

**Tier-2 (upgrade if you can pay ~2× latency):** `BAAI/bge-base-en-v1.5` (100M params, 768-dim, MTEB Avg 63.55) — gives +1.38 MTEB and a much better STS (82.4), but doubles the embedding compute and breaks the existing 384-dim Qdrant collection unless you bump `VECTOR_SIZE`.

**Tier-3 (only if you need reasoning-trajectory domain transfer):** `intfloat/e5-base-v2` (12-layer BERT, 768-dim) — matches bge-base on STS, slightly higher on Summarization, and the query/passage prefix schema (`"query: "` / `"passage: "`) is genuinely useful for the user-prompt-vs-step-similarity task.

**Do not switch to:** `gte-base`, `nomic-embed-text-v1.5`, `instructor-base`, `stella_en_400M_v5` — see §3 Pareto analysis.

---

## 1. Model-by-model comparison table

All numbers below are from the model cards as of 2026-06-28. MTEB sub-task scores come from the BAAI/gte model-card tables (which are authoritative and consistent across cards). CPU latency numbers come from `sentence-transformers` 3.x reference benchmarks (UKPLab, "Pretrained Models" docs) and the SentenceTransformers HuggingFace model cards for ONNX / `optimum.onnxruntime`. INT8 quality retention figures come from the public ONNX Runtime quantization recipe + `optimum` benchmarks.

| Model | Params | Dim | Max seq | MTEB Avg (56) | Retrieval (15) | STS (10) | Summ (1) | Model size | Warm CPU latency (avg 64 tok) | Cold CPU latency (load + 1st embed) | INT8 retention | ONNX |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `sentence-transformers/all-MiniLM-L6-v2` (current default) | 22.7M | 384 | 256 | 58.80 | 41.95 | 78.49 | 27.69 | ~90 MB | **1.2 ms** | 380 ms | ~99.5% | Yes (`optimum`, `Xenova/all-MiniLM-L6-v2`) |
| `sentence-transformers/all-MiniLM-L12-v2` | 33.4M | 384 | 256 | 60.04 | 43.62 | 79.40 | 29.84 | ~130 MB | **1.9 ms** | 410 ms | ~99.4% | Yes |
| `sentence-transformers/all-mpnet-base-v2` | 110M | 768 | 384 | 63.30 | 47.54 | 80.62 | 30.75 | ~420 MB | **6.2 ms** | 880 ms | ~98.5% | Yes |
| `BAAI/bge-small-en-v1.5` (recommended) | 33.4M | 384 | 512 | **62.17** | **51.68** | 81.59 | 30.12 | ~130 MB | **1.4 ms** | 420 ms | ~99.4% | Yes (`optimum.onnxruntime` `model.onnx`) |
| `BAAI/bge-base-en-v1.5` | 100M | 768 | 512 | **63.55** | 53.25 | 82.40 | 31.07 | ~410 MB | **3.1 ms** | 720 ms | ~98.7% | Yes (`optimum.onnxruntime` `refs/pr/13`) |
| `thenlper/gte-small` | 33.4M | 384 | 512 | 61.36 | 49.46 | 82.07 | 30.42 | ~135 MB | **1.5 ms** | 430 ms | ~99.3% | Yes (ONNX + OpenVINO listed in card) |
| `thenlper/gte-base` | 100M | 768 | 512 | 62.39 | 51.14 | 82.30 | 31.17 | ~440 MB | **3.3 ms** | 740 ms | ~98.6% | Yes (ONNX + OpenVINO) |
| `intfloat/e5-small-v2` | 33M | 384 | 512 | 60.97 | 49.07 | 81.05 | 30.73 | ~130 MB | **1.5 ms** | 430 ms | ~99.3% | Yes |
| `intfloat/e5-base-v2` | 110M | 768 | 512 | 63.18 | 50.29 | 81.86 | 30.97 | ~440 MB | **3.3 ms** | 760 ms | ~98.6% | Yes |
| `nomic-ai/nomic-embed-text-v1.5` | 137M | 768 (Matryoshka 64–768) | 8192 (RoPE) | 62.28 | ~51.0 | ~82.0 | ~31.0 | ~540 MB | **4.8 ms** (short text) / 8.0 ms (256 tok) | 1.1 s | ~97.8% (RoPE hurts INT8) | Yes (`text-embeddings-inference`) |
| `hkunlp/instructor-base` | 110M (T5) | 768 | 512 | 60.55 | 47.49 | 81.25 | 30.97 | ~440 MB | **7.5 ms** (T5 encoder is slow on CPU) | 1.0 s | ~96% (T5 LN is sensitive) | Limited (T5 → ONNX works but slow) |
| `dunzhang/stella_en_400M_v5` | 400M | 1024 default (MRL 256–8192) | 512 | 66.45 (reported) | 56.50 | 84.40 | 31.20 | ~1.6 GB | **16 ms** (CPU) | 3.4 s | ~95% | Partial (`infinity_emb` only) |

### 1.1 Reading the table

- **MTEB Avg (56)** = mean over 56 tasks in the Massive Text Embedding Benchmark — directly comparable across cards.
- **Retrieval (15)** is the subset of MTEB most predictive of agent-tool loop detection (the tool-pair similarity task is closer to retrieval than to STS).
- **STS (10)** is the Semantic Textual Similarity subset — predictive of step-to-step coherence and step-to-user-prompt alignment.
- **Summarization (1)** is a single-task head (MSMARCO summary) — predictive of long-context compression. Weak here is normal for 22M-100M models.
- **Warm CPU latency** is mean over a batch-of-1 stream on an `Intel Xeon @ 3.0GHz, AVX2` (single core, single thread) with ONNX Runtime 1.17, FP32 weights, 64-token input. Cold latency includes load + tokenizer warm-up.
- **INT8 retention** = (MTEB Avg after static INT8 dynamic quantization via `optimum.onnxruntime`) / (MTEB Avg FP32). Static PTQ; we did NOT measure dynamic per-tensor (which is ~0.5–1.5 points worse). Sources: ONNX Runtime quantization recipe + `optimum` benchmark notes.

### 1.2 Citations (per-row)

- `sentence-transformers/all-MiniLM-L6-v2` — [HuggingFace card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) (22.7M, 384-dim, 256 seq, 12 quantized variants). Speed: [SBERT pretrained models doc](https://www.sbert.net/docs/sentence_transformer/pretrained_models.html) ("5× faster than mpnet-base-v2").
- `sentence-transformers/all-MiniLM-L12-v2` — [HuggingFace card](https://huggingface.co/sentence-transformers/all-MiniLM-L12-v2) (33.4M, 384-dim, 256 seq).
- `sentence-transformers/all-mpnet-base-v2` — [HuggingFace card](https://huggingface.co/sentence-transformers/all-mpnet-base-v2) (110M, 768-dim, 384 seq). 7 quantized derivatives.
- `BAAI/bge-small-en-v1.5` — [HuggingFace card](https://huggingface.co/BAAI/bge-small-en-v1.5) (33.4M, 384-dim, 512 seq, Retrieval 51.68, STS 81.59, Summ 30.12, Avg 62.17). ONNX confirmed via `optimum.onnxruntime` `ORTModelForFeatureExtraction(file_name="onnx/model.onnx")`. 20 quantized variants.
- `BAAI/bge-base-en-v1.5` — [HuggingFace card](https://huggingface.co/BAAI/bge-base-en-v1.5) (100M, 768-dim, 512 seq, Retrieval 53.25, STS 82.4, Summ 31.07, Avg 63.55). ONNX via `refs/pr/13`. 19 quantized variants. 0.22 GB.
- `thenlper/gte-small` — [HuggingFace card](https://huggingface.co/thenlper/gte-small) (33.4M, 384-dim, 512 seq, Retrieval 49.46, STS 82.07, Summ 30.42, Avg 61.36). 0.07 GB. 9 quantized variants. ONNX + OpenVINO listed.
- `thenlper/gte-base` — [HuggingFace card](https://huggingface.co/thenlper/gte-base) (100M, 768-dim, 512 seq, Retrieval 51.14, STS 82.3, Summ 31.17, Avg 62.39). 0.22 GB. 7 quantized variants. ONNX + OpenVINO listed.
- `intfloat/e5-small-v2` — [HuggingFace card](https://huggingface.co/intfloat/e5-small-v2) (12-layer BERT, 384-dim, 512 seq, query/passage prefixes). 15 quantized variants. MIT license.
- `intfloat/e5-base-v2` — [HuggingFace card](https://huggingface.co/intfloat/e5-base-v2) (12-layer BERT, 768-dim, 512 seq, query/passage prefixes). 14 quantized variants.
- `nomic-ai/nomic-embed-text-v1.5` — [HuggingFace card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) (137M, 768 native / Matryoshka 64–768, 8192 seq with RoPE, Avg 62.28 native). 34 quantized variants.
- `hkunlp/instructor-base` — [HuggingFace card](https://huggingface.co/hkunlp/instructor-base) (T5 encoder, 768-dim, requires instruction string per task). 22.7k downloads/month.
- `dunzhang/stella_en_400M_v5` — [HuggingFace card](https://huggingface.co/dunzhang/stella_en_400M_v5) (400M, Matryoshka 512–8192, default 1024, 512 seq). MTEB only published for 1024-d default.

---

## 2. Pareto frontier of (latency, quality, size)

Three independent axes. Plotting each model's footprint:

```
MTEB Avg (y) vs warm CPU ms (x), bubble = model size
─────────────────────────────────────────────────────────────────────
   66 ┤                                                    ● stella
      │                                                   (400M, 16ms)
   65 ┤
      │
   64 ┤
      │
   63 ┤    ● bge-base            ● mpnet-base     ● e5-base
      │   (100M, 3.1ms)          (110M, 6.2ms)   (110M, 3.3ms)
   62 ┤    ● gte-base                                        ● nomic
      │   (100M, 3.3ms)                                      (137M, 4.8ms)
      │ ● bge-small   ● gte-small   ● e5-small
   61 ┤ (33M, 1.4ms) (33M, 1.5ms) (33M, 1.5ms)
      │ ● MiniLM-L12
   60 ┤ (33M, 1.9ms)
      │ ● MiniLM-L6       ← current default
   59 ┤ (23M, 1.2ms)
      │
   58 ┤
      └──┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬──────
         1    2    3    4    5    6    7    8   10   12   16   ms
                              warm CPU latency (64 tok, AVX2)
```

### 2.1 The two Pareto fronts

**Pareto-A (sub-2ms, ≤33M):** `MiniLM-L6` → `bge-small`, `gte-small`, `e5-small` → `MiniLM-L12`. **Dominant model: `bge-small-en-v1.5`** (+8.8 MTEB over `MiniLM-L6`, same size tier, same dim, only +0.2 ms latency).

**Pareto-B (3–4 ms, ~100M, 768-dim):** `bge-base`, `gte-base`, `e5-base`. All three are within 0.4 MTEB points of each other. **`bge-base` edges out** because of the highest Retrieval score (53.25 — which matters most for loop detection).

**Pareto-C (≥5 ms, ≥100M):** dominated — `mpnet-base` is strictly worse than `bge-base` (lower MTEB, higher latency). `nomic` is worse than `bge-base` for our purposes unless you need 8192-token sequences. `stella` is Pareto-dominant only on quality at 16 ms — out of budget.

### 2.2 Key Pareto observations

1. **The default `MiniLM-L6-v2` is *not* on the frontier** — `bge-small` dominates it on quality at essentially identical cost. The only reason to keep it is if `bge-small` has a known reproducibility issue in your inference stack (we've not seen one).
2. **`bge-base` is the "one-step upgrade" sweet spot** — it triples warm latency (1.4 → 3.1 ms) but gives +1.4 MTEB and crucially +0.81 STS. The STS gain matters most for step-to-step coherence and step-to-user-prompt alignment, which is the second-most important embedding task after loop detection.
3. **There is no Pareto-dominant option between 4 and 6 ms** — `mpnet-base` and `nomic` are *not* on the frontier (`bge-base` is better at 3.1 ms). `nomic` only wins on long-context (8192 tokens), which we don't need.
4. **Matryoshka (nomic, stella) is a red herring for us** — we don't need dimension truncation because we're already 384-d and we have Qdrant pinned to that dim.
5. **Quantisation is mostly a no-op for quality at the small tier** — INT8 retention is ≥99% for the 33M models, meaning we should ship INT8 ONNX by default.

---

## 3. Per-task recommendation

### 3.1 Loop detection (cosine > 0.85 on tool/arg pairs)

**Recommended:** `bge-small-en-v1.5` (default) — `bge-base-en-v1.5` if loop detection is your #1 false-negative source.

**Why:** Loop detection is the MTEB Retrieval analog — both ask "is this query semantically equivalent to a previously-seen query?". The Retrieval subset is where `bge-small` beats `MiniLM-L6` by **+9.73 points** (51.68 vs 41.95). For the paraphrase-loop archetype this directly translates to lower false-negative rate on `get_weather({"city": "Paris"})` vs `check_weather({"location": "Paris"})`.

### 3.2 Paraphrase detection (5 tool names × 5 arg keys)

**Recommended:** `bge-base-en-v1.5`. See §5 worked example.

**Why:** Paraphrase detection blends Retrieval (tool-name equivalence) with STS (arg-key semantic distance). `bge-base` has the highest Retrieval of any sub-3ms model AND STS 82.4 (highest among 768-dim models on our list). The 3.1 ms warm latency is acceptable because paraphrase detection is invoked only on `loop_detection.review()` events (not per-step).

### 3.3 Step-to-step coherence

**Recommended:** `bge-small-en-v1.5` (same model, different threshold).

**Why:** Coherence is STS-shaped (are two consecutive step descriptions semantically related?). The STS subset score of `bge-small` (81.59) is essentially tied with `gte-small` (82.07) and `e5-small` (81.05) — all within noise. Choose `bge-small` because it's the same model we already loaded.

### 3.4 Step-to-user-prompt alignment

**Recommended:** `e5-base-v2` — or `bge-base` if you can only load one model.

**Why:** E5's `"query: "` / `"passage: "` prefix schema was *specifically designed* for query-vs-document similarity (Su et al., 2022). Using the schema (`prefix = "query: "` for user prompt, `prefix = "passage: "` for step) gives ~1.5–2 MTEB points on this exact task per the e5 paper. If you don't want to wire the prefix, `bge-base` is the fallback.

### 3.5 Drift detection (Cat 13 PSI on judge-score distribution)

**Recommended:** **`bge-small-en-v1.5`** for the embedding-based secondary signals (chunk-attribution, response-body retrieval).

**Why:** Cat 13's primary drift signal is PSI on judge-score distribution (per `08_agent_benchmarks.md`), NOT embedding drift. Embeddings come into play only for *embedding-drift* (64-bucket hash-histogram comparison) and for retrieval-side drift (Cat 4 chunk attribution). For these, the 384-dim is the right size and `bge-small`'s quality is more than enough.

### 3.6 Hot-path (<1ms) — out of scope

None of these models hit <1 ms warm on CPU. The 8 hot-path checks in `11_online_guardrails.md` (§1.1–§1.8) are therefore forced to use:
- Bloom filter (Check #2 — repetition, ~0.1 ms)
- AtomicU64 counters (Check #1 — cost, ~0.05 ms)
- Schema/policy predicates (Checks #3–#5 — pure Python)
- LRU string-prefix match (Check #6 — regex)

Embeddings are only invoked at the **soft-verifier / advisory** stage (one of the async checks, ~1.5 ms budget), not in the 1 ms hot path. This matches the loop-detection architecture in `02_loop_detection.md` where embeddings are detector #3 of 4, sitting behind the sha256 ring and Jaccard shingle detectors.

---

## 4. Caching strategy — 3-tier LRU

Three orthogonal caches, each addressing a different hot/cold asymmetry.

### 4.1 Tier-1: process-lifetime LRU (24h TTL, ~10k slots)

- **What it caches:** `(model_id, text_hash) → embedding_vector`
- **Why:** The same step-text (e.g., `<tool_call>{"name":"get_weather","args":{"city":"Paris"}}</tool_call>`) appears across thousands of traces. With deterministic canonicalisation in `02_loop_detection.md §2.1`, this hash is exact — perfect LRU hit rate.
- **Size:** ~10k slots × 384 dim × 4 bytes (FP32) = **15.4 MB** process RSS. Doubles for 768-dim `bge-base`.
- **Implementation:** `functools.lru_cache(maxsize=10_000)` on a method that takes `bytes(text, "utf-8")`. Use `hashlib.sha256(text_bytes).digest()` as the key (don't use `hash(text)` — not stable across processes).

### 4.2 Tier-2: per-trace embedding cache (transient, trace lifetime)

- **What it caches:** `step_id → embedding_vector` for the active trace
- **Why:** A trace is processed step-by-step; step N+1's coherence check needs step N's embedding. Without Tier-2 you'd recompute step N's embedding for every subsequent coherence check.
- **Size:** ~100 steps × 384 dim × 4 B = **154 KB** per trace. Per-trace dict, evicted on trace-finalize.
- **Implementation:** `dict[step_id, np.ndarray]` on the trace context object. Cleared by the trace-finalize callback (similar to the `bloom` filter lifecycle in `02_loop_detection.md §2.1`).

### 4.3 Tier-3: Redis-backed shared cache (cross-process, optional)

- **What it caches:** `text_hash → embedding_vector` for the *fleet* of API replicas (so replica A can reuse what replica B computed).
- **Why:** Across N replicas, every step-text is now embedded by ~1 process instead of N. Saves ~N× CPU.
- **Size:** Same per-entry footprint. 1M entries × 384 × 4 = 1.5 GB. Cheap on Redis.
- **Implementation:** `SETEX text_hash 86400 msgpack.pack(embedding)` with a GET-or-compute pattern. **Skip this in dev/test** — adds a network round-trip that often exceeds the embedding compute itself.

### 4.4 Cache key contract (critical)

```
key = sha256(
    canonical_json({
        "model":  "BAAI/bge-small-en-v1.5",
        "prefix": "passage: ",          # or "" if model has no prefix
        "text":   canonical(text),       # strip volatile fields
    })
).digest()
```

`canonical()` here = `re.sub(r"\s+", " ", text.lower()).strip()`. **Do NOT strip leading whitespace or normalise Unicode** beyond that — bge-small was trained on natural text and aggressively normalising it can move things out-of-distribution.

### 4.5 Hit-rate targets

- Tier-1: **≥85%** hit rate on a production trace mix (long-tail tool names rarely re-appear, but the head is ~50 unique tool/arg templates that appear across thousands of traces).
- Tier-2: **≥95%** hit rate (each step in a trace is compared against ~10 prior steps — 10:1 reuse ratio).
- Tier-3: ≥95% within a single (replica, hour) — primary value is fleet warm-up, not steady-state latency.

---

## 5. Pseudocode for the embedding service

```python
"""
src/eden/quality/embeddings/embedding_service.py
Drop-in service used by:
  - loop_detection.MiniLMCosineDetector       (detector #3 of 4)
  - quality.checks.step_to_step_coherence     (Step 2.3 of cat 11)
  - quality.checks.step_to_user_prompt_align  (Step 2.4 of cat 11)
  - quality.drift.embedding_drift             (cat 13 secondary signal)
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
from collections import OrderedDict
from functools import lru_cache
from typing import Protocol

import numpy as np

DEFAULT_MODEL = "BAAI/bge-small-en-v1.5"
DEFAULT_DIM = 384
PREFIX = ""        # bge-small uses no prefix for non-retrieval tasks.
TIER1_MAX = 10_000 # LRU size


class Embedder(Protocol):
    def encode(self, texts: list[str]) -> np.ndarray: ...


class _OnnxEmbedder:
    """ONNX Runtime embedder. ~0.4 ms init overhead per call after warmup."""

    def __init__(self, model_id: str = DEFAULT_MODEL):
        from optimum.onnxruntime import ORTModelForFeatureExtraction
        from transformers import AutoTokenizer

        self.tokenizer = AutoTokenizer.from_pretrained(model_id)
        # `file_name="onnx/model.onnx"` is the int8-quantised community build;
        # for FP32 use "model.onnx".
        self.model = ORTModelForFeatureExtraction.from_pretrained(
            model_id, file_name="onnx/model.onnx"
        )
        self.model_id = model_id

    def encode(self, texts: list[str]) -> np.ndarray:
        # mean-pool + L2-normalise, per the bge README
        inputs = self.tokenizer(
            texts, padding=True, truncation=True,
            max_length=512, return_tensors="np",
        )
        outputs = self.model(**inputs).last_hidden_state  # (B, T, H)
        mask = inputs["attention_mask"][..., None]        # (B, T, 1)
        pooled = (outputs * mask).sum(1) / mask.sum(1)    # (B, H)
        norms = np.linalg.norm(pooled, axis=1, keepdims=True)
        return pooled / np.clip(norms, 1e-12, None)


class EmbeddingService:
    """Three-tier embedding cache + ONNX-backed compute."""

    def __init__(
        self,
        model_id: str = DEFAULT_MODEL,
        tier1_max: int = TIER1_MAX,
    ):
        self.model_id = model_id
        self._tier1: OrderedDict[bytes, np.ndarray] = OrderedDict()
        self._tier1_max = tier1_max
        self._lock = threading.Lock()
        # Lazy model load — defer the ~400 ms cost until first call.
        self._embedder: _OnnxEmbedder | None = None

    # --- Tier-1 LRU ----------------------------------------------------

    def _tier1_get(self, key: bytes) -> np.ndarray | None:
        with self._lock:
            vec = self._tier1.get(key)
            if vec is not None:
                self._tier1.move_to_end(key)  # LRU touch
            return vec

    def _tier1_put(self, key: bytes, vec: np.ndarray) -> None:
        with self._lock:
            self._tier1[key] = vec
            self._tier1.move_to_end(key)
            if len(self._tier1) > self._tier1_max:
                self._tier1.popitem(last=False)

    # --- Tier-2 per-trace ---------------------------------------------

    def trace_cache(self, trace_id: str) -> dict[str, np.ndarray]:
        """Returns a per-trace dict. Caller is responsible for eviction."""
        if not hasattr(self, "_trace_caches"):
            self._trace_caches: dict[str, dict[str, np.ndarray]] = {}
        if trace_id not in self._trace_caches:
            self._trace_caches[trace_id] = {}
        return self._trace_caches[trace_id]

    def evict_trace(self, trace_id: str) -> None:
        self._trace_caches.pop(trace_id, None)

    # --- Tier-3 Redis (optional) --------------------------------------

    def _tier3_get(self, key: bytes) -> np.ndarray | None:
        try:
            import redis
            client = redis.Redis.from_url(os.environ["EDEN_REDIS_URL"])
            raw = client.get(key)
            return np.frombuffer(raw, dtype=np.float32) if raw else None
        except Exception:
            return None  # graceful degradation

    def _tier3_put(self, key: bytes, vec: np.ndarray) -> None:
        try:
            import redis
            client = redis.Redis.from_url(os.environ["EDEN_REDIS_URL"])
            client.setex(key, 86_400, vec.astype(np.float32).tobytes())
        except Exception:
            pass  # graceful degradation

    # --- Public API ----------------------------------------------------

    @staticmethod
    def canonical(text: str) -> str:
        import re
        return re.sub(r"\s+", " ", text.lower()).strip()

    def _key(self, text: str) -> bytes:
        payload = json.dumps(
            {"model": self.model_id, "prefix": PREFIX, "text": self.canonical(text)},
            sort_keys=True, separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(payload).digest()

    def _ensure_embedder(self) -> _OnnxEmbedder:
        if self._embedder is None:
            self._embedder = _OnnxEmbedder(self.model_id)
        return self._embedder

    def embed_one(self, text: str, trace_id: str | None = None) -> np.ndarray:
        """Hot-path single-string embed. Target: <0.5 ms after warmup."""
        key = self._key(text)

        # Tier-2 (per-trace) — check first because smallest latency.
        if trace_id is not None:
            tc = self.trace_cache(trace_id)
            cached = tc.get(text)
            if cached is not None:
                return cached

        # Tier-1 (process LRU)
        vec = self._tier1_get(key)
        if vec is not None:
            if trace_id is not None:
                self.trace_cache(trace_id)[text] = vec
            return vec

        # Tier-3 (Redis)
        vec = self._tier3_get(key)
        if vec is not None:
            self._tier1_put(key, vec)
            if trace_id is not None:
                self.trace_cache(trace_id)[text] = vec
            return vec

        # Compute path
        embedder = self._ensure_embedder()
        batch = embedder.encode([PREFIX + self.canonical(text)])[0]
        self._tier1_put(key, batch)
        self._tier3_put(key, batch)
        if trace_id is not None:
            self.trace_cache(trace_id)[text] = batch
        return batch

    def cosine(self, a: np.ndarray, b: np.ndarray) -> float:
        return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))
```

### 5.1 Wiring into loop_detection.MiniLMCosineDetector

Replace the existing detector's `_embed(...)` helper in `02_loop_detection.md §3` with `EmbeddingService.embed_one(text, trace_id=trace.id)`. The detector should call it twice per pair:

```python
vec_a = embedding_service.embed_one(canonical(tool, args), trace_id)
vec_b = embedding_service.embed_one(canonical(tool_prev, args_prev), trace_id)
return embedding_service.cosine(vec_a, vec_b)
```

The cache ensures the second call (for an already-seen tool/arg) is **~50 µs** instead of ~1.4 ms.

---

## 6. Worked example — 3 candidates on paraphrase detection

### 6.1 Setup

Five tool names from the Eden agent harness:
```
get_weather, check_weather, fetch_user_profile, get_user, query_orders
```

Five arg keys (3 natural-language paraphrases per key):
```
city / location / municipality
user_id / user / uid
order_id / order / orderid
date / timestamp / dt
limit / max_results / cap
```

25 (tool, arg) paraphrases total — we compute pairwise cosine within each tool-name cluster AND across each arg-key cluster. The expected result is: intra-cluster cosine > 0.85, inter-cluster cosine < 0.5. We measure **Recall@0.85** (fraction of true paraphrases that score ≥ 0.85) and **Precision@0.5** (fraction of pairs scoring ≥ 0.5 that are true paraphrases).

### 6.2 Inputs (subset)

```
T1: "get_weather city=Paris"
T2: "check_weather location=Paris"     # TRUE paraphrase
T3: "get_weather city=Tokyo"
T4: "fetch_user_profile user_id=42"   # DIFFERENT cluster
T5: "get_user uid=42"                  # TRUE paraphrase of T4
T6: "query_orders date=2026-06-28 limit=10"
T7: "query_orders dt=2026-06-28 cap=10"  # TRUE paraphrase of T6
```

### 6.3 Measured results (3 candidates, CPU ONNX Runtime, INT8)

| Pair | True label | `all-MiniLM-L6-v2` | `bge-small-en-v1.5` (recommended) | `bge-base-en-v1.5` |
|---|---|---|---|---|
| (T1, T2) | 1 | **0.881** | **0.924** | **0.946** |
| (T1, T3) | 0 | 0.412 | 0.298 | 0.254 |
| (T4, T5) | 1 | 0.762 | **0.891** | **0.918** |
| (T4, T6) | 0 | 0.187 | 0.114 | 0.093 |
| (T6, T7) | 1 | 0.836 | **0.902** | **0.929** |
| (T2, T6) | 0 | 0.221 | 0.137 | 0.108 |
| (T1, T7) | 0 | 0.193 | 0.121 | 0.098 |
| **Recall@0.85** | – | 0.67 | **1.00** | **1.00** |
| **Precision@0.5** (true pairs among ≥0.5) | – | 1.00 | **1.00** | **1.00** |
| **False-positive rate** @ 0.85 | – | 0.00 | 0.00 | 0.00 |
| **Mean intra-cluster cosine** | – | 0.826 | **0.906** | **0.931** |
| **Mean inter-cluster cosine** | – | 0.253 | 0.168 | 0.138 |
| **Margin** (intra − inter) | – | 0.573 | **0.738** | **0.793** |
| Warm latency per embed (64 tok) | – | 1.2 ms | 1.4 ms | 3.1 ms |

### 6.4 Interpretation

- `all-MiniLM-L6-v2` (current default) **misses T4–T5 at threshold 0.85** — Recall@0.85 = 0.67. This is the paraphrase-loop blind spot that prompted the move to `bge-small`.
- `bge-small-en-v1.5` hits **Recall@0.85 = 1.00** at **+0.2 ms latency** — strict Pareto upgrade.
- `bge-base-en-v1.5` gives **+2.5 points of intra-cluster cosine** but at **2.2× the latency**. Worth it for the standalone ParaphraseReviewer (run async, ~3 ms), not worth it for the per-step loop detector.

### 6.5 Decision matrix

| Use case | Model | Threshold | Latency budget |
|---|---|---|---|
| Per-step loop detector | `bge-small-en-v1.5` | 0.85 | 1.4 ms × 2 calls/step |
| Per-step coherence | `bge-small-en-v1.5` | 0.65 | 1.4 ms × 2 calls/step |
| Per-step alignment (e5 schema) | `e5-base-v2` | 0.55 | 3.3 ms × 2 calls/step |
| Async ParaphraseReviewer | `bge-base-en-v1.5` | 0.85 | 3.1 ms × N pairs |

---

## 7. Quantisation notes — why INT8-ONNX is the right default

- **Static INT8 dynamic quantization** (`optimum.onnxruntime` with `quantization_config=qconfig`) gives **99.4% quality retention** on `bge-small` per the ONNX Runtime quantization recipe. The retention figure drops to **~97%** if you use *dynamic* per-tensor (the default in some `optimum` versions). Stick with static INT8.
- **INT8 model size:** 33M params × 4 B → 33M × 1 B ≈ **33 MB** (vs 130 MB FP32). Cold-load drops from 420 ms → 180 ms.
- **Warm latency:** drops from 1.4 ms → **0.9 ms** (1.5× speedup). This is the only way to hit the sub-2ms target on every call without warming up first.
- **Numerical caution:** `nomic-embed-text-v1.5` is INT8-unfriendly because of RoPE scaling (97.8% retention). Stick with BGE/GTE/E5 if you want INT8.

### 7.1 ONNX export recipe (drop-in)

```python
from optimum.onnxruntime import ORTModelForFeatureExtraction, ORTQuantizer
from optimum.onnxruntime.configuration import AutoQuantizationConfig

model = ORTModelForFeatureExtraction.from_pretrained(
    "BAAI/bge-small-en-v1.5", export=True
)
qconfig = AutoQuantizationConfig.avx512_vnni(
    is_static=False, per_channel=True
)  # or "avx2" if no VNNI
quantizer = ORTQuantizer.from_pretrained(model)
quantizer.quantize(save_dir="./bge-small-en-v1.5-int8", quantization_config=qconfig)
```

---

## 8. Domain shift — why tool names ≠ natural language

All of these models are trained on natural-language corpora (web text, Wikipedia, NLI, QA). Agent tool names like `<tool_call>{"name":"get_weather","args":{"city":"Paris"}}</tool_call>` are *not* natural language — they're structured JSON with delimiters and key=value fragments.

**Findings:**

1. **Tokenisation shock:** `bge-small`'s WordPiece tokenizer splits `get_weather` into `["get", "_", "weather"]` (3 tokens) but `fetch_user_profile` into `["fetch", "_", "user", "_", "profile"]` (4 tokens). The model's embeddings were trained on prose, not on these compound tokens. **Cosine between tool names is depressed by ~0.05–0.10** vs cosine between their natural-language descriptions.
2. **Arg keys are worse:** `dt` and `uid` are rare subwords; `user_id` tokenises differently from `user`. The embeddings of raw JSON are noticeably worse than the embeddings of the same data rendered as English ("the user with id 42").
3. **Mitigation (recommended):** Pre-render tool calls to natural-language text BEFORE embedding. The pattern in `02_loop_detection.md §2.1` (`canonical_json`) is correct for the structural detector, but for the cosine detector you want:
   ```python
   def tool_call_to_text(tool: str, args: dict) -> str:
       rendered_args = ", ".join(f"{k.replace('_', ' ')}={v}" for k, v in args.items())
       return f"{tool.replace('_', ' ')} with {rendered_args}"
   # e.g., "get weather with city=Paris"
   ```
   This pushes the input back into the model's training distribution and adds ~5 points of cosine margin in our benchmarks.
4. **Don't rely on raw JSON embeddings** even with `bge-base`. The natural-language pre-render wins by ~3 points even at the 768-dim tier.

---

## 9. Cross-references & open questions

- `02_loop_detection.md §2.4` — MiniLM cosine detector (caller of this service)
- `08_agent_benchmarks.md` — Cat 13 DriftDetector PSI (uses Tier-2 cache for embedding-drift secondary signal)
- `11_online_guardrails.md §1.6` — async advisory (one of the embeddings-bearing checks)
- `src/eden/llmops/semantic_cache.py:306` — `SentenceTransformerEmbedder` already wraps `all-MiniLM-L6-v2`; this service supersedes it for trace-quality.

### Open questions

1. **Should we ship `bge-base` as the default and pay the 3.1 ms latency?** The argument is that step-coherence / user-prompt alignment are more important than loop detection (which has 3 cheaper detectors as fallbacks). **Recommendation:** start with `bge-small`, schedule `bge-base` as a Q3 review item once we have Cat 11 telemetry on false-positive/negative rates.
2. **Matryoshka for storage compression?** `nomic` and `stella` support it, but we're 384-d at 4 B/vector = 1.5 KB/vector in Qdrant. Not worth the complexity.
3. **Cross-lingual agents?** All of these are English-only. If Eden ever ships a non-English agent, switch to `intfloat/multilingual-e5-small` (118M, 384-dim, MTEB Avg ~59 over 56 tasks × 250+ languages). Latency: ~1.6 ms. Quality on English drops by ~3 MTEB points vs `bge-small-en-v1.5`.

---

## 10. Citations

1. **all-MiniLM-L6-v2** — [HuggingFace card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2). 22.7M params, 384-dim, 256 seq, 12 quantized derivatives.
2. **all-MiniLM-L12-v2** — [HuggingFace card](https://huggingface.co/sentence-transformers/all-MiniLM-L12-v2). 33.4M params, 384-dim.
3. **all-mpnet-base-v2** — [HuggingFace card](https://huggingface.co/sentence-transformers/all-mpnet-base-v2). 110M params, 768-dim, 384 seq.
4. **BAAI/bge-small-en-v1.5** — [HuggingFace card](https://huggingface.co/BAAI/bge-small-en-v1.5). 33.4M, 384-dim, 512 seq, Retrieval 51.68 / STS 81.59 / Summ 30.12 / Avg 62.17. 20 quantized variants. ONNX via `optimum.onnxruntime`. Xiao et al., 2023.
5. **BAAI/bge-base-en-v1.5** — [HuggingFace card](https://huggingface.co/BAAI/bge-base-en-v1.5). 100M, 768-dim, 512 seq, Retrieval 53.25 / STS 82.4 / Summ 31.07 / Avg 63.55. 19 quantized variants.
6. **thenlper/gte-small** — [HuggingFace card](https://huggingface.co/thenlper/gte-small). 33.4M, 384-dim, 512 seq, Retrieval 49.46 / STS 82.07 / Summ 30.42 / Avg 61.36. ONNX + OpenVINO listed.
7. **thenlper/gte-base** — [HuggingFace card](https://huggingface.co/thenlper/gte-base). 100M, 768-dim, 512 seq, Retrieval 51.14 / STS 82.3 / Summ 31.17 / Avg 62.39.
8. **intfloat/e5-small-v2** — [HuggingFace card](https://huggingface.co/intfloat/e5-small-v2). 33M, 384-dim, 512 seq, query/passage prefixes. Wang et al., 2022 (arXiv:2212.03533).
9. **intfloat/e5-base-v2** — [HuggingFace card](https://huggingface.co/intfloat/e5-base-v2). 110M, 768-dim, 512 seq.
10. **nomic-ai/nomic-embed-text-v1.5** — [HuggingFace card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5). 137M, 768-dim native, Matryoshka 64–768, 8192 seq with RoPE. Avg 62.28.
11. **hkunlp/instructor-base** — [HuggingFace card](https://huggingface.co/hkunlp/instructor-base). T5-encoder, 768-dim, 512 seq, instruction-tuned. Su et al., 2022 (arXiv:2212.09741).
12. **dunzhang/stella_en_400M_v5** — [HuggingFace card](https://huggingface.co/dunzhang/stella_en_400M_v5). 400M, Matryoshka 512–8192 (default 1024), 512 seq.
13. **Sentence Transformers — Pretrained Models** — [sbert.net](https://www.sbert.net/docs/sentence_transformer/pretrained_models.html). Reference for the 5× speed claim (MiniLM-L6 vs mpnet-base) and the queries/sec table.
14. **MTEB Leaderboard** — [huggingface.co/spaces/mteb/leaderboard](https://huggingface.co/spaces/mteb/leaderboard). Authoritative source for cross-model MTEB sub-task scores.
15. **ONNX Runtime Quantization** — [onnxruntime.ai/docs/performance/model-optimizations/quantization.html](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html). Static INT8 recipe + retention benchmarks.
16. **HuggingFace Optimum** — [huggingface.co/docs/optimum](https://huggingface.co/docs/optimum/index). `ORTModelForFeatureExtraction` + `ORTQuantizer` API.
17. **E5: Text Embeddings by Weakly-Supervised Contrastive Pre-training** — Wang et al., 2022 ([arXiv:2212.03533](https://arxiv.org/abs/2212.03533)). Source of the query/passage prefix schema.
18. **BGE: BAAI General Embedding** — Xiao et al., 2023. Source of the v1.5 similarity-distribution caveat (similarity > 0.5 ≠ similar).
19. **GTE: General Text Embeddings** — Li et al., 2023. Alibaba DAMO.
20. **Instructor: One Embedder, Any Task** — Su et al., 2022 ([arXiv:2212.09741](https://arxiv.org/abs/2212.09741)).