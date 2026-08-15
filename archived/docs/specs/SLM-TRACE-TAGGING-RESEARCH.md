# SLM Trace Tagging & Descriptor Evaluation — Research Document

| Field | Value |
|---|---|
| **Status** | Research (pre-implementation) — **AGENT-SPECIALIZED** + **NO GPT ESCALATION** + **TRAIN UNLOCKED** (Unsloth / AWS·Azure) |
| **Author** | Eden Observability / Eval |
| **Last updated** | 2026-07-15 |
| **Constraints** | (1) Models & rules must be **specialized for agent traces**. (2) **No frontier-LLM escalation**. (3) Training allowed via Unsloth + commercial-safe data (IBM ToolRM-train-data). |
| **Goal** | Super-cheap system that **fully labels, tags, evaluates, and scores agent traces** — Luna-2 parity via Layer A + Eden Luna LoRAs |
| **Related specs** | F62, F55, F35, F34, F65, F52, F79, N03, N08 |
| **Related plans** | `docs/docs/observability/judge-v2-plan.md`; deep dive §§20–24 |

---

## Table of Contents

0. [Authoritative Revision: Agent-Native Stack](#0-authoritative-revision-agent-native-stack)
1. [Executive Summary](#1-executive-summary)
2. [Hard Constraint: No Training](#2-hard-constraint-no-training)
3. [What “Fully Labelled + Scored” Means](#3-what-fully-labelled--scored-means)
4. [Off-the-Shelf Model Shortlist](#4-off-the-shelf-model-shortlist) *(superseded for agents by §0)*
5. [Recommended Stack](#5-recommended-stack-buyload-dont-train) *(superseded by §0)*
6. [End-to-End Pipeline](#6-end-to-end-pipeline)
7. [Descriptor Taxonomy](#7-descriptor-taxonomy-operator-language)
8. [Scoring Rubrics](#8-scoring-rubrics-for-flow-judge-copy-paste)
9. [Cost Model](#9-cost-model--ultra-cheap)
10. [Deployment Topologies](#10-deployment-topologies)
11. [Eden Integration](#11-eden-integration)
12. [Portal UX](#12-portal-ux)
13. [Quality Assurance](#13-quality-assurance-without-training-data)
14. [Competitive Comparison](#14-competitive-comparison)
15. [Implementation Roadmap](#15-implementation-roadmap-no-train)
16. [Risks & Mitigations](#16-risks--mitigations)
17. [Decisions](#17-decisions-locked--open)
18. [References](#18-references)
19. [Appendices](#19-appendices)
20. [Layer A Deep Dive](#20-layer-a-deep-dive--what-it-is-how-it-works-quality-vs-slm)
21. [Specific Models (Exact IDs)](#21-specific-models-exact-ids--ready-to-load)
22. [Train Our Own Luna-2](#22-can-we-train-our-own-luna-2-yes--with-your-credits)
23. [Perfect Solution](#23-perfect-solution-recommended-decision-tree)
24. [Layer A vs SLM Examples](#24-layer-a-vs-trained-slm--side-by-side-example)

---

## 0. Authoritative Revision: Agent-Native Stack

> **This section supersedes earlier recommendations that centered GLiClass + Flow-Judge + GPT escalation.** Those are general-text / generic-judge tools. Eden’s product is **agent observability**. Labels like `unnecessary_tool_call`, `wrong_tool`, `result_ignore`, and `action_incomplete` are **trajectory properties**, not bag-of-words topic tags.

### 0.1 Why escalation was the wrong design

Galileo Luna-2’s entire thesis ([arXiv:2602.18583](https://arxiv.org/abs/2602.18583)):

> Real-time guardrails need evaluation that is accurate, cheap, and fast — yet LLM-as-a-judge is slow, expensive, and non-deterministic. Luna-2 **is** the production judge: single-token SLM heads, **100% traffic**, no GPT fallback for the default path.

Escalation to GPT-4o-mini reintroduces:

| Problem | Effect |
|---------|--------|
| Cost spike | Undoes the cheap-eval premise |
| Latency | 800ms–3s vs 80–200ms specialized path |
| Non-determinism | Multi-token generation, parse failures |
| Operational split | Two truth sources; disagreement hell |
| Product confusion | “SLM eval” that still bills frontier models |

**Correct pattern (locked):**

```
Specialized agent path runs on policy-sampled or 100% traffic.
Low confidence → tag needs_review + queue for human/HIL
             → NOT call OpenRouter.
```

Confidence is for **routing to humans / datasets**, not for spending more tokens.

### 0.2 Why general classifiers fail on agent traces

| Tool | Trained on | Misses on agents |
|------|------------|------------------|
| GLiClass / DeBERTa-NLI | Topics, sentiment, NLI | Tool arg correctness, unused tool results, wrong-tool-for-intent |
| Flow-Judge / Prometheus | Rubric text quality | Tool schema, multi-step efficiency, tool-result grounding |
| LettuceDetect | RAG context↔answer | Tool-call fabrication when “context” is tool JSON, not docs |
| Detoxify | Toxic comments | Agent policy violations / unsafe tool actions |

**Paper evidence:** ToolRM (IBM, [arXiv:2509.11963](https://arxiv.org/abs/2509.11963)) shows general-purpose reward models **systematically miss** tool-calling failure signals (wrong params, missing/extra calls). FC-RewardBench was built because generic RMs are inadequate.

**Implication:** Labels and scores for Eden must come from **agent-trajectory structure + agent-specialized models**, not topic classifiers.

### 0.3 Agent failure taxonomy (operator-facing)

Unified from ToolFailBench, Agent-Failure-Classifier, Microsoft AgentRx, Eden `StumbleKind`, Galileo agentic metrics:

#### Tool-use failures (primary)

| ID | Display | Definition | Detection class |
|----|---------|------------|-----------------|
| `unnecessary_tool_call` | Unnecessary tool call | Tool invoked when not needed (ToolFailBench **UTU**) | Deterministic + agent RM |
| `tool_skip` | Skipped required tool | Should have called tool, answered without it | Deterministic (if tools advertised) + RM |
| `wrong_tool` | Wrong tool | Real tool, wrong choice for intent | Agent RM / heuristic |
| `bad_tool_args` | Bad tool arguments | Schema/type/required-arg violation | **Deterministic** (JSON schema) |
| `result_ignore` | Ignored tool result | Called tool but final answer ignores return | Deterministic (token overlap / unused) |
| `output_fabrication` | Fabricated after tools | Invents facts not in tool returns | Lettuce-style on tool JSON + RM |
| `tool_error` | Tool error | HTTP/exception/empty error payload | **Deterministic** |
| `repetitive_tool_call` | Repetitive tool call | Same tool+args loop | **Deterministic** |

#### Trajectory / planning failures

| ID | Display | Definition | Detection class |
|----|---------|------------|-----------------|
| `looping` | Looping | Circular 2–3 step cycle | **Deterministic** |
| `excessive_steps` | Excessive steps | Over budget steps/tools | **Deterministic** |
| `action_incomplete` | Incomplete action | User goal not finished (Galileo Action Completion) | Agent RM |
| `plan_drift` | Plan drift | Actions diverge from stated plan | Heuristic / RM |
| `timeout` | Timeout | Deadline exceeded | **Deterministic** |

#### Content / safety

| ID | Display | Definition | Detection class |
|----|---------|------------|-----------------|
| `inaccuracy` | Inaccuracy | Unsupported claims in final answer | Tool-grounded check + RM |
| `user_frustration` | User frustration | Regen / negative user turns | Deterministic signals |
| `unsafe_action` | Unsafe action | Harmful tool trajectory | **SODA-Agent-Safety-Judge** |
| `jailbreak_attempt` | Jailbreak attempt | Policy bypass in user input | Opir / rules |

### 0.4 Revised architecture — agent-native, no GPT escalation

```
┌─────────────────────────────────────────────────────────────────┐
│                     AGENT TRACE (OTel / Eden)                   │
│  user → assistant ↔ tools[] → tool_results[] → final answer     │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│ LAYER A — Deterministic Agent Graders ($0, 100%)                │
│  • Schema validate tool calls (bad_tool_args)                   │
│  • tool_error / timeout / mcp_auth                              │
│  • loop / repetitive_tool_call / excessive_steps                │
│  • result_ignore (result unused in later messages)              │
│  • unnecessary_tool_call heuristics (chitchat + tool, etc.)     │
│  • ToolFailBench-style labeling when task type known            │
│  Output: descriptors + tags + optional binary scores            │
│  Refs: Eden StatGate, Agent-Failure-Classifier (rules mode),    │
│        OpenJudge ActionLoopDetectionGrader (code),              │
│        AgentEvals trajectory match (when reference exists)      │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│ LAYER B — Agent-specialized SLMs (self-host, no GPT)            │
│                                                                 │
│  B1 SAFETY (always on agent traces with tools):                 │
│     cesun/SODA-Agent-Safety-Judge (Qwen3-4B, Apache 2.0)        │
│     → unsafe_action SAFE/UNSAFE + CoT                           │
│                                                                 │
│  B2 TOOL / TRAJECTORY SCORE:                                    │
│     ★ TRAIN PATH (Luna parity): Eden Luna LoRAs on Qwen3-4B     │
│       Data: ibm-research/ToolRM-train-data (Apache-2.0, 458k)   │
│       Method: Unsloth SFT True/False + optional DPO; vLLM LoRA  │
│       See §22                                                   │
│     Interim load-only:                                          │
│       AgentRM scalar (cheesewafer/*-regression-*, Llama)        │
│     Strongest open critic (NON-COMMERCIAL):                     │
│       RioLee/ToolRM-Gen-Qwen3-4B-Thinking-2507 (CC BY-NC-SA)    │
│     IBM ToolRM weights: train data public; weights TBD          │
│                                                                 │
│  B3 GROUNDING when tool results exist:                          │
│     LettuceDetect with premise = concatenated tool_results      │
│     (not docs) → output_fabrication / inaccuracy                │
│                                                                 │
│  Output: judge_scores + descriptors + rationales                │
│  Low conf → needs_review tag ONLY (no OpenRouter)               │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│ LAYER C — Persist & consume                                     │
│  trace_eval_tags · telemetry tags · judge_scores ·              │
│  production_eval_scores · issues/stumbles · Typesense · portal  │
└─────────────────────────────────────────────────────────────────┘
```

**No Layer D GPT escalation.** Period.

### 0.5 Model catalog — agent-specialized only

| Model / system | Agent-native? | Size | License | Role for Eden | Notes |
|----------------|---------------|------|---------|---------------|-------|
| **Deterministic graders** (implement in Eden) | ✅ | n/a | Eden code | Primary labels | Highest ROI; matches Luna cost = $0 |
| [`cesun/SODA-Agent-Safety-Judge`](https://huggingface.co/cesun/SODA-Agent-Safety-Judge) | ✅ trajectories | 4B | Apache 2.0 | `unsafe_action` | Trained on 170k agent tool trajectories |
| [`cheesewafer/Meta-Llama-3.1-8B-Instruct-regression-avg-all-v3-True-False`](https://huggingface.co/cheesewafer/Meta-Llama-3.1-8B-Instruct-regression-avg-all-v3-True-False) (AgentRM) | ✅ multi-env agents | 8B | Llama Community | Scalar trajectory score | WebShop/ALFWorld/SciWorld RM; commercial MAU caps |
| [`RioLee/ToolRM-Gen-Qwen3-4B-Thinking-2507`](https://huggingface.co/RioLee/ToolRM-Gen-Qwen3-4B-Thinking-2507) | ✅ tool-use critique | 4B | **CC BY-NC-SA 4.0** | Best open agentic critic | **Cannot use in commercial SaaS** without license deal |
| IBM ToolRM 1.5B/7B/14B | ✅ FC-RewardBench | 1.5–14B | Base Qwen Apache; **weights TBD** | Ideal if released | Train data: `ibm-research/ToolRM-train-data` |
| OpenJudge agent graders | ✅ | prompts | Apache 2.0 | Spec for rubrics | Framework defaults to LLM graders — **do not wire to GPT**; reuse criteria text for AgentRM / local SLM |
| AgentEvals trajectory match | ✅ | code | LangChain | Offline / golden only | Needs reference trajectory |
| Agent-Failure-Classifier (rules) | ✅ | code | check repo | Port rules into Eden | 8 failure modes; rules mode = $0 |
| GLiClass / Flow-Judge | ❌ general | — | Apache | **Demoted** | Only for non-agent chat spans if ever needed |
| GPT-4o / mini | ❌ | — | API | **Forbidden as default** | Violates cost + Luna pattern |

### 0.6 How ToolRM’s own criteria map to Eden chips

From RioLee ToolRM evaluation_criteria (model card) — even if we cannot ship NC weights commercially, this is the **spec** our deterministic+AgentRM stack must cover:

| ToolRM criterion | Eden descriptor / score |
|------------------|-------------------------|
| Tools fully/appropriately leveraged | `tool_skip` / `action_incomplete` / `tool_selection_quality` |
| Valid tool names | `wrong_tool` / `bad_tool_args` |
| Valid complete args | `bad_tool_args` |
| Penalize fabrication not from tools | `output_fabrication` / `inaccuracy` |
| Penalize repetitive/unnecessary tools | `unnecessary_tool_call` / `repetitive_tool_call` |
| Penalize excess clarification | `excessive_clarification` (optional) |

### 0.7 Scoring without GPT (how traces get float scores)

| Score | Producer | Method |
|-------|----------|--------|
| `tool_selection_quality` | Layer A + AgentRM | Schema OK × AgentRM scalar; or binary from ToolFailBench labels |
| `action_completion` | AgentRM / goal heuristic | Scalar; or 0 if `action_incomplete` |
| `groundedness` | LettuceDetect on tool_results | `1 - halluc_token_ratio` |
| `safety` | SODA judge | 1.0 SAFE / 0.0 UNSAFE |
| `trace_quality` (aggregate) | Weighted | `0.4*action + 0.3*tool + 0.3*grounded` (Eden DecisionScorer formula) |
| `hallucination` | Inverse groundedness | Already in Eden judges |

Rationales: from SODA CoT, ToolRM critique (if licensed), or **template strings** from deterministic detectors (`"Tool search_kb result unused in final answer"`).

### 0.8 Cost model (agent stack, no escalation)

| Layer | Coverage | $/1M traces |
|-------|----------|-------------|
| A Deterministic | 100% | ~$0 |
| B1 SODA-4B | 100% agent traces | ~$20–80 (shared L4 fraction) |
| B2 AgentRM-8B | 10–100% per budget | ~$30–200 |
| B3 Lettuce on tool JSON | when tools present | ~$5–20 |
| GPT escalation | **0%** | **$0** |
| **Total typical** | | **~$50–150/mo at 1M** |

Still << Galileo hosted / GPT judges; agent-correct unlike GLiClass stack.

### 0.9 Honest gap vs Galileo Luna-2 — and how training closes it

| Capability | Luna-2 | Load-only stack | **+ Eden Luna (train)** |
|------------|--------|-----------------|-------------------------|
| Tool Selection Quality | Proprietary SLM head | Deterministic + AgentRM | **Qwen3-4B LoRA on IBM ToolRM-train-data** |
| Action Completion | Proprietary SLM head | AgentRM + heuristics | LoRA + Eden golden labels |
| Unnecessary / bad args | Proprietary heads | Layer A + heuristics | **LoRA on irrelevance + incorrect-call pairs** |
| 100% traffic | Yes | Layer A+B1 yes; B2 budgeted | Yes (single-token True/False) |
| No GPT | Yes | **Yes (locked)** | **Yes (locked)** |
| Custom metrics | Luna Studio | Weak without train | Unsloth LoRA per metric (~4k–50k labels) |

**Largest former gap:** no commercial ToolRM weights. **Closed by training:** IBM publishes **458,575** Apache-friendly preference pairs (`ibm-research/ToolRM-train-data`); train Eden Luna with Unsloth on AWS/Azure credits (§22). RioLee ToolRM weights stay **CC BY-NC-SA** — research only.

**Layer A quality:** equals or beats SLM on schema/loops/errors; **weaker** on paraphrase / wrong-tool / soft UTU — see §20. Not Luna-class alone.

### 0.10 What to implement first (revised roadmap)

1. **Week 1–2:** Layer A `DescriptorEngine` + `trace_eval_tags` + portal chips.  
2. **Week 2–3:** Spin AWS `g5.xlarge` / Azure A10 — Unsloth Qwen3-4B LoRA on IBM ToolRM → first `tool_selection` + `unnecessary` heads.  
3. **Week 3:** SODA-Agent-Safety-Judge on tool trajectories.  
4. **Week 4–5:** Serve Eden Luna via vLLM `--enable-lora`; shadow vs AgentRM; kill hash fallback.  
5. **Week 6:** LettuceDetect on `tool_results`; more LoRA heads (`fabrication`, `action_completion`).  
6. **Never:** GPT escalation. Optional: keep AgentRM as backup scalar until Eden Luna beats it on fc-reward-bench.

---

## 1. Executive Summary

Traces are **agent trajectories**, not chat blobs. Escalation to frontier LLMs is rejected. Training is **unlocked** for Luna-2 parity.

**Authoritative stack (§0 + §§20–24):**

```
Layer A  Deterministic agent graders     $0     100%  → structural labels
Layer B0 Eden Luna (train: Unsloth+IBM)  cheap  100%  → tool metrics (Luna pattern)
Layer B1 SODA-Agent-Safety-Judge         cheap  100%  → unsafe_action
Layer B2 AgentRM (interim) or Eden Luna  cheap  budgeted → float scores
Layer B3 LettuceDetect on tool results   cheap  when tools → groundedness
Layer C  Persist to Eden stores          —      —
         ✗ NO GPT / OpenRouter escalation
```

**Layer A ≠ Luna quality on semantics** (wrong tool, soft UTU, paraphrase). It **is** production-grade for schema/loops/errors. Details: §20.

**Train path:** `ibm-research/ToolRM-train-data` (Apache-2.0, 458,575 pairs) + `unsloth/Qwen3-4B` LoRA on AWS/Azure credits → Eden Luna. Details: §22.
**Demoted:** GLiClass, Flow-Judge-as-primary, GPT-4o-mini fallback (see §0).

Earlier sections below retain useful schema/integration/cost detail but **yield to §0 on model choice and cascade design**.

### Cost target (1M traces/month)

| Coverage policy | Monthly cost (self-host) | Output |
|-----------------|--------------------------|--------|
| **Recommended (agent stack)** | **~$50–150** (CPU graders + SODA + AgentRM fraction) | 100% labelled; scored without GPT |
| Aggressive (100% AgentRM) | ~$150–300 | Fully scored always |
| Status-quo GPT-4o (10 judges × 100%) | ~$150,000 | — |

**Product outcome:** every agent trace has:

1. **Descriptors** (chips): `Inaccuracy`, `Unnecessary tool call`, …
2. **Tags** (`eval:inaccuracy`, …) in Typesense + `telemetry_events`
3. **Scores** (0–1 or Likert) in `judge_scores` with rationale
4. **Pass/fail** in `production_eval_scores`
5. **Downstream hooks** into issues, insights, datasets, MCP

Training is explicitly **out of scope for v1**. Revisit only if production disagreement with Flow-Judge stays <85% vs gpt-4o-mini for 30 days.

---

## 2. Hard Constraint: No Training

### 2.1 What is forbidden in v1

- Fine-tuning Qwen / Phi / Llama for Luna-style heads
- Training `eden-descriptor-bert` from scratch
- Collecting 4,000 labelled samples per metric for PEFT
- Distillation pipelines that require teacher-labelled corpora at scale

### 2.2 What is allowed

- **Load published HF weights** and run inference
- **Prompt / rubric configuration** (Flow-Judge custom metrics — this is config, not training)
- **Hypothesis templates** for zero-shot classifiers (label wording)
- **Threshold calibration** on a small held-out set (threshold tuning ≠ training)
- **Few-shot examples at inference** when the model supports it (GLiClass-Instruct `examples=` parameter) — still no weight updates
- **Deterministic rules** (StatGate, regex, tool-call heuristics)

### 2.3 Why this is still competitive

Galileo’s moat is proprietary Luna-2 weights + hosting. Braintrust Topics uses LLM facet summarization (expensive). Eden’s moat with no training:

1. **Encoder cascade at CPU cost** for tags on (near) 100% of traces  
2. **Flow-Judge rubrics** mapped 1:1 to Eden’s existing 10 judges without OpenRouter for the default path  
3. **Tight wire into** issues / signals / Typesense / portal — competitors sell the model; Eden sells the closed loop

---

## 3. What “Fully Labelled + Scored” Means

A trace is **complete** when all of the following exist:

| Artifact | Store | Example |
|----------|-------|---------|
| **Descriptors** | `trace_eval_tags` | `inaccuracy`, `unnecessary_tool_call` |
| **Search tags** | `telemetry_events.tags` + Typesense | `eval:inaccuracy`, `eval:unnecessary_tool_call` |
| **Float scores** | `judge_scores` | `hallucination=0.22`, `correctness=0.81` |
| **Rationale** | `judge_scores.rationale` | “Claimed refund date without tool evidence” |
| **Aggregate** | `production_eval_scores` | `score=0.64`, `passed=false`, `judge_tier=slm` |
| **Optional spans** | LettuceDetect spans in `evidence` JSONB | unsupported token ranges |

**Not required for “complete” (v1):** human annotation, Topics clustering (F65), custom org LoRAs.

---

## 4. Off-the-Shelf Model Shortlist

### 4.1 Multi-label tagging (the “unnecessary / inaccuracy” layer)

#### Winner: GLiClass base v3.0

| | |
|--|--|
| **HF** | `knowledgator/gliclass-base-v3.0` |
| **Params** | 187M (DeBERTa-v3-base) |
| **License** | Apache 2.0 |
| **Avg F1** | 0.6556 (published zero-shot across 13 datasets) |
| **Speed** | ~51.6 examples/sec (GPU); CPU still practical |
| **Key property** | **One forward pass for all labels** (vs DeBERTa-NLI which is O(n_labels)) |

```python
from gliclass import GLiClassModel, ZeroShotClassificationPipeline
from transformers import AutoTokenizer
import torch

model = GLiClassModel.from_pretrained("knowledgator/gliclass-base-v3.0")
tok = AutoTokenizer.from_pretrained("knowledgator/gliclass-base-v3.0")
pipe = ZeroShotClassificationPipeline(
    model, tok, classification_type="multi-label",
    device=torch.device("cuda" if torch.cuda.is_available() else "cpu"),
)

LABELS = [
    "inaccuracy", "unsupported claim", "incomplete answer", "off topic",
    "unnecessary tool call", "wrong tool", "missing tool call",
    "user frustration", "verbose", "unclear", "refusal",
    "contradiction", "successful resolution", "efficient",
]
# Text = compact trace summary (user + assistant + tool names)
results = pipe(trace_text, LABELS, threshold=0.45)[0]
```

**Why not DeBERTa zero-shot NLI (`MoritzLaurer/deberta-v3-large-zeroshot-v2.0-c`)?**  
Accurate (~0.68 F1) but **latency scales linearly with label count** (~6.8× slower at 20 labels vs GLiClass). At production volume, GLiClass wins on $/tag.

**Why not GLiNER2 alone?**  
GLiNER2 (~205–500M, Apache 2.0) is excellent when you also want NER/JSON extraction in one pass (~130–208ms CPU for 5–50 labels). Prefer **GLiClass for tag-only path**; consider **GLiNER2** if Eden later wants entity extraction from traces in the same call.

**Upgrade path without training:** `knowledgator/gliclass-large-v3.0` (439M, F1 0.70) if base under-tags; or `gliclass-instruct-base-v1.0` with few-shot examples at inference for org-specific wording.

#### Safety-specialized (optional parallel pass)

| Model | Role | Latency |
|-------|------|---------|
| `knowledgator/opir-edge-v1.0` (32.7M) | Binary safe/unsafe | ~9ms p50 |
| `knowledgator/opir-multitask-large-v1.0` | Toxicity, jailbreak, PII categories | ~26ms |
| `detoxify` unbiased | Classic toxicity scores | CPU ms |

### 4.2 Hallucination / groundedness (when context exists)

#### Winner: LettuceDetect base (ModernBERT)

| | |
|--|--|
| **HF** | `KRLabsOrg/lettucedect-base-modernbert-en-v1` (also `large`) |
| **License** | MIT |
| **Task** | Token classification: supported vs hallucinated spans given context+question+answer |
| **RAGTruth** | Example-level F1 ~76% base / ~79% large (beats prior encoder Luna; competitive with FT Llama-2-13B) |
| **Throughput** | 30–60 examples/sec on A100; TinyLettuce 32M for CPU |

```python
from lettucedetect.models.inference import HallucinationDetector

detector = HallucinationDetector(
    method="transformer",
    model_path="KRLabsOrg/lettucedect-base-modernbert-en-v1",
)
# Returns spans + example-level hallucinated bool
```

**Mapping to Eden descriptors:**

- Any hallucinated span → tag `eval:inaccuracy` + `eval:unsupported_claim`
- Score: `groundedness = 1 - (hallucinated_token_ratio)` → write `judge_scores` row `groundedness`
- If no retrieval context → **skip** LettuceDetect; rely on GLiClass `inaccuracy` + Flow-Judge

**Alternative:** `Pranshurs/groundcheck-modernbert` (150M) — binary grounded/hallucinated; slightly weaker generality than LettuceDetect’s span output.

### 4.3 Numeric evaluation + rationale (the “scored” layer)

#### Winner: Flow-Judge-v0.1

| | |
|--|--|
| **HF** | `flowaicom/Flow-Judge-v0.1` (+ AWQ quantized variants via flow-judge lib) |
| **Base** | Phi-3.5-mini-instruct, 3.8B |
| **License** | Apache 2.0 |
| **Strength** | **Custom criteria + rubric** in natural language; Pass/Fail, 3-Likert, 5-Likert; rationale |
| **Serve** | `flow-judge` + vLLM or HF Transformers |
| **Bench** | Competitive with gpt-4o-mini / ahead of same-size open models on Flow’s HaluEval/RAGTruth evals |

```python
from flow_judge import Vllm, FlowJudge
from flow_judge.metrics import CustomMetric, RubricItem

metric = CustomMetric(
    name="hallucination",
    criteria="Does the response invent facts not supported by context or tools?",
    rubric=[
        RubricItem(score=1, description="No unsupported claims"),
        RubricItem(score=0, description="Contains fabricated or unsupported claims"),
    ],
    required_inputs=["user_query", "context"],
    required_output="response",
)
judge = FlowJudge(metric=metric, model=Vllm())  # or config="Flow-Judge-v0.1-AWQ"
```

**Why Flow-Judge over Prometheus-7B?**  
3.8B vs 7B → ~2× cheaper VRAM/latency; purpose-built for custom rubrics Eden already expresses as judge prompts. Use Prometheus-7B only if Flow-Judge agreement with gpt-4o-mini on Eden golden set < 0.80.

**Why Flow-Judge over OpenRouter gpt-4o-mini as default?**  
Self-host marginal cost ≈ electricity/GPU share; gpt-4o-mini is ~$0.15–0.60/1M tokens and still accumulates. Flow-Judge keeps production sampling economically viable at 5–20%.

### 4.4 Agentic / tool descriptors (hardest without training)

No open Luna-2 Tool Selection Quality weights exist. Practical no-train approach:

| Signal | Method |
|--------|--------|
| `unnecessary_tool_call` | **Heuristic Tier 0**: tool called with empty/duplicate args; tool result unused in next LLM message; tool called when user asked a pure chitchat question (GLiClass assists) |
| `wrong_tool` / `missing_tool_call` | GLiClass labels on compressed trace (“Agent called search_kb but user asked to cancel order”) |
| `tool_selection_quality` score | Flow-Judge rubric on tool span (sample) |
| Safety of tool trajectories | SODA-Agent-Safety-Judge (load weights; binary SAFE/UNSAFE) |

This will not match Galileo’s proprietary agentic metric pack on day one — but it **does** produce operator-visible tags without training.

### 4.5 Models explicitly rejected for v1 default path

| Model | Why reject as default |
|-------|----------------------|
| Galileo Luna-2 | Closed weights |
| RootSignals 70B Judge | Cost/latency not SLM |
| GPT-4o / Claude as primary | Cost explosion |
| Trainable ModernBERT “eden-descriptor-bert” | Violates no-train |
| Llama-3.2-3B general instruct as judge | Weaker than Flow-Judge for rubrics; license friction |

---

## 5. Recommended Stack (Buy/Load, Don’t Train)

### 5.1 Canonical architecture

```
                         ┌──────────────────────────┐
                         │   trace.finalized event  │
                         └────────────┬─────────────┘
                                      │
         ┌────────────────────────────▼────────────────────────────┐
         │ Tier 0 — Deterministic (always)                         │
         │  StatGate: looping, cost_spike, timeout, tool_error     │
         │  Heuristics: unused tool result → unnecessary_tool_call │
         │  Write: trace_eval_tags + tags[]                        │
         └────────────────────────────┬────────────────────────────┘
                                      │
         ┌────────────────────────────▼────────────────────────────┐
         │ Tier 1 — Encoder suite (always or policy.sample≥0.2)    │
         │  A. GLiClass-base-v3 → multi-label descriptors          │
         │  B. if has_retrieval_context: LettuceDetect             │
         │  C. Detoxify or Opir → unsafe_content / jailbreak       │
         │  Write: descriptors + optional groundedness score       │
         └────────────────────────────┬────────────────────────────┘
                                      │
                    ┌─────────────────┴─────────────────┐
                    │ Confidence / policy gate          │
                    │ escalate if any conf < τ OR       │
                    │ stumble OR new deploy OR sample   │
                    └─────────────────┬─────────────────┘
                                      │
         ┌────────────────────────────▼────────────────────────────┐
         │ Tier 2 — Flow-Judge-v0.1 (vLLM AWQ on L4/A10)           │
         │  Run 3–10 custom rubrics (hallucination, correctness,   │
         │  tone, groundedness, relevance, safety, satisfaction,   │
         │  action_completion, tool_selection, reasoning)          │
         │  Write: judge_scores (score + rationale)                │
         │  Aggregate → production_eval_scores                     │
         └────────────────────────────┬────────────────────────────┘
                                      │ if Flow-Judge conf/low agreement
         ┌────────────────────────────▼────────────────────────────┐
         │ Tier 3 — OpenRouter gpt-4o-mini (rare)                  │
         │  Existing Eden Judge classes as fallback                │
         └─────────────────────────────────────────────────────────┘
```

### 5.2 Process layout (minimal hardware)

```
┌─────────────────────────────────────────────────────────────┐
│ Eden API / workers (existing)                               │
│  + DescriptorEngine (Python)                                │
│  + gliclass + lettucedetect + detoxify  (CPU threads)       │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP localhost
┌───────────────────────────▼─────────────────────────────────┐
│ vLLM — Flow-Judge-v0.1-AWQ                                  │
│  1× L4 24GB or A10 (can share with other Eden ML later)     │
│  OpenAI-compatible /v1/completions                          │
└─────────────────────────────────────────────────────────────┘
```

**VRAM:** GLiClass base ~0.75GB + LettuceDetect ~0.6GB fit in CPU RAM easily; Flow-Judge AWQ ~3–4GB → L4 has headroom for batching.

### 5.3 Software packages

```bash
pip install gliclass lettucedetect detoxify flow-judge[vllm] transformers torch
# optional
pip install gliner2  # if combining NER+classify later
```

---

## 6. End-to-End Pipeline

### 6.1 Trace text serialization (critical for zero-shot quality)

GLiClass and Flow-Judge need a **compact, structured** text — not raw OTel JSON.

```text
[USER]
{user_message truncated 800 chars}

[ASSISTANT]
{final_response truncated 1200 chars}

[TOOLS CALLED]
- {tool_name}({arg_summary}) → {result_summary truncated 200}
- ...

[RETRIEVED CONTEXT]   # only if present
{chunks truncated 2000}

[OUTCOME] success|error  duration_ms={n}  tokens={n}  cost_usd={n}
```

Keep under ~1500–2500 tokens for encoder models (DeBERTa 512–8k depending on variant; ModernBERT LettuceDetect up to 4–8k).

### 6.2 Pseudocode for `DescriptorEngine.describe`

```python
async def describe(org_id: str, trace_id: str, policy: Policy) -> DescribeResult:
    trace = await load_trace(org_id, trace_id)
    text = serialize_trace(trace)
    tags: list[DescriptorResult] = []

    # Tier 0
    tags += run_statgate_and_heuristics(trace)

    # Tier 1a — multi-label
    if policy.run_tagger:
        for item in gliclass_pipe(text, DESCRIPTOR_LABELS, threshold=policy.tag_threshold):
            tags.append(DescriptorResult(
                id=slug(item["label"]),
                confidence=item["score"],
                source="gliclass",
                model="gliclass-base-v3.0",
                tier=1,
            ))

    # Tier 1b — hallucination spans
    if trace.retrieval_context and policy.run_lettuce:
        lettuce = lettuce_detector.predict(...)
        if lettuce.hallucinated:
            tags.append(DescriptorResult(id="inaccuracy", ...))
            tags.append(DescriptorResult(id="unsupported_claim", ...))
            await write_judge_score("groundedness", 1 - lettuce.ratio, rationale=...)

    # Tier 1c — safety
    if policy.run_safety:
        tox = detoxify_model.predict(trace.assistant_text)
        if tox["toxicity"] > 0.5:
            tags.append(DescriptorResult(id="unsafe_content", confidence=tox["toxicity"], ...))

    await persist_tags(org_id, trace_id, tags)
    await merge_eval_tags_into_telemetry(org_id, trace_id, tags)

    # Tier 2 — Flow-Judge (sampled / escalated)
    if should_run_flow_judge(trace, tags, policy):
        scores = await flow_judge_batch(trace, ACTIVE_RUBRICS)
        await persist_judge_scores(scores)
        await persist_production_eval(aggregate(scores))

    # Tier 3 — rare
    if needs_llm_escalation(tags, scores, policy):
        await run_existing_eden_judges(trace)  # OpenRouter fast slot

    return DescribeResult(tags=tags, scores=scores)
```

### 6.3 Sampling policy (default)

| Condition | GLiClass | Lettuce | Flow-Judge | LLM |
|-----------|----------|---------|------------|-----|
| Every finalized trace | ✅ | if context | ❌ | ❌ |
| Stumble / P0 / new SHA | ✅ | ✅ | ✅ | if still low conf |
| Random sample | — | — | 5% | 0.5% of Flow-Judge |
| Budget exhausted | ✅ | optional off | ❌ | ❌ |

This yields **100% labelled/tagged** traces (cheap encoders) and **properly scored** traces on the important subset — matching the product ask without training.

---

## 7. Descriptor Taxonomy (Operator Language)

Same as prior research; mapped to off-the-shelf producers:

| ID | Display | Primary producer |
|----|---------|------------------|
| `inaccuracy` | Inaccuracy | GLiClass + LettuceDetect |
| `unsupported_claim` | Unsupported claim | LettuceDetect |
| `incomplete_answer` | Incomplete answer | GLiClass + Flow-Judge |
| `off_topic` | Off topic | GLiClass |
| `unnecessary_tool_call` | Unnecessary tool call | Heuristic + GLiClass |
| `wrong_tool` | Wrong tool | GLiClass + Flow-Judge |
| `missing_tool_call` | Missing tool call | GLiClass (F35 laziness) |
| `looping` | Looping | StatGate |
| `user_frustration` | User frustration | GLiClass |
| `verbose` | Verbose | GLiClass |
| `unclear` | Unclear | GLiClass |
| `refusal` | Refusal | GLiClass |
| `unsafe_content` | Unsafe content | Detoxify / Opir |
| `jailbreak_attempt` | Jailbreak attempt | Opir multitask |
| `contradiction` | Contradiction | GLiClass |
| `successful_resolution` | Successful resolution | GLiClass (positive) |
| `efficient` | Efficient | Heuristic + GLiClass |

**Hypothesis wording matters.** Prefer natural phrases as labels for GLiClass:

```python
# Better
"contains inaccurate or made-up facts"
"makes an unnecessary tool call"
"user is frustrated or annoyed"

# Worse (too abstract)
"inaccuracy"
"TSQ"
```

Then map display phrases → `descriptor_id` via a static dict in `taxonomy.py`.

---

## 8. Scoring Rubrics for Flow-Judge (Copy-Paste)

Map Eden’s existing judges to Flow-Judge `CustomMetric`s. Scores normalize to 0–1 for `judge_scores`.

### 8.1 Hallucination (binary → float)

```
criteria: Identify whether the assistant response invents facts, numbers,
dates, or tool results not supported by the provided context or tool outputs.
rubric:
  1 — Fully supported; no fabrication
  0 — Contains one or more unsupported claims
```

### 8.2 Correctness (3-Likert → {0, 0.5, 1})

```
criteria: Is the assistant's answer correct for the user's request?
rubric:
  2 — Correct and complete
  1 — Partially correct
  0 — Incorrect
```

### 8.3 Tool selection quality

```
criteria: Given the user request and available tools, did the agent select
appropriate tools with sensible arguments? Penalize unnecessary calls and
wrong tools.
rubric:
  1 — Appropriate tools and args (or correctly chose no tool)
  0 — Wrong tool, bad args, or unnecessary tool use
```

### 8.4 Action completion

```
criteria: Did the agent fully accomplish the user's goal across the trace?
rubric:
  1 — Goal completed
  0 — Goal incomplete or abandoned
```

### 8.5 Batching strategy

Run **3 core rubrics always** on sampled traces (`hallucination`, `correctness`, `tool_selection_quality`), and **expand to 10** only for stumbles / low GLiClass confidence. Cuts Flow-Judge tokens ~3×.

---

## 9. Cost Model — Ultra-Cheap

### 9.1 Unit costs (self-host)

| Stage | Hardware | $/trace (approx) | Notes |
|-------|----------|------------------|-------|
| Tier 0 | CPU | $0 | Existing StatGate |
| GLiClass base | CPU or shared GPU | ~$0.00001–0.00005 | Dominated by electricity; treat as $0 at 1M/mo on existing boxes |
| LettuceDetect | CPU/GPU | ~$0.00002 | Only when context |
| Detoxify | CPU | ~$0 | |
| Flow-Judge AWQ | 1× L4 shared | ~$0.0002–0.0005 | 3 rubrics, ~2k tokens in, ~80 tokens out |
| gpt-4o-mini | API | ~$0.001–0.003 | Escalation |

### 9.2 Scenario: 1M traces/month

| Component | Volume | Cost |
|-----------|--------|------|
| GLiClass 100% | 1,000,000 | ~$10–30 (CPU share) |
| LettuceDetect 20% (RAG) | 200,000 | ~$5 |
| Flow-Judge 5% × 3 rubrics | 50,000 | ~$15–40 |
| gpt-4o-mini 0.5% of Flow | 250 | ~$1 |
| L4 reserved (amortized) | 1 instance | $0 if already owned; else ~$50–150/mo fractional |
| **Total** | | **~$40–120/mo** |

Compare: Braintrust Topics (LLM facets on 100%) easily **$1k–5k/mo**; Galileo Luna hosted ~$300 at full coverage; GPT-4o judges **$15k–150k**.

### 9.3 Budget knobs (reuse `production_eval_policies`)

```json
{
  "descriptor_tagging_enabled": true,
  "gliclass_enabled": true,
  "lettuce_enabled": true,
  "flow_judge_sample_rate": 0.05,
  "flow_judge_core_metrics": ["hallucination", "correctness", "tool_selection_quality"],
  "llm_escalation_rate_cap": 0.005,
  "max_cost_usd_per_day": 20,
  "slm_only": true
}
```

### 9.4 Kill switches

- Disable Flow-Judge → tags still land (GLiClass)
- Disable GLiClass → Tier 0 only
- `slm_only=true` blocks OpenRouter path

---

## 10. Deployment Topologies

### A. Cheapest (CPU-first)

- GLiClass + LettuceDetect + Detoxify on API worker CPU
- Flow-Judge via **DeepInfra / Fireworks** serverless only when sampled (if you refuse to run GPU)
- Risk: Flow-Judge may not be hosted; then use **Phi-3.5-mini** on Fireworks (~$0.90/1M) with Flow-style prompts — worse than Flow-Judge but still no train

### B. Recommended (hybrid)

- Encoders on CPU in workers
- One shared **L4** for Flow-Judge AWQ via vLLM
- OpenRouter fallback

### C. High volume (10M+ traces/mo)

- GLiClass on GPU batch worker (Triton)
- Flow-Judge on 1–2 L4s with continuous batching
- Still no training — just more replicas

---

## 11. Eden Integration

### 11.1 New module

```
src/eden/evaluation/descriptors/
  taxonomy.py          # IDs, display labels, gliclass phrases
  serialize.py         # Trace → compact text
  gliclass_tagger.py   # Tier 1a
  lettuce_grounding.py # Tier 1b
  safety_tagger.py     # Tier 1c
  flow_scorer.py       # Tier 2 rubrics
  cascade.py           # Policy + escalation
  persist.py           # trace_eval_tags + tags merge + judge_scores
  engine.py            # describe()
```

### 11.2 Schema (unchanged from prior research)

```sql
CREATE TABLE trace_eval_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id VARCHAR(128) NOT NULL,
  trace_id VARCHAR(128) NOT NULL,
  span_id VARCHAR(128),
  descriptor_id VARCHAR(64) NOT NULL,
  polarity VARCHAR(16) NOT NULL,
  severity VARCHAR(16),
  confidence REAL NOT NULL,
  source VARCHAR(32) NOT NULL,  -- statgate|gliclass|lettuce|detoxify|flow|llm|human
  model VARCHAR(128),
  model_version VARCHAR(32),
  tier SMALLINT NOT NULL,
  evidence JSONB,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, trace_id, span_id, descriptor_id, source)
);
```

Also: `ALTER TABLE judge_scores ADD COLUMN labels TEXT[];` and fix tags format schism (`list[str]` with `eval:*`).

### 11.3 Wire into `trace_finalized_consumer`

After StatGate + signals + production sampler:

```python
await descriptor_engine.maybe_describe_trace(org_id, trace_id)
```

Replace production sampler **hash fallback** with: prefer `AVG(judge_scores)` else GLiClass-derived proxy (e.g. `1 - mean(negative_descriptor_confidences)`), never random hash.

### 11.4 Downstream

| Consumer | Action |
|----------|--------|
| Issues | Map descriptors → `StumbleKind` at conf ≥ 0.85 |
| Insights | DescriptorTrendDetector on `trace_eval_tags` |
| Datasets | Filter `descriptor=inaccuracy` |
| Typesense | Facet `tags` |
| Portal | Chips + filters |
| MCP | `eden_search_traces(descriptor=...)` |
| F35 | Align signal payloads with same IDs |

---

## 12. Portal UX

- **Traces table column “Labels”:** chips `Inaccuracy` `Unnecessary tool call` (max 3 +N)
- **Filter facet:** checkbox list from taxonomy
- **Trace detail:** Descriptors panel (confidence, source model, evidence quote) above Scores
- **Scores tab:** Flow-Judge scores + rationale; badge `tier=flow-judge` vs `tier=llm`
- **Empty state:** “Enable cheap eval tagging in Settings → Eval Policies”

---

## 13. Quality Assurance Without Training Data

You cannot train — you **can** still measure:

### 13.1 Shadow agreement

For 1–2 weeks, on 1% of traces run **Flow-Judge + existing OpenRouter judges** in parallel. Track:

- Pearson / Spearman on float scores  
- Exact match on binarized tags (GLiClass vs LLM paraphrase)  
- Target: ≥0.80 correlation on hallucination/correctness; ≥0.70 on tool metrics  

### 13.2 Public benches (no Eden labels needed)

| Model | Bench |
|-------|-------|
| LettuceDetect | RAGTruth (published) |
| Flow-Judge | Flow’s HaluEval / held-out (published) |
| GLiClass | Knowledgator 13-dataset avg F1 |

### 13.3 Threshold calibration (not training)

Label **200 traces** by hand (engineer time, not ML training). Sweep GLiClass thresholds `{0.35, 0.45, 0.55}` — pick F1-max. This is calibration, not gradient descent.

### 13.4 Online metrics

```
eden_descriptor_tags_total{descriptor,source}
eden_flow_judge_latency_seconds
eden_flow_vs_llm_agreement
eden_eval_cost_usd_total{tier}
```

---

## 14. Competitive Comparison

| Capability | Galileo Luna-2 | Braintrust Topics | Eden no-train stack |
|------------|----------------|-------------------|---------------------|
| Multi-label tags | Via many boolean metrics | Facet classifications | GLiClass descriptors |
| Hallucination | Luna head | LLM / scorers | LettuceDetect + Flow |
| Custom rubric scores | Luna Studio (train) | LLM scorers | Flow-Judge rubrics **no train** |
| Cost @ 1M traces | ~$300 hosted | $1k+ LLM facets | **~$40–120** |
| Open weights | ❌ | ❌ | ✅ |
| Agentic TSQ | Strong proprietary | Weak | Heuristic + Flow (weaker) |
| Closed-loop (issues→fix) | Partial | Strong datasets | Eden strength |

---

## 15. Implementation Roadmap (No-Train)

### Phase 0 — Foundations (1 week)

- [ ] `trace_eval_tags` migration  
- [ ] `taxonomy.py` + gliclass phrase map  
- [ ] Fix `tags` list/dict schism + portal types  
- [ ] Feature flag `features.descriptor_tagging_v1`

### Phase 1 — Tags on 100% (2 weeks)

- [ ] Tier 0 heuristics → descriptors  
- [ ] GLiClass integration + serialize  
- [ ] Persist + Typesense + portal chips  
- [ ] **Ship:** every trace labelled/tagged  

### Phase 2 — Groundedness + safety (1 week)

- [ ] LettuceDetect when context present  
- [ ] Detoxify or Opir  
- [ ] Write groundedness into `judge_scores`

### Phase 3 — Full scores (2–3 weeks)

- [ ] vLLM Flow-Judge AWQ service  
- [ ] 3–10 CustomMetric rubrics  
- [ ] Wire sampler; delete hash fallback  
- [ ] Shadow vs OpenRouter agreement  
- [ ] **Ship:** sampled traces fully scored + rationales  

### Phase 4 — Downstream (2 weeks)

- [ ] Issue promotion from descriptors  
- [ ] Dataset-from-descriptor  
- [ ] MCP search  
- [ ] Budgets + kill switches in settings UI  

**Total ~6–8 weeks to GA** — no labelling campaign, no GPU training jobs.

---

## 16. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| GLiClass weak on agentic tool nuance | Heuristics + Flow-Judge tool rubric on sample; accept Galileo gap for v1 |
| Flow-Judge weaker than gpt-4o on edge cases | Shadow agreement; escalate on low score margin |
| DeBERTa 512-token limit truncates long traces | Serialize aggressively; prefer ModernBERT/GLiNER2 for long context later |
| Encoder false positives annoy users | Show confidence; threshold calibration on 200 labels; human override |
| GPU ops burden | Start CPU-only tags; add Flow-Judge only when needed |
| License surprises | Stick to Apache 2.0 / MIT models listed above |

---

## 17. Decisions Locked / Open

### Locked by this research

1. **No training in v1**  
2. **Tagger = GLiClass base v3.0** (upgrade to large if needed)  
3. **Hallucination = LettuceDetect base** when context exists  
4. **Scorer = Flow-Judge-v0.1** (Prometheus-7B only if agreement fails)  
5. **100% tag / 5% deep score** default policy  

### Open

| # | Question | Options |
|---|----------|---------|
| 1 | Safety: Detoxify vs Opir multitask? | Prefer **Opir** if already installing gliclass stack; else Detoxify |
| 2 | Long traces: stay GLiClass or add GLiNER2? | Start GLiClass; add GLiNER2 if truncation hurts |
| 3 | Flow-Judge hosting: self vLLM vs API Phi-3.5? | Prefer **self vLLM AWQ** for cost |
| 4 | Span-level tags in v1? | Trace-level first; span via Lettuce evidence only |

---

## 18. References

### Agent-specialized (primary)

- Galileo Luna-2 — [arXiv:2602.18583](https://arxiv.org/abs/2602.18583) (100% traffic, no LLM-AJ; closed weights)  
- IBM ToolRM — [arXiv:2509.11963](https://arxiv.org/abs/2509.11963); data [`ibm-research/ToolRM-train-data`](https://huggingface.co/datasets/ibm-research/ToolRM-train-data); bench [`fc-reward-bench`](https://huggingface.co/datasets/ibm-research/fc-reward-bench)  
- Alibaba ToolRM (generative) — [arXiv:2510.26167](https://arxiv.org/abs/2510.26167); [`RioLee/ToolRM-Gen-Qwen3-4B-Thinking-2507`](https://huggingface.co/RioLee/ToolRM-Gen-Qwen3-4B-Thinking-2507) (**CC BY-NC-SA**)  
- AgentRM — [ACL 2025](https://aclanthology.org/2025.acl-long.945/); weights [`cheesewafer/*`](https://huggingface.co/cheesewafer)  
- SODA-Agent-Safety-Judge — [`cesun/SODA-Agent-Safety-Judge`](https://huggingface.co/cesun/SODA-Agent-Safety-Judge)  
- ToolFailBench — [arXiv:2607.04686](https://arxiv.org/html/2607.04686) (UTU / Tool-Skip / Result-Ignore / Output-Fabrication)  
- Agent-Failure-Classifier — [github](https://github.com/dakshjain-1616/agent-failure-classifier)  
- Microsoft AgentRx — [github](https://github.com/microsoft/AgentRx)  
- OpenJudge agent graders — [docs](https://agentscope-ai.github.io/OpenJudge/built_in_graders/agent_graders/)  
- LangChain AgentEvals — [github](https://github.com/langchain-ai/agentevals)  
- AgentHallu — [github](https://github.com/liuxuannan/AgentHallu)  

### Models (general / demoted for agents)

- [knowledgator/gliclass-base-v3.0](https://huggingface.co/knowledgator/gliclass-base-v3.0) — Apache 2.0 (demoted)  
- [KRLabsOrg/lettucedect-base-modernbert-en-v1](https://huggingface.co/KRLabsOrg/lettucedect-base-modernbert-en-v1) — MIT; use with **tool_results** as premise  
- [flowaicom/Flow-Judge-v0.1](https://huggingface.co/flowaicom/Flow-Judge-v0.1) — Apache 2.0 (demoted as primary)  

### Systems / papers (cost / cascade)

- Dichotomic multi-label prompting — [arXiv:2511.03830](https://arxiv.org/abs/2511.03830)  
- UCCI cascade routing — [arXiv:2605.18796](https://arxiv.org/abs/2605.18796) *(escalation pattern rejected for Eden GPT path)*  
- Cost-aware encoders vs LLM prompting — [arXiv:2602.06370](https://arxiv.org/abs/2602.06370)  
- Braintrust Topics — [docs](https://www.braintrust.dev/docs/observe/topics)  

### Eden

- `docs/docs/observability/judge-v2-plan.md` (training deferred)  
- `docs/specs/features/f62-slm-as-judge.md`  
- `docs/specs/features/f55-categorical-classifiers.md`  
- `src/eden/workers/trace_finalized_consumer.py`  
- `src/eden/evaluation/production/sampler.py`  
- `src/eden/signals/defaults.py`  

---

## 19. Appendices

### Appendix A — Example complete trace eval payload

```json
{
  "trace_id": "trc_abc123",
  "descriptors": [
    {
      "descriptor_id": "inaccuracy",
      "display_label": "Inaccuracy",
      "confidence": 0.81,
      "source": "gliclass",
      "model": "gliclass-base-v3.0",
      "tier": 1
    },
    {
      "descriptor_id": "unsupported_claim",
      "display_label": "Unsupported claim",
      "confidence": 0.93,
      "source": "lettuce",
      "model": "lettucedect-base-modernbert-en-v1",
      "tier": 1,
      "evidence": {"spans": [{"start": 120, "end": 158, "text": "refunded on January 15"}]}
    },
    {
      "descriptor_id": "unnecessary_tool_call",
      "display_label": "Unnecessary tool call",
      "confidence": 0.74,
      "source": "gliclass",
      "tier": 1
    }
  ],
  "tags": [
    "eval:inaccuracy",
    "eval:unsupported_claim",
    "eval:unnecessary_tool_call"
  ],
  "scores": [
    {
      "judge_name": "hallucination",
      "score": 0.0,
      "rationale": "Refund date not present in tool outputs.",
      "model": "Flow-Judge-v0.1",
      "tier": 2
    },
    {
      "judge_name": "correctness",
      "score": 0.5,
      "rationale": "Partially addresses refund status but invents date.",
      "model": "Flow-Judge-v0.1",
      "tier": 2
    },
    {
      "judge_name": "tool_selection_quality",
      "score": 0.0,
      "rationale": "search_kb called after answer already available from get_order.",
      "model": "Flow-Judge-v0.1",
      "tier": 2
    },
    {
      "judge_name": "groundedness",
      "score": 0.62,
      "rationale": "Token hallucination ratio 0.38",
      "model": "lettucedect-base-modernbert-en-v1",
      "tier": 1
    }
  ],
  "production_eval": {
    "score": 0.28,
    "passed": false,
    "judge_tier": "slm"
  },
  "cost_usd": 0.00041,
  "latency_ms": 186
}
```

### Appendix B — Cost chart (no-train)

```
Cost to fully tag + score 1M traces

GPT-4o ×10 always     ████████████████████████████████  $150,000
Braintrust Topics     ████                              $2,000+
Galileo Luna hosted   ██                                $300
Eden no-train stack   ▌                                 $40–120
Tags only (GLiClass)  ▌                                 <$30
```

### Appendix C — “Do we need to train later?” decision tree

```
After 30 days of shadow agreement:
  if Flow-Judge vs gpt-4o-mini correlation ≥ 0.85
     AND GLiClass precision on top-5 descriptors ≥ 0.75
  → stay no-train; optimize thresholds only

  else if only tool_selection / action_completion lag
  → keep GLiClass+Flow; escalate those metrics to gpt-4o-mini more often
     (still no train)

  else if systematic domain drift
  → THEN reopen judge-v2-plan.md training (out of v1 scope)
```

### Appendix D — One-page operator story

1. Trace finishes → Eden tags it in <200ms with chips you can read.  
2. Important / sampled traces get Flow-Judge scores + one-sentence why.  
3. You filter “Inaccuracy” → open dataset → ship a fix.  
4. Bill stays under ~$100/mo at 1M traces — not $15k.  

---

---

## 20. Layer A Deep Dive — What It Is, How It Works, Quality vs SLM

### 20.1 What Layer A is

**Layer A is not a model.** It is a **deterministic agent grader**: pure Python rules that inspect the structured fields of an agent trace (tool calls, args, results, message order, latency, errors) and emit the same descriptors an SLM would (`unnecessary_tool_call`, `bad_tool_args`, `looping`, …).

Think of it as **unit tests for trajectories**, not as an LLM.

```
Input:  Eden TelemetryEvent[] / UnifiedTrace
        - messages[]
        - tool_calls[{name, arguments, span_id}]
        - tool_results[{content, status, error}]
        - outcome, duration_ms, token counts

Process: for each Detector in AGENT_DETECTORS:
           if detector.matches(trace): emit DescriptorResult

Output:  list of descriptors with confidence=1.0 (or calibrated)
         + optional binary scores for judge_scores
         + template rationale strings (human-readable)
Cost:    $0
Latency: <5–20ms
```

### 20.2 Concrete detectors (how each works)

| Detector | How it decides | Emits |
|----------|----------------|-------|
| **Schema / bad args** | Validate `arguments` against tool JSON Schema (required keys, types, enums). Fail → label. | `bad_tool_args` |
| **Tool error** | `status >= 400` OR error string OR empty error payload | `tool_error` |
| **Timeout** | Span duration > policy OR finish_reason timeout | `timeout` |
| **Loop / repetitive** | Hash `(tool_name, canonical_args)`; same hash ≥ N times in window; or 2-step message cycle | `looping`, `repetitive_tool_call` |
| **Result ignore** | Extract salient tokens/IDs from tool_result; check if any appear in subsequent assistant text (normalized). None → `result_ignore` | `result_ignore` |
| **Unnecessary tool (UTU)** | Heuristic: user message is chitchat/greeting (lexicon) AND tools were called; OR tool result never referenced AND another path succeeded | `unnecessary_tool_call` |
| **Tool skip** | Policy says “tools required for this agent” OR prior turn asked for action requiring tool AND no tool_call before final answer | `tool_skip` |
| **Excessive steps** | `len(tool_calls) > budget` OR steps > policy | `excessive_steps` |
| **Cost spike** | Existing StatGate 3σ | `cost_spike` (metric) |
| **MCP auth** | Existing stumble path | `mcp_auth_failure` |

This is the same class of logic as:

- Eden `StatGate` / `AutoIssueScanner` today  
- ToolFailBench **rule classifier** ([arXiv:2607.04686](https://arxiv.org/html/2607.04686))  
- Agent-Failure-Classifier **rules mode**  
- OpenJudge `ActionLoopDetectionGrader` (code-based)

### 20.3 Will Layer A match SLM quality?

**Honest answer: No — not across the board. On structural failures, yes (often better). On semantic agent judgment, no.**

| Failure type | Layer A vs SLM | Why |
|--------------|----------------|-----|
| Bad JSON args / missing required params | **A ≥ SLM** | Schema check is exact; models hallucinate schema compliance |
| HTTP tool errors / timeouts | **A ≥ SLM** | Binary signals in telemetry |
| Exact tool+args loops | **A ≥ SLM** | Hash equality is perfect; SLMs approximate |
| Result-ignore (exact ID/number in answer) | **A ≈ SLM** | String/token containment works when returns are structured |
| Result-ignore (paraphrased use of tool value) | **A ≪ SLM** | ToolFailBench: rules are *brittle* on faithful paraphrases → they add LLM judges |
| Unnecessary tool when “should I call?” is semantic | **A ≪ SLM** | Needs understanding of user intent vs tool catalog |
| Wrong tool (right schema, wrong choice) | **A ≪ SLM** | Requires intent↔capability matching |
| Action completion / goal done? | **A ≪ SLM** | Multi-step goal reasoning |
| Soft hallucination not in tool JSON | **A ≪ SLM** | Needs language understanding |

**Quantitative evidence (ToolFailBench):**

- Rule-only Clean Tool-Use Rate mean ≈ **71%**  
- Rule + 2 LLM judges ensemble ≈ **75%**  
- Gap is mostly paraphrase / semantic cases, not schema/loop cases  

**IBM ToolRM paper:** Schema Validation is a **baseline** that ToolRM beats for Best-of-N ranking — meaning rules catch some errors but miss ranking quality that a specialized RM learns.

### 20.4 Correct role for Layer A

```
Layer A = high-precision structural net (catch what models shouldn't miss)
Layer B = specialized SLM for semantic agent metrics (what rules can't see)
```

Do **not** expect Layer A alone to replace Luna-2. Do expect Layer A to:

1. Label **50–70%+ of production agent failures** that are structural (errors, loops, schema) at **zero cost**  
2. Provide **training labels** and hard negatives for your own Luna-style heads  
3. Run at **100% traffic** forever  

---

## 21. Specific Models (Exact IDs) — Ready to Load

### 21.1 Production inference (commercial-safe)

| Exact ID | Params | License | Use in Eden |
|----------|--------|---------|-------------|
| [`cesun/SODA-Agent-Safety-Judge`](https://huggingface.co/cesun/SODA-Agent-Safety-Judge) | Qwen3-4B | Apache 2.0* | Agent trajectory SAFE/UNSAFE |
| [`cheesewafer/Meta-Llama-3.1-8B-Instruct-regression-avg-all-v3-True-False`](https://huggingface.co/cheesewafer/Meta-Llama-3.1-8B-Instruct-regression-avg-all-v3-True-False) | 8B | Llama Community | Scalar AgentRM trajectory score |
| [`cheesewafer/Meta-Llama-3.2-3B-Instruct-regression-avg-all-v3-True-False`](https://huggingface.co/cheesewafer/Meta-Llama-3.2-3B-Instruct-regression-avg-all-v3-True-False) | 3B | Llama Community | Cheaper AgentRM |
| [`KRLabsOrg/lettucedect-base-modernbert-en-v1`](https://huggingface.co/KRLabsOrg/lettucedect-base-modernbert-en-v1) | ~150M | MIT | Groundedness vs **tool_results** text |
| [`KRLabsOrg/lettucedect-large-modernbert-en-v1`](https://huggingface.co/KRLabsOrg/lettucedect-large-modernbert-en-v1) | ~395M | MIT | Higher F1 if needed |

\*Confirm SODA card license at download time; paper stack is Qwen3-Apache based.

### 21.2 Strong but license-blocked for SaaS

| Exact ID | License | Why blocked |
|----------|---------|-------------|
| [`RioLee/ToolRM-Gen-Qwen3-4B-Thinking-2507`](https://huggingface.co/RioLee/ToolRM-Gen-Qwen3-4B-Thinking-2507) | **CC BY-NC-SA 4.0** | Non-commercial — cannot ship in Eden cloud product |
| Dataset [`RioLee/ToolPref-Pairwise-30K`](https://huggingface.co/datasets/RioLee/ToolPref-Pairwise-30K) | **CC BY-NC-SA 4.0** | Same — research only |

### 21.3 Best training data (commercial-safe) — train your own

| Exact ID | License | Size | Role |
|----------|---------|------|------|
| [`ibm-research/ToolRM-train-data`](https://huggingface.co/datasets/ibm-research/ToolRM-train-data) | **Apache 2.0** (HF card) | **458,575** pairs | Perfect for Luna-style / ToolRM training |
| [`ibm-research/fc-reward-bench`](https://huggingface.co/datasets/ibm-research/fc-reward-bench) | check card | 1,500 | Holdout eval (error_type labeled) |
| [`SoHarshh/toolfailbench-traces`](https://huggingface.co/datasets/SoHarshh/toolfailbench-traces) | check card | 1k tasks | Failure-mode labels for multi-label heads |
| Salesforce [`xlam-function-calling-60k`](https://huggingface.co/datasets/Salesforce/xlam-function-calling-60k) | check card | 60k | Extra tool trajectories |

**IBM ToolRM-train-data fields (ready to convert):**

- `conversation`, `tools`  
- `tool_calls_correct` / `tool_calls_incorrect`  
- `generator_model`  

→ Convert to Luna format: prompt + target `True` (correct call is good / incorrect is bad) or train a **scalar RM** / **pairwise DiscRM** like IBM.

---

## 22. Can We Train Our Own Luna-2? YES — With Your Credits

### 22.1 Short answer

**Yes.** Luna-2 is an architecture, not a secret chip:

1. Shared Apache SLM backbone (recommend **Qwen3-4B** / Qwen3.5-4B)  
2. Per-metric **LoRA** heads  
3. Train as **single-token True/False** (or scalar reward head)  
4. Serve with vLLM `--enable-lora`  

Galileo’s proprietary data is closed; **IBM’s 458k Apache tool-call preference data substitutes** for the agentic metrics (tool selection, unnecessary call, bad args). Combine with Layer A labels + a few thousand Eden golden traces for domain fit.

Your **AWS or Azure credits are ideal** for this (Unsloth + single A10G/A100).

### 22.2 Recommended “Eden Luna” recipe (Unsloth)

#### Base model

```
unsloth/Qwen3-4B-Instruct   # or Qwen3.5-4B if available in Unsloth
# Apache 2.0, fits A10G 24GB with QLoRA / bf16 LoRA
```

#### Unsloth notebooks to start from

From [unsloth.ai/docs/get-started/unsloth-notebooks](https://unsloth.ai/docs/get-started/unsloth-notebooks):

| Goal | Notebook |
|------|----------|
| SFT conversational / custom task | **Qwen3 (4B)** / **Qwen3.5-4B** standard SFT Colab |
| Preference / alignment | **DPO Zephyr** notebook (adapt to tool pairs) |
| RL later | **Qwen3 (4B) Advanced GRPO LoRA** |
| Classification-style | **BERT Text Classification** notebook (for encoder path) OR custom CE on True/False tokens with SFT notebook |

**Practical path for Luna-style:**

1. Use **Qwen3-4B SFT notebook**  
2. Format each example as chat ending with assistant saying only `True` or `False`  
3. Loss on that single token (or full SFT then distill to logit readout)  
4. Train **one LoRA per metric** (save adapters separately)  
5. Or train **one multi-metric model** with metric name in the system prompt (simpler ops; slightly weaker than per-head)

#### Data conversion (IBM → Luna)

```python
# Pseudocode — run offline before Unsloth
for row in ibm_toolrm_train:
    tools = json.loads(row["tools"])
    conv = row["conversation"]
    # POSITIVE: correct tool call is appropriate
    yield {
      "messages": [
        {"role":"system","content": METRIC_PROMPT["tool_selection_quality"]},
        {"role":"user","content": format_trace(conv, tools, row["tool_calls_correct"])},
        {"role":"assistant","content":"True"},
      ]
    }
    # NEGATIVE
    yield {
      "messages": [... format with tool_calls_incorrect ...,
                   {"role":"assistant","content":"False"}]
    }
```

**Metric heads to train first (agent-critical):**

| LoRA / metric_id | Training signal |
|------------------|-----------------|
| `tool_selection_quality` | IBM correct vs incorrect calls |
| `unnecessary_tool_call` | Irrelevance split (41,967) + control-style negatives |
| `bad_tool_args` | Filter IBM `error_type`-like failures; fc-reward-bench error taxonomy |
| `action_completion` | Needs synthetic/Eden labels (less covered by IBM alone) |
| `output_fabrication` | Pair LettuceDetect weak labels + tool_results grounding |

Galileo cites **~4,000 labeled samples per custom metric** for fine-tune. IBM gives you **orders of magnitude more** for tool metrics.

### 22.3 Cloud cost with AWS / Azure credits

| Job | Hardware | Hours (Unsloth LoRA) | Est. cost |
|-----|----------|----------------------|-----------|
| 1 metric head, 20–50k samples | AWS `g5.xlarge` (A10G 24GB) | 4–12 h | **~$4–17** on-demand; **~$2–6** spot |
| 5 metric heads | same | 20–60 h | **~$20–85** on-demand |
| Full 10-head Eden Luna + eval | A10G or 1×A100 | 40–100 h | **~$50–200** |
| SageMaker managed | `ml.g5.xlarge` ~$1.41/hr | same hours | ~30–40% premium vs EC2 |

**Azure:** `NC`/`NCasT4_v3` (~T4 16GB) works for QLoRA 4B; prefer **NC A100** or **NVadsA10** if available on your subscription for faster runs.

**Credits verdict:** Even **$200–500 of credits** is enough to train a credible Eden Luna v1 for agent metrics and run shadow eval. Inference later: 1× `g5.xlarge` 24/7 ≈ $700–1000/mo — or keep inference on a shared L4 and only train with credits.

### 22.4 Training → serving (Luna parity)

```
Train (Unsloth) → export LoRA adapters
Serve (vLLM):
  vllm serve unsloth/Qwen3-4B-Instruct \
    --enable-lora \
    --lora-modules tool_selection=./lora_tool_selection \
                   unnecessary=./lora_unnecessary \
                   ...
Inference:
  one forward pass; score = P("True") / (P("True")+P("False"))
```

Matches Eden `judge-v2-plan.md` and Galileo’s published method.

### 22.5 Eval gates before production

| Gate | Target |
|------|--------|
| `ibm-research/fc-reward-bench` pairwise accuracy | Beat Schema-Validation baseline; aim ToolRM-paper ballpark |
| Agreement with gpt-4o-mini on 500 Eden traces | ≥ 0.85 for tool metrics |
| Layer A ∩ model agreement on structural labels | ≥ 0.95 (models shouldn’t disagree with schema) |
| p95 latency single metric | < 200ms |

---

## 23. Perfect Solution (Recommended Decision Tree)

```
                    ┌──────────────────────────────────────┐
                    │ Goal: agent labels + scores, cheap   │
                    └──────────────────┬───────────────────┘
                                       │
              ┌────────────────────────▼────────────────────────┐
              │ ALWAYS ship Layer A (deterministic graders)     │
              │ Structural labels @ $0, 100% traffic            │
              └────────────────────────┬────────────────────────┘
                                       │
         ┌─────────────────────────────┴─────────────────────────────┐
         │                                                           │
         ▼                                                           ▼
┌─────────────────────────┐                           ┌──────────────────────────┐
│ Short-term (week 1–3)   │                           │ Medium-term (week 2–6)   │
│ Load SODA-4B + AgentRM  │                           │ TRAIN Eden Luna on AWS   │
│ 3B/8B (no train)        │                           │ credits via Unsloth      │
│ + Lettuce on tool JSON  │                           │ Data: ibm ToolRM-train   │
└─────────────────────────┘                           │ Base: Qwen3-4B           │
                                                      │ Heads: tool_selection,   │
                                                      │ unnecessary, bad_args,   │
                                                      │ fabrication, ...         │
                                                      └──────────────────────────┘
                                       │
                                       ▼
                      ┌────────────────────────────────┐
                      │ Production: Layer A + Eden Luna│
                      │ NO GPT escalation              │
                      │ Optional: keep SODA for safety │
                      └────────────────────────────────┘
```

### Why this is “perfect” given constraints

| Requirement | How met |
|-------------|---------|
| Agent-specialized | IBM tool data + SODA + AgentRM + Layer A taxonomy |
| Specific models | Exact HF IDs above |
| Can fine-tune | Unsloth Qwen3-4B notebooks + Apache IBM data |
| Credits useful | Yes — train + shadow eval for tens of dollars |
| Cheap at scale | Luna single-token path + Layer A $0 |
| Quality | Layer A for structure; trained SLM for semantics (Luna parity) |
| No NC license trap | Avoid RioLee ToolRM weights/data for commercial; use IBM Apache data |

### What not to do

- Do **not** rely on GLiClass as the agent tagger  
- Do **not** use RioLee ToolRM in commercial SaaS without a license deal  
- Do **not** add GPT escalation  
- Do **not** expect Layer A alone to equal Luna on `wrong_tool` / soft UTU  

---

## 24. Layer A vs Trained SLM — Side-by-Side Example

**Trace:** User: “Thanks!” → Agent calls `search_kb({q:"Thanks!"})` → returns docs → Agent: “You’re welcome!”

| System | Result |
|--------|--------|
| Layer A | `unnecessary_tool_call` (chitchat + tool), confidence 1.0, rationale template |
| Untuned GLiClass | Maybe “off topic” / noise — unreliable |
| Eden Luna `unnecessary` head (trained) | `True` with P≈0.91 — semantic confirmation |
| GPT-4o judge | Same, $0.01, 1.2s |

**Trace:** Agent calls `get_order` correctly, answer paraphrases order total without copying digits exactly.

| System | Result |
|--------|--------|
| Layer A result_ignore | May **false-positive** (brittle string match) |
| Eden Luna / Lettuce on tool JSON | Correctly sees value was used |
| ToolFailBench finding | Why they ensemble rules + LLM |

→ **Both layers required for SLM-class quality.**

---

*§20–24 added 2026-07-15. Authoritative with §0 for agent path; training path unlocks Luna parity using AWS/Azure credits.*
