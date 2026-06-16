---
title: Eden Judge v2 — SLM-as-Judge Training Plan
status: PLANNING (pre-execution)
last_updated: 2026-06-11
version: 0.1
author: Eden Observability Team
related: docs/eden-observability-gap-roadmap.md
---

# Eden Judge v2 — SLM-as-Judge Training Plan

> **Goal:** Build an in-house, fine-tuned small language model
> that powers Eden's 7 Cat 3 baseline judges + 3 Galileo Luna-2
> judges at **$0.001 per 1k judge calls** (vs ~$7.50 per 1k on
> GPT-4o class) with sub-200ms p95 latency. **Closes the 250×
> cost gap to Galileo Luna-2 and Braintrust's GPT-4o-LJ** at
> parity accuracy.
>
> **Status:** PLANNING. The architecture, datasets, training
> recipe, and cost analysis are locked. Pending: (1) greenlight
> to start, (2) base model decision (Qwen 3.5 4B vs SmolLM3 3B),
> (3) data labelling budget.
>
> **Reference:** Galileo Luna-2 paper
> (<https://arxiv.org/abs/2602.18583>). The plan below ports
> Luna-2's methodology to Eden's stack. The Luna-2 paper
> reports 80× inference cost reduction, 20× latency reduction,
> matches frontier-LLM-judge accuracy, processing 100B+ tokens
> per month for Galileo's customers.

---

## Table of Contents

1. [Executive summary](#executive-summary)
2. [Why now (the 250× cost problem)](#why-now-the-250-cost-problem)
3. [Luna-2 architecture (what we're copying)](#luna-2-architecture-what-were-copying)
4. [Base model selection](#base-model-selection)
5. [Datasets (curated stack)](#datasets-curated-stack)
6. [Training methodology](#training-methodology)
7. [Per-metric LoRA heads (the "many metrics on one GPU" trick)](#per-metric-lora-heads)
8. [Inference serving](#inference-serving)
9. [Eval methodology](#eval-methodology)
10. [Integration with Eden's JudgeRegistry](#integration-with-edens-judgeregistry)
11. [Cost analysis](#cost-analysis)
12. [Rollout plan](#rollout-plan)
13. [Risks and mitigations](#risks-and-mitigations)
14. [Decisions to make before starting](#decisions-to-make-before-starting)
15. [Cross-references](#cross-references)

---

## Executive summary

| | Today (GPT-4o LJ) | Luna-2 (Galileo) | Eden v2 (this plan) |
|---|---|---|---|
| Judge cost per 1k calls | $7.50 | $1.00 | **$1.00** |
| Latency p50 | 1,200 ms | 80 ms | **<100 ms** |
| Latency p95 | 3,000 ms | 200 ms | **<200 ms** |
| Agreement with GPT-4 | 100% (it is GPT-4) | ~94% | **target ≥90%** |
| Throughput (1× A100) | ~50 calls/sec | 500+ calls/sec | **500+ calls/sec** |
| Cost vs GPT-4o baseline | 1× | 0.13× | **0.13×** |
| Latency vs GPT-4o baseline | 1× | 0.07× | **0.07×** |
| Open source? | n/a | No (proprietary) | **Yes (Apache 2.0)** |

The 250× cost gap to Galileo's hosted Luna-2 (Luna-2 at
**$0.02/1M tokens**) is the single biggest reason Eden is
"not definitively the best" for agent observability at
production scale. Closing that gap with an in-house
Luna-2-equivalent is the highest-ROI engineering investment
Eden can make in 2026.

**Bottom line:** ship an Eden-branded, open-source
Luna-2-equivalent SLM that powers all 7 Cat 3 judges + the 3
existing Galileo Luna-2 judges (which we can effectively
replace with our own). Cost per 1M traces drops from
~$50k/mo to ~$1k/mo at the 100M-trace scale. Latency drops
from seconds to sub-200ms. The 7 Cat 3 stub judges
(groundedness, relevance, safety, satisfaction + the
3 Galileo Luna-2 judges) become live, production-quality.

---

## Why now (the 250× cost problem)

Eden's current judge stack calls the `OpenRouterClient` with
GPT-4o-class models for every judge call. The cost shape:

```
Per judge call:
  Input:  ~1,500 tokens (judge prompt + trace input)
  Output: ~500 tokens  (rationale + score)
  Model:  GPT-4o class
  Cost:   1.5k * $5/1M + 0.5k * $15/1M = $0.015 per call

Per 1k judge calls:  $15
Per 1M judge calls:  $15,000
Per 100M judge calls: $1,500,000
```

For an org running 1M LLM calls per month through Eden,
**judge cost is 30-50% of the total Eden bill**. This is
the single largest objection in enterprise sales.

Galileo Luna-2's published economics:

```
Per judge call (Luna-2):
  Input:  ~1,500 tokens
  Output: 1 token  (single-token classifier)
  Model:  Luna-2 3B
  Cost:   1.5k * $0.02/1M + 1 * $0.06/1M = ~$0.00003 per call

Per 1k judge calls:  $0.03
Per 1M judge calls:  $30
Per 100M judge calls: $3,000
```

**50× cheaper at 1M calls, 500× cheaper at 100M calls.**

Source: Luna-2 paper §5.3 reports "inference cost reduction
by over 80x and latency by over 20x" using a 3B backbone.

---

## Luna-2 architecture (what we're copying)

Luna-2's design (Goel et al., arXiv 2602.18583) is a 3-layer
trick we replicate directly:

### Layer 1: Single-token classifier adaptation

Instead of asking the SLM to generate a verbose rationale and
parse it (the standard LLM-as-judge pattern), Luna-2 reframes
each metric as a **single-token classification problem**.

The model is prompted to output a literal `"True"` or
`"False"` token. At inference time, we read the **logits for
the next-token position** and take the normalized probability
of "True" as the score.

```python
# Standard LLM-as-judge (current Eden judges):
prompt = "...judge this response... Return JSON {score, rationale}"
output = model.generate(prompt)             # 500 tokens
score = json.loads(output)["score"]         # fragile parsing

# Luna-2-style single-token classifier:
prompt = "...judge this response. Output True or False."
logits = model.forward(prompt)              # 1 forward pass
score = softmax(logits[true_token], logits[false_token])[true_token]
                                        # ~0.0-1.0, no parsing
```

This collapses latency from "generate 500 tokens at 30 tok/s"
(~17 seconds) to "one forward pass, read one logit"
(~80ms p50). It also collapses cost proportionally.

### Layer 2: Shared base + per-metric LoRA heads

Luna-2 keeps a **single base SLM** (frozen, shared across
all metrics) and trains a **separate LoRA adapter** for each
metric. The base can be Llama-3B, Mistral-7B, or Qwen-3
(Galileo uses Llama-family as the default).

```
[Qwen 3.5-4B base, frozen]
   ├── LoRA r=16: hallucination
   ├── LoRA r=16: correctness
   ├── LoRA r=16: groundedness
   ├── LoRA r=16: relevance
   ├── LoRA r=16: safety
   ├── LoRA r=16: tone
   ├── LoRA r=16: satisfaction
   ├── LoRA r=16: action_completion
   ├── LoRA r=16: tool_selection
   └── LoRA r=16: reasoning_coherence
```

The LoRA heads are tiny (~10 MB each on a 4B base). On a
single A100 80GB, you can host the base (8 GB AWQ-4bit) +
**20-30 LoRA heads** hot in memory and serve all of them
concurrently. vLLM's `--enable-lora` flag handles the dynamic
loading; the router picks the head per `metric_id`.

### Layer 3: Multi-tenant serving of many metrics on one GPU

Luna-2 deploys as a vLLM endpoint with continuous batching.
A single A100 serves 100+ tenants' judge workloads
concurrently because:

1. Each call is **one forward pass** (no generation loop)
2. The base is **frozen** and shared (single load, one KV cache)
3. LoRA heads are **tiny** (10 MB each, hot in GPU memory)
4. Continuous batching keeps the GPU busy at 500+ calls/sec

Luna-2's reported production numbers (paper §5.4):
* 100M+ AI sessions protected
* 100B+ tokens/month processed
* $30M+ annual eval cost savings for Galileo's customers
* Latency p50 ~80ms, p95 <200ms on a single 3B backbone

These are the targets Eden v2 will hit (or beat) on a 4B
backbone.

---

## Base model selection

### Candidates (June 2026)

| Model | Params | License | Context | Strengths | Weaknesses | Verdict |
|---|---|---|---|---|---|---|
| **Qwen 3.5-4B** | 4.0B | Apache 2.0 | 262K native, ~1M extended | MMLU-Redux 88.8, GPQA Diamond 76.2, TAU2-Bench 79.9 (agent); AWQ 4-bit published; vLLM-native; 201 languages; natively multimodal (text+image+video); thinking mode toggleable | Newer, smaller community than Llama | **✅ PRIMARY** |
| **SmolLM3-3B** | 3.0B | Apache 2.0 | 128K | Fully open recipe (data mixture + training configs public); beats Llama 3.2 3B and Qwen 2.5 3B on aggregate | Slightly weaker reasoning than Qwen 3.5 4B | **✅ ALTERNATIVE** |
| **Llama 3.2 3B** | 3.0B | Llama Community | 8K | Battle-tested; Luna-2's default | License; 8K context (no YaRN) | ⚠️ license |
| **Phi-4-mini** | 3.8B | MIT | 128K | Strong reasoning per MB | Less battle-tested as judge; no AWQ 4-bit published | ⚠️ verify |
| **Gemma 3 4B** | 4.0B | Gemma terms | 128K | Multimodal (we don't need) | Custom license (redistribution friction) | ❌ license |

### Decision: Qwen 3.5 4B (primary), SmolLM3 3B (fallback)

**Primary: Qwen 3.5-4B**
- Apache 2.0 — commercial + redistribution OK (Galileo is
  limited to Llama Community License for Llama-based Luna-2;
  Eden can be more open). **Released March 2, 2026.**
- **Natively multimodal** (text + image + video) — beats
  GPT-5-Nano on MMMU-Pro (66.3 vs 57.2), MathVision
  (74.6 vs 62.2), OmniDocBench (86.2 vs 55.9). Even
  though judge prompts are text-only today, this gives
  us a free upgrade path to multimodal judges in v2.1
  without a model swap.
- AWQ 4-bit quantization is **officially published** on
  Hugging Face (`Qwen/Qwen 3.5-4B-AWQ`) — we don't need to
  quantize ourselves
- 262K context natively (1M extended) covers 100% of
  judge prompts (most are <4K tokens); long-context
  AA-LCR 57.0, LongBench v2 50.0 — best in class
- MMLU-Redux 88.8 (beats GPT-OSS-20B at 5× more params),
  C-Eval 85.1, GPQA Diamond 76.2, IFEval 89.8 — the
  top-scoring sub-5B model in March 2026 benchmarks
- 201-language support covers Eden's global customer
  base (vs Llama 3.2 3B's 8 languages)
- 201-language support covers Eden's global customer
  base (vs Llama 3.2 3B's 8 languages)
- MMLU-Redux 83.7% thinking, 77.3% non-thinking — competitive
  with 7B models from 2024
- LiveBench 2024-11-25: 63.6 thinking, 48.4 non-thinking
- 6-language support (en, zh, ja, ko, fr, de) — useful for
  global customers
- vLLM-native, SGLang-native, Marlin-kernel-friendly for max
  throughput

**Fallback: SmolLM3-3B**
- Same Apache 2.0 license
- Fully open training recipe (data mixture, configs, training
  script all published) — important for the "open source the
  result" path
- 128K context, beats Llama 3.2 3B on aggregate
- Slightly weaker than Qwen 3.5 4B on reasoning (LiveBench
  not directly comparable) — but if Qwen 3.5 4B proves unstable
  in fine-tuning, SmolLM3 is the safety net

### Why not Llama 3.2 3B (Luna-2's default)?

* License: Llama Community License has a 700M-MAU cap that
  Eden's enterprise customers will exceed; redistribution is
  restricted; the AUP bans some legitimate use cases.
* Context: 8K only, no YaRN — too small for traces with
  long contexts (RAG over docs, multi-turn agents).
* Both SmolLM3 3B and Qwen 3.5 4B are competitive on MMLU and
  have better licenses.

### Hardware fit

| Model | FP16 VRAM | AWQ-4bit VRAM | Single A100 80GB? | Single L4 24GB? |
|---|---|---|---|---|
| Qwen 3.5-4B | 8 GB | **2.5 GB** | ✅ + 30 LoRA heads | ✅ + 5 LoRA heads |
| SmolLM3-3B | 6 GB | 2.0 GB | ✅ + 40 LoRA heads | ✅ + 6 LoRA heads |

A **single A100 80GB** can host the base + 30+ LoRA heads
with 60+ GB of headroom for KV cache. That's the entire
production deployment on one GPU.

A **single L4 24GB** (Galileo's recommended minimum for
self-hosted Luna-2) can host the AWQ-quantized base + 5-6
LoRA heads — enough for a tenant's primary metrics.

---

## Datasets (curated stack)

### Public datasets (CC-BY-4.0 or MIT licensed)

| Dataset | Size | License | Format | What it teaches | Source |
|---|---|---|---|---|---|
| **UltraFeedback** | 61k preference pairs | CC-BY-4.0 | `{prompt, response_a, response_b, chosen_id, scores: {helpfulness, truthfulness, honesty, instruction_following}}` | General preference — primary SFT signal | `openbmb/UltraFeedback` |
| **HelpSteer2** | 20k train + 1k val | CC-BY-4.0 | `{prompt, response, helpfulness, correctness, coherence, complexity, verbosity}` (Likert 0-4) | Direct assessment with 5 attributes; CC-BY-4.0 (commercial OK) | `nvidia/HelpSteer2` |
| **Prometheus Feedback Collection** | 100k direct assessment | MIT | `{rubric, prompt, response, score, rationale, ref_answer}` | Direct assessment with rubrics — perfect for Cat 21 rubric-style judges | `prometheus-eval/Feedback-Collection` |
| **Prometheus Preference Collection** | 200k pairwise | MIT | `{rubric, prompt, response_a, response_b, feedback, chosen}` | Pairwise with rubrics — perfect for DPO stage | `prometheus-eval/Preference-Collection` |
| **Auto-J pairwise** | 3.4k pairwise | MIT | `{usermsg, target_output, gt_label, scenario}` | 58 scenarios from chatbot_arena | `GAIR-NLP/auto-j` |
| **Auto-J single** | 960 single | MIT | `{usermsg, target_output, pred_score, scenario}` | Single-response with scenario criteria | `GAIR-NLP/auto-j` |
| **Skywork-Critic** | 80k | Apache 2.0 | Pairwise with detailed critique | Pairwise reasoning quality | `Skywork/Skywork-Critic` |
| **UltraInteract_sft** | 86k | Apache 2.0 | Multi-step reasoning chains | Reasoning coherence judge | `openbmb/UltraInteract_sft` |

**Total: ~570k labelled examples** (raw, before filtering).

### Eval-only benchmarks (held out, never trained on)

| Benchmark | Size | What it tests | Source |
|---|---|---|---|
| **JudgeBench** | ~500 | Reasoning + factual correctness (LLM-judge specific) | `ScalerLab/JudgeBench` |
| **RM-Bench** | 1,327 | Style bias + subtlety | `THU-KEG/RM-Bench` (ICLR 25 Oral) |
| **PPE** | 2,555 prompts × 12 domains | Real human preferences from Chatbot Arena | `lmarena/PPE` |
| **RewardBench v2** | ~3,000 | Chat / safety / reasoning | `allenai/reward-bench-2` |

### In-house synthetic (generated by this plan)

* **EdenGolden-v1** — 5,000 traces manually labeled by the
  Eden team across the 7 Cat 3 metrics (target: 700/metric).
  *Sources:* the existing `judge_scores` table filtered to
  high-confidence GPT-4o calls + the `GoldenDataset`
  registry's existing `gd_auto_production` set.
* **EdenRUBRIC-v1** — 2,000 rubric-prompted completions per
  metric. For each of the 7 Cat 3 metrics, generate the
  rubric prompt template (using `OpenRouterClient` with
  `claude-sonnet-4` as the teacher) and pair with a
  yes/no label derived from the existing `judge_scores`.

**Total labelled training data after filtering:**
~30k high-quality examples for SFT, ~80k for DPO. This is in
line with Luna-2's "2k-5k per metric" recommendation (Goel
et al. §3.3: "approximately 2k-5k training examples suffice
for stable metric performance").

### License compatibility check

* Qwen 3.5-4B: Apache 2.0 — all datasets above are compatible
  (CC-BY-4.0, MIT, Apache 2.0)
* SmolLM3-3B: Apache 2.0 — same
* Resulting trained model: we publish under Apache 2.0
  (compatible with the base). LoRA heads are too small to
  warrant separate licensing.

---

## Training methodology

Luna-2's training has 3 stages. We follow a 2-stage version
that drops RLAIF (deferred — see §14 decisions).

### Stage 1: SFT on direct-assessment data

**Goal:** Teach the model to (a) read the metric prompt,
(b) output the literal "True"/"False" token, (c) match the
teacher's label distribution.

**Data:** HelpSteer2 (20k) + Prometheus Feedback (100k,
filter to highest quality 20k) + Auto-J single (960) +
EdenGolden-v1 (5k) = **~46k examples**.

**Format:**

```python
# Single-token classifier format (Luna-2's approach)
messages = [
    {"role": "system", "content": SYSTEM_PROMPT_FOR_METRIC},
    {"role": "user", "content": f"Input: {trace_input}\nResponse: {trace_output}"},
]
target = "True" if label == 1 else "False"  # one token
# Loss: cross-entropy on the target token at the next position
```

**Hyperparameters** (Luna-2's defaults, Goel et al. §3.3):

| Hyperparam | Value | Notes |
|---|---|---|
| Optimizer | AdamW | standard |
| LR | 1e-4 (LoRA), 5e-5 (full) | cosine to 0, 3% warmup |
| Epochs | 3-5 | tune per metric |
| Effective batch size | 32-64 | per_device × grad_accum |
| LoRA rank | 16 | Luna-2 default |
| LoRA alpha | 16 | |
| LoRA dropout | 0 | |
| LoRA target modules | `q_proj, k_proj, v_proj, o_proj` | attention only |
| Max sequence length | 2048 | judge prompts are short |
| bf16 | True | A100 native |

**Training time:** ~6 hours per metric on 1× A100 80GB.
**Cost:** ~$9 per metric (Lambda Labs $1.49/hr).

### Stage 2: DPO on preference data

**Goal:** Calibrate the SFT model so the "True" logit is
higher on chosen vs rejected pairs.

**Data:** UltraFeedback (61k, preference split) + Prometheus
Preference (200k, filter to 40k highest quality) + Auto-J
pairwise (3.4k) = **~104k pairs**.

**Hyperparameters:**

| Hyperparam | Value | Notes |
|---|---|---|
| Optimizer | AdamW | |
| LR | 5e-6 | 10× lower than SFT (DPO is sensitive) |
| Epochs | 2-3 | |
| Effective batch size | 32 | DPO needs more memory (2 models) |
| Beta (β) | 0.1 | standard DPO default |
| Loss | DPO | KTO alternative if binary feedback later |
| LoRA | Reuse from Stage 1 | don't retrain |
| Max length | 2048 | |

**Training time:** ~4 hours on 1× A100 80GB.
**Cost:** ~$6 per metric.

### Stage 3: RLAIF (deferred)

Luna-2's stage 3 is RLAIF (RLHF from AI Feedback) using the
deployed Luna-2 as the reward model. This is what produces
their 10% accuracy gain over BERT-based metrics. **We defer
this to v2.1** until we have 6 months of production judge
data to feed back into the loop. Not in v1 scope.

### Total per-metric training cost

* Stage 1 (SFT): ~$9 + 1 FTE-hour = ~$59
* Stage 2 (DPO): ~$6 + 1 FTE-hour = ~$56
* Eval: ~$3 per run × 4 runs = $12
* **Per metric: ~$127 + 2 FTE-hours**
* 7 Cat 3 metrics: **~$890 + 14 FTE-hours = ~$2,800 with FTE**

For 10 metrics (7 Cat 3 + 3 Galileo): **~$4,000 + 20
FTE-hours**.

### Frameworks

* **Training:** Axolotl or TRL (Hugging Face), with LoRA via
  PEFT. vLLM-compatible.
* **Quantization for training:** QLoRA (4-bit base + LoRA
  adapters in fp16) — fits 4B model + LoRA in 24GB VRAM
  (RTX 4090 / L4).
* **Convert to inference format:** merge LoRA into base,
  quantize to AWQ-4bit with `autoawq` package, push to
  HuggingFace under `eden/judge-qwen3-4b-awq`.

### What we don't do (deliberate cuts)

* **RLAIF** — deferred (see Stage 3)
* **Reasoning-style fine-tuning** (e.g., GRPO + reward
  model) — adds 3-4 weeks, marginal gain at this scale
* **Multi-task joint training of all 10 metrics in one run**
  — harder to debug, no proven gain over per-metric heads
* **Curriculum learning** — over-engineered for v1
* **Mixture-of-Experts** — overkill for 4B; revisit at 13B+

---

## Per-metric LoRA heads

We train one LoRA per metric, with these targets:

### Cat 3 baseline (7 metrics)

| Metric | Single-token target | Source dataset (primary) | Synthetic count |
|---|---|---|---|
| **Hallucination** | True/False | Prometheus Feedback + EdenGolden | 700 + 1,000 synthetic |
| **Correctness** | True/False | HelpSteer2 (correctness) + EdenGolden | 700 + 1,000 synthetic |
| **Groundedness** | True/False | RAGTruth + synthetic | 1,500 synthetic |
| **Relevance** | True/False | HelpSteer2 (relevance) + synthetic | 1,500 synthetic |
| **Safety** | True/False | ToxicChat + BeaverTails + synthetic | 1,500 synthetic |
| **Tone** | True/False | synthetic from brand-voice rubrics | 2,000 synthetic |
| **Satisfaction** | True/False | HelpSteer2 (helpfulness) + EdenGolden | 700 + 1,000 synthetic |

### Galileo Luna-2 (3 metrics we replicate in-house)

| Metric | Single-token target | Source dataset (primary) | Synthetic count |
|---|---|---|---|
| **ActionCompletion** | True/False | AgentBench + synthetic from Cat 16 traces | 2,000 synthetic |
| **ToolSelectionQuality** | True/False | ToolBench + synthetic | 2,000 synthetic |
| **ReasoningCoherence** | True/False | UltraInteract + HelpSteer2 (coherence) | 700 + 1,000 synthetic |

**Total: 10 LoRA heads.** Each is ~10-20 MB on disk, ~20-30
MB in GPU memory (with optimizer state). All 10 fit
comfortably alongside the AWQ-quantized base on a single
A100 80GB.

### "Why per-metric, not multi-task"?

Three reasons:

1. **Debuggability.** When the hallucination judge regresses,
   we know exactly which LoRA to retrain. With a multi-task
   head, a regression could be any of 10 metrics' fault.
2. **Per-tenant customization.** A tenant can fine-tune their
   own LoRA head (Cat 21 Custom-Metric Studio ships here
   naturally) without re-training the base.
3. **Independent version control.** Each head has its own
   version, eval score, and rollback path. Cat 17 closed-loop
   `MetricStudioHook.on_metric_promotion` already supports
   this.

---

## Inference serving

### Stack

* **Engine:** vLLM 0.9+ (the standard for LLM serving in
  2026; broadest model + hardware support; LoRA + AWQ
  + continuous batching all stable)
* **Quantization:** AWQ 4-bit (`Qwen/Qwen 3.5-4B-AWQ`,
  off-the-shelf; 1.5-2% perplexity loss vs FP16, 1.5-2×
  throughput on A100)
* **Batching:** vLLM continuous batching, max batch size 64,
  max num_seqs 256
* **Memory:** ~2.5 GB base (AWQ) + ~300 MB for 10 LoRA heads +
  KV cache. Total < 8 GB on A100 80GB.
* **Endpoint:** OpenAI-compatible API. Reuses the
  `src/eden/api/routes/gateway.py` pattern. Path:
  `/eden-judge/v1/score` (POST).

### OpenAI-compatible request

```json
POST /eden-judge/v1/score
{
  "metric": "hallucination",
  "input": "...",
  "output": "...",
  "context": "...",
  "trace_id": "trc_abc",
  "rubric_id": "rubric_<sha>"
}
```

Response:

```json
{
  "score": 0.87,
  "raw_logits": {"true": 1.45, "false": -2.31},
  "model": "eden-judge-qwen3-4b-awq",
  "lora_id": "lora_hallucination_v1",
  "lora_version": "2026-07-15",
  "latency_ms": 87,
  "tokens_used": 1
}
```

### Throughput targets

| Concurrency | Throughput | p50 latency | p95 latency |
|---|---|---|---|
| 1 | 12 calls/sec | 80ms | 95ms |
| 16 | 180 calls/sec | 88ms | 105ms |
| 64 | 480 calls/sec | 133ms | 187ms |
| 256 | 720 calls/sec | 355ms | 480ms |

**Single A100 80GB target: 500+ calls/sec at <200ms p95.** This
matches Luna-2's published numbers.

### Multi-GPU scaling

Beyond ~720 calls/sec on a single A100, scale to multi-GPU
with vLLM tensor parallelism. Each additional A100 adds
~600 calls/sec. For Eden's 100M-traces/month scale (~50 calls/sec
average, ~5000 peak), **a single A100 80GB is enough**.

### Failover to GPT-4o

The `AIGateway` already has a circuit-breaker + multi-provider
failover (see `src/eden/llmops/ai_gateway.py`). For Luna-2
judges:

1. Route to `eden-judge` endpoint
2. On p99 > 500ms OR error rate > 1%: circuit breaker opens
3. Fall back to GPT-4o via `OpenRouterClient`
4. Cat 17 `MetricStudioHook.on_metric_promotion` fires to
   flag the regression in the closed loop

---

## Eval methodology

### Three-layer evaluation

**Layer 1: Public benchmarks (every PR)**

Run the new SLM judge on these benchmarks. Track over time.

| Benchmark | What it measures | Target |
|---|---|---|
| **JudgeBench** | Reasoning + factual | ≥85% accuracy (vs GPT-4o's ~91%) |
| **RM-Bench** | Style bias + subtlety | ≥80% pair accuracy (vs GPT-4o's ~88%) |
| **PPE** | Real human preference correlation | ≥0.75 Cohen's κ with humans |
| **RewardBench v2** | Chat / safety / reasoning | ≥85% (vs GPT-4o's ~92%) |

**Layer 2: Internal golden set (every release)**

1,000 traces manually labeled by 2 Eden engineers (with
adjudication on disagreement), spanning the 7 Cat 3 metrics
+ 3 Galileo Luna-2 metrics. **Target: Cohen's κ ≥0.75 with
GPT-4-0125.** Below that, we don't ship.

**Layer 3: Production A/B (post-GA only)**

After GA, route 5% of judge calls to both Luna-2-eden and
GPT-4o in parallel. Compare:

* **Agreement rate** (% of cases where both agree within
  ±0.05 score)
* **Calibration** (Brier score on binarised "low quality"
  detection)
* **Tail latency** (p50, p95, p99 for both)
* **Cost per 1k calls** for both

Roll back to GPT-4o if agreement drops <90% over a 7-day
rolling window.

### Adversarial robustness (RobustJudge 2026)

The SoK paper by Liu et al. (arXiv 2603.29403) showed that
open-source judges have 100% ASR (attack success rate)
against simple combined attacks. Before shipping:

* Add 500+ adversarial examples to the training set
  (prompt injection, escape characters, context ignoring,
  fake completions, PAIR-style)
* Re-eval with `promptfoo` or `garak`
* Target: ASR <20% (vs Galileo Luna-2's published <15%)

### Latency SLO

* p50 ≤ 100ms
* p95 ≤ 200ms
* p99 ≤ 500ms
* Cold start ≤ 60s (model load + LoRA warmup)

---

## Integration with Eden's JudgeRegistry

Eden's existing judge infrastructure
(`src/eden/llmops/judges/`) makes this integration
straightforward. The `Judge` ABC
(`src/eden/llmops/judges/base.py`) defines:

```python
class Judge(ABC):
    name: str
    version: str
    model_slot: str

    @abstractmethod
    async def score(
        self, event: "TelemetryEvent", ctx: JudgeContext
    ) -> JudgeScore: ...

    def matches(self, event: "TelemetryEvent") -> bool: ...
```

### New class: `LunaJudge`

```python
class LunaJudge(Judge):
    """Luna-2-style single-token classifier judge.

    Routes through the vLLM-served /eden-judge/v1/score
    endpoint. Falls back to GPT-4o on latency/circuit-breaker
    trip.
    """

    name: str  # e.g., "luna_hallucination"
    version: str  # e.g., "2026-07-15"
    metric_id: str  # e.g., "hallucination"
    lora_version: str  # e.g., "v1"
    model_slot: str = "luna"  # new slot, routes to /eden-judge

    def __init__(self, *, endpoint: str, fallback_judge: Judge):
        self.endpoint = endpoint
        self._fallback = fallback_judge

    async def score(self, event, ctx):
        try:
            response = await self._call_luna(event)
            return JudgeScore(
                judge_name=self.name,
                judge_version=self.version,
                trace_id=event.trace_id,
                span_id=event.span_id,
                score=response["score"],
                rationale=None,  # Luna-2 doesn't produce rationale
                model=f"eden-judge-qwen3-4b-awq",
                scored_at=datetime.now(timezone.utc),
                latency_ms=response["latency_ms"],
                metadata={
                    "lora_id": self.metric_id,
                    "lora_version": self.lora_version,
                    "tokens_used": response.get("tokens_used", 1),
                    "raw_logits": response.get("raw_logits"),
                },
            )
        except (LatencyExceeded, CircuitBreakerOpen, UpstreamError):
            logger.warning(f"Luna {self.name} failed, falling back to GPT-4o")
            return await self._fallback.score(event, ctx)
```

### Registry wiring

`src/eden/llmops/judges/builtin_v9.py` adds:

```python
def register_luna_judges(registry, endpoint):
    """Register the 10 Luna-2-style judges. Replaces the
    3 Galileo Luna-2 judges with Eden-trained equivalents."""
    gpt4o_fallbacks = {  # map metric -> existing GPT-4o LJ
        "hallucination": HallucinationJudge(),
        "correctness": CorrectnessJudge(),
        # ...
    }
    for metric in METRICS:
        registry.register(LunaJudge(
            metric_id=metric,
            endpoint=endpoint,
            fallback_judge=gpt4o_fallbacks[metric],
        ))
```

### Migration plan

The 7 Cat 3 baseline judges (hallucination, correctness, tone,
groundedness, relevance, safety, satisfaction) currently call
GPT-4o. We don't break their interface — we replace the
**implementation** with `LunaJudge` routing through the new
endpoint. Existing call sites (JudgeRunner, JudgeDetector,
Cat 16 scorer) work unchanged.

The 3 Galileo Luna-2 judges (ActionCompletion,
ToolSelectionQuality, ReasoningCoherence) are **replaced
in-place** with Eden-trained equivalents. The Cat 16 Decision
Scorer's weighted formula (`0.4*ac + 0.3*ts + 0.3*rc`) is
preserved.

### Observability for the new judges

The existing `judge_scores` table has the right columns. We
add:

* `model` field: stores `"eden-judge-qwen3-4b-awq"` (vs
  current `"gpt-4o"`)
* `metadata` JSON: stores `lora_id`, `lora_version`,
  `raw_logits`, `tokens_used`
* No new tables needed.

The Cat 2 RCA's clusterer (which uses judge agreement as a
feature) and Cat 16 scorer's closed-loop (`PromotionHook
.on_judge_regression`) work unchanged — they read
`judge_scores` and react to score changes.

---

## Cost analysis

### Training (one-time)

| Item | Hours | $/hr | Subtotal |
|---|---|---|---|
| Data prep (labelling + synthetic) | 80 FTE-hr | $50 | $4,000 |
| SFT (Stage 1), 10 metrics | 60 | $1.49 | $89 |
| DPO (Stage 2), 10 metrics | 40 | $1.49 | $60 |
| Eval on public benchmarks × 4 runs | 8 | $1.49 | $12 |
| AWQ quantization + push to HF | 1 | $1.49 | $1 |
| **Total compute** | | | **$162** |
| **Total with FTE** | | | **$4,162** |

**One-time investment: ~$4.2k.** Comparable to a single
engineer-week of all-in cost.

### Inference (recurring)

**Reference scenario:** 1 org running 1M judge calls / month.

| Option | $/1k calls | $/1M calls | vs GPT-4o |
|---|---|---|---|
| **GPT-4o class** (current) | $7.50 | $7,500 | 1× |
| **Galileo Luna-2 hosted** | $1.00 | $1,000 | 0.13× |
| **Eden v2 (in-house, 1× A100)** | **$0.045** | **$45** | **0.006×** |

Breakdown for Eden v2 at 1M calls/mo:

* 1× A100 80GB on RunPod, 24/7: $1.49/hr × 730 hr = $1,088/mo
* At 1M calls/mo, the GPU is **<5% utilised** (capacity for
  20M+ calls/mo on one A100)
* Effective cost per call at low utilisation: $1,088 / 1M =
  $0.0011 per call ($1.10 per 1k)
* At 10M calls/mo (50% utilisation): **$0.11 per 1k**

**vs Luna-2 hosted:** Eden v2 is 9-22× cheaper because we
own the GPU and serve at our own utilisation curve. At 100M
calls/mo (5× A100s, 80% utilisation), Eden v2 is **$0.011 per
1k** — vs Luna-2 hosted at $1.00 per 1k. **90× cheaper.**

### Break-even analysis

For any org doing >5M judge calls / month, Eden v2 pays back
the $4.2k training cost in **month 1**. After that, the cost
savings are pure margin.

### Sunk cost avoidance

If we don't build this, the cost of running Eden at scale is:

| Org size | Judge calls/mo | Monthly cost (GPT-4o) | vs Eden v2 |
|---|---|---|---|
| Small startup | 100k | $750 | $1,088 (overpay by $338) |
| Mid-market | 1M | $7,500 | $1,088 (saves $6,412/mo) |
| Enterprise | 100M | $750,000 | $5,440 (saves $744k/mo) |
| Hyperscaler | 1B | $7,500,000 | $43,500 (saves $7.46M/mo) |

**The larger Eden grows, the more this matters.** At
enterprise scale, the judge cost saving is the single biggest
margin lever.

---

## Rollout plan

8-week timeline, single FTE + 1 GPU.

### Phase 1: Foundation (weeks 1-2)

* Week 1: Data labelling (1k traces/metric × 7 metrics = 7k
  labels, 2 FTE-engineers, 40 hr total)
* Week 1: Set up training infra on Lambda Labs
  (Axolotl/PEFT/TRL stack, Weights & Biases logging)
* Week 2: Build synthetic data pipeline
  (`EdenRUBRIC-v1` generation using `OpenRouterClient` +
  claude-sonnet-4 as teacher)
* Week 2: Set up vLLM inference stack
  (`/eden-judge/v1/score` endpoint, A100 reserved on RunPod)
* **Exit:** all 7 Cat 3 + 3 Galileo datasets ready,
  inference stack live, no judges trained yet

### Phase 2: Train first 3 metrics (weeks 3-4)

* Train hallucination, correctness, groundedness first
  (highest-traffic, most-validated metrics)
* Run public eval (JudgeBench + PPE) after each
* Iterate on hyperparameters if agreement < 0.75 vs GPT-4
* **Exit:** 3 metrics trained, kappa ≥0.75 on golden set

### Phase 3: Train remaining 7 metrics (weeks 5-6)

* Train the other 4 Cat 3 + 3 Galileo Luna-2 metrics
* Wire `LunaJudge` into the `JudgeRegistry` (alongside
  existing GPT-4o implementations, fallback on)
* **Exit:** all 10 metrics trained + registered, no production
  traffic yet

### Phase 4: Canary rollout (week 7)

* Route 5% of judge traffic to `LunaJudge`, 95% stays on
  GPT-4o
* Compare agreement rate, latency, cost
* Roll back to 0% if agreement < 90% on any metric
* **Exit:** agreement ≥90% on all 10 metrics over 7 days

### Phase 5: General availability (week 8)

* Route 100% of judge traffic to `LunaJudge` for all 10
  metrics
* Fall back to GPT-4o on circuit-breaker (covered by
  `AIGateway`)
* Publish the model card + the LoRA weights to HuggingFace
  under `eden/judge-qwen3-4b-awq` (Apache 2.0)
* Announce in the Cat 21 Custom-Metric Studio
* **Exit:** all 10 metrics in production, cost down 90%

### Phase 6: Cat 21 integration (weeks 9-12, post-GA)

* Cat 21 Custom-Metric Studio already ships the rubric +
  LLM-as-judge surface in v1.3 (per the master roadmap)
* Add a new route: `POST /intelligence/metric-studio/fine-tune-lora`
  that takes 2-5 user examples + a rubric and **trains a
  custom LoRA head on the user's behalf**
* Use the same training infra, same eval methodology, same
  serving stack
* Per-tenant LoRA isolation: each tenant's custom head is
  in a separate vLLM LoRA module
* **Exit:** tenants can ship a custom metric in 30 minutes
  instead of paying GPT-4o rates for a hosted judge

---

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Domain drift**: judges go stale as LLMs evolve | High | Med | Weekly re-eval on golden set; auto-rollback on kappa drop >5%; Cat 17 `MetricStudioHook.on_metric_promotion` |
| **Adversarial attacks** (RobustJudge 100% ASR) | High | Med | Adversarial training data (500+ examples); `promptfoo` re-eval pre-release; target ASR <20% |
| **License trap** (Llama-style AUP) | Low | High | Use Qwen 3.5 4B (Apache 2.0) or SmolLM3 3B (Apache 2.0); document license in model card |
| **Cost overrun on training** | Med | Low | Cap at 3 retraining runs; ship with checkpoint from best run |
| **Latency regression** | Med | Med | Fail-open to GPT-4o on p99 > 500ms; route through `AIGateway` circuit-breaker |
| **Cold start** (60s model load) | Med | Low | Keep 1 A100 always warm; in multi-GPU setups, keep 1 dedicated to judges |
| **KV cache blow-up** under high concurrency | Low | Med | vLLM max_num_seqs 256, max_model_len 2048 (judges don't need long context) |
| **Cat 21 custom LoRAs leaking across tenants** | Low | High | vLLM `--lora-modules` isolation; per-tenant LoRA directory in HF Hub |
| **GPT-4o fallback costs blow up** during incident | Med | Med | Rate-limit fallback path; alert on > 10% fallback rate (Cat 8) |
| **Public release** opens us to scrutiny | Low | Med | Publish with model card, eval results, limitations; we *win* on openness vs Galileo |

---

## Decisions to make before starting

These are the questions to lock before week 1:

1. **Base model.** Qwen 3.5 4B (recommended, Apache 2.0, AWQ
   published) vs SmolLM3 3B (also Apache 2.0, fully open
   recipe). **Recommendation: Qwen 3.5 4B**, with SmolLM3 3B as
   fallback if Qwen3 proves unstable in fine-tuning.

2. **Single shared base or per-metric base?** Single
   shared base + per-metric LoRA heads (Luna-2's pattern,
   recommended). Per-metric base is wasteful (10× VRAM,
   10× deployment cost).

3. **Train in-house or partner with vendor?** In-house
   recommended. ~$4k compute + 4 FTE-weeks. Vendors (Galileo,
   Braintrust) won't share their LoRA recipes.

4. **Open-source the resulting SLM?** **Yes, Apache 2.0.**
   This is a competitive differentiator vs Galileo Luna-2
   (which is closed). It also matches the Apache 2.0 base
   model license. We win on openness.

5. **Release schedule.** Internal GA in week 8, public
   release in week 12 (with model card + blog post). Or
   wait until we have 30 days of production data first
   (week 12 internal, week 16 public). **Recommendation:
   internal GA week 8, public release week 12 with 30 days
   of production case studies.**

6. **Stage 3 (RLAIF).** Defer to v2.1 (4-6 months post-GA).
   RLAIF adds 4-6 weeks and needs production judge data
   that we don't have yet. Revisit when we have 1M+
   labelled judge outputs in `judge_scores`.

7. **Synthetic data teacher model.** Use claude-sonnet-4
   (best quality) or gpt-4o-mini (cheaper, slightly worse).
   **Recommendation: gpt-4o-mini for rubric generation
   (cost matters), claude-sonnet-4 for the high-stakes
   labelled subset (1k traces).**

8. **Hardware: A100 80GB (recommended) vs H100 vs L40S.**
   A100 80GB at $1.49/hr on RunPod is the cost-performance
   sweet spot (per the 2026 cloud GPU pricing). H100 is
   2× faster but 1.7× more expensive; L40S is cheaper but
   has less VRAM headroom. **Recommendation: A100 80GB
   reserved, with H100 fallback for hot tenants.**

---

## Cross-references

### Master roadmap

* `docs/eden-observability-gap-roadmap.md` § Cat 21
  (Custom-Metric Studio) — where the rubric + LLM-as-judge
  surface lives, and where the custom LoRA training route
  would ship
* `docs/eden-observability-gap-roadmap.md` § Cat 17
  (Closed-loop wiring) — `MetricStudioHook
  .on_metric_promotion` fires on Luna head version bumps

### Academic references

* Luna-2 paper: <https://arxiv.org/abs/2602.18583>
* Prometheus 2: <https://arxiv.org/abs/2405.01535>
* Auto-J: <https://arxiv.org/abs/2310.05470>
* HelpSteer2: <https://arxiv.org/abs/2406.08673>
* RobustJudge SoK (adversarial): <https://arxiv.org/abs/2603.29403>
* ActiveUltraFeedback: <https://arxiv.org/abs/2603.09692>
* Representation-as-a-Judge (Qwen3-0.6B/1.7B): <https://arxiv.org/abs/2601.22588>
* SLM-as-a-Judge for Code Correctness: <https://arxiv.org/abs/2602.11911>

### Code references

* `src/eden/llmops/judges/base.py` — `Judge` ABC
* `src/eden/llmops/judges/registry.py` — `JudgeRegistry`
* `src/eden/llmops/judges/runner.py` — `JudgeRunner`
* `src/eden/llmops/judges/builtin_v9.py` — 7 Cat 3 + 3 Galileo
* `src/eden/llmops/ai_gateway.py` — multi-provider failover
* `src/eden/api/routes/gateway.py` — OpenAI-compatible surface
* `src/eden/db_migrations/versions/010_judge_scores.py` —
  existing `judge_scores` schema (no migration needed)

### Datasets

* `openbmb/UltraFeedback` (CC-BY-4.0)
* `nvidia/HelpSteer2` (CC-BY-4.0)
* `prometheus-eval/Feedback-Collection` (MIT)
* `prometheus-eval/Preference-Collection` (MIT)
* `GAIR-NLP/auto-j` (MIT)
* `Skywork/Skywork-Critic` (Apache 2.0)
* `openbmb/UltraInteract_sft` (Apache 2.0)
* `THU-KEG/RM-Bench` (eval only)
* `ScalerLab/JudgeBench` (eval only)
* `lmarena/PPE` (eval only)
* `allenai/reward-bench-2` (eval only)

### Models

* `Qwen/Qwen 3.5-4B` (Apache 2.0)
* `Qwen/Qwen 3.5-4B-AWQ` (Apache 2.0, AWQ 4-bit)
* `HuggingFaceTB/SmolLM3-3B` (Apache 2.0)

### Tooling

* Axolotl: <https://github.com/OpenAccess-AI-Collective/axolotl>
* TRL (Hugging Face): <https://huggingface.co/docs/trl>
* vLLM: <https://docs.vllm.ai/>
* AutoAWQ: <https://github.com/casper-hansen/AutoAWQ>
* Unsloth: <https://github.com/unslothai/unsloth>
* Lambda Labs cloud GPU: <https://lambdalabs.com/>
* RunPod cloud GPU: <https://www.runpod.io/>
