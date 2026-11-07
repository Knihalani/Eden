<!-- Desk research for the CL wave (2026-11-07), by a research subagent; [DOC] = cited source, [EST] = estimate, [REPO] = read in this repo. Not measured here. -->
# Cutting cost and latency of Eden's reader: research notes (2026-11-07)

Labels: **[DOC]** = stated in a cited source (fetched this session). **[EST]** = my arithmetic or judgement from the
facts in the brief; not measured. **[REPO]** = read in /home/user/Eden this session.

## 0. Where the money and time go now (arithmetic from the brief) [EST]

Reader call, Haiku 5.5 list prices ($0.10 in, $0.01 cache read, $0.50 out per MTok, prompts under 100k) [DOC pricing]:

| Part | Tokens | $/call | Share |
|---|---|---|---|
| cached system prompt | 943 | 0.0000094 | 3% |
| uncached items + request | 1,860 | 0.000186 | 67% |
| output | 166 | 0.000083 | 30% |
| **total** | | **~0.000279** | |

x 0.92 calls/task = **~$0.257 per 1k tasks**, so the reader is ~85% of Eden's ~$0.30/1k; cards are the remaining
~$0.04/1k. A card call is ~2,500 x 0.10 + 645 x 0.50 = **~$0.00057**.

Latency: p50 ~1.0 s = TTFT ~0.5 s + 166 x ~3 ms (~0.5 s). Half the wall time is output tokens; half is TTFT.

Consequences: (a) the system-prompt cache is already nearly free; the uncached 1,860 tokens and the 166 output tokens
are the cost; (b) the only lever that moves cost *and* latency by >2x is not calling the reader (gate), or not
waiting for it (off critical path); (c) batch matters only for cards (~13% of Eden).

Note on the goal "Eden below agent-alone ($0.35/1k)": Eden alone ($0.30/1k) is already below $0.35/1k. If the goal
means *agent+Eden below agent alone*, Eden must save the agent >$0.30/1k (e.g. fewer agent turns/tool calls on the
~20% of tasks it helps); that is an eval question (Pi harness), not an API lever. Both readings are covered below.

## 1. Anthropic API facts

### Prompt caching [DOC https://platform.claude.com/docs/en/build-with-claude/prompt-caching]
- Minimum cacheable prompt: **512 tokens for Claude Haiku 5.5** (also Opus 5.5/5, Sonnet 5.5, Fable 5/5.1).
  **4,096 for Haiku 4.5**, 2,048 for Opus 4.7, 1,024 for Sonnet 4.6/Opus 4.8/Sonnet 5. Not monotonic across generations.
- Below the minimum: "processed without caching, and no error is returned"; check `cache_creation_input_tokens` and
  `cache_read_input_tokens` both 0. **Pitfall for Eden: the 943-token prefix caches on Haiku 5.5 but would silently
  not cache on Haiku 4.5** (e.g. a fallback or a lab run pinned to 4.5).
- TTL: 5 min default (write 1.25x), 1 h (write 2x); reads 0.1x on Haiku 5.5 ($0.01/MTok). Haiku 5.5 above 100k-token
  prompts: $0.50 in / $0.05 read / $2.50 out.
- Lifetime counts from the **start** of the request that writes/reads; every read refreshes for free.
- **Concurrent requests: "A cache entry only becomes available after the first response starts."** Parallel
  first-requests per tenant each pay a write.
- Max 4 breakpoints; lookback 20 positions per breakpoint.
- Pre-warm: `max_tokens: 0` writes the cache, bills zero output; rejected with `stream: true`, `output_config.format`,
  forced tool_choice, inside Batches.
- Cache hits are not deducted from rate limits (stated in the 1-hour section).
- Break-even: 5-min TTL pays off at 2 uses, 1-h TTL at 3 uses (skill reference, `shared/prompt-caching.md`).
- Changing `output_config.format` or top-level `effort` invalidates the messages cache.

### Pricing extras [DOC https://platform.claude.com/docs/en/about-claude/pricing]
- Batch: **50% off input and output**; Haiku 5.5 batch $0.05 / $0.25. Stacks with caching and data residency.
- `inference_geo: "us"`: **1.1x** on all token categories (keep `global`).
- Tool-use system prompt overhead on Haiku 5.5: **286 tokens** (auto/none), 406 (any/tool); Haiku 4.5: 496/588.
  Implication: returning JSON as text/structured output instead of via a tool saves ~286 input tokens per call.

### Message Batches [DOC https://platform.claude.com/docs/en/build-with-claude/batch-processing]
- 50% off; "most batches finishing in less than 1 hour"; expire if not done in **24 h** (expired requests not billed).
- Limits: 100,000 requests or 256 MB per batch; results kept 29 days; not ZDR-eligible.
- Caching in batches is best-effort: "cache hit rates ranging from 30 percent to 98 percent"; docs suggest the 1-hour
  TTL and identical `cache_control` blocks in every request. `max_tokens: 0` not allowed in a batch.
- Fits: card/intent generation (once per item, not on the agent's path). Does not fit: the reader.

### Priority Tier / service tiers [DOC https://platform.claude.com/docs/en/api/service-tiers]
- "Service tiers are legacy"; **Priority Tier commitments are no longer sold**; Priority Tier is **not supported on
  Claude Haiku 5.5** (excluded list includes Haiku 5.5, Opus 5.5, Sonnet 5.5). Target was 99.5% uptime, not latency.
  => Not a lever.
- Fast mode: Opus 5/5.5/4.8 only (skill reference) => not a lever for Haiku.

### Latency guidance [DOC https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-latency]
- Haiku 5.5 is the fastest model; effort is "its main control for speed and cost"; trim input/output tokens; stream.
- Haiku 5.5 thinking is **on by default at `medium` effort** and counts toward `max_tokens`; `thinking: disabled`
  works at low/medium/high only [DOC https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5].
  "Telling the model in the prompt to answer directly didn't stop it from thinking."
  [REPO] Eden already sends thinking off (`packages/llm/src/anthropic.ts` default "off"; reader/cards send no effort,
  D144/D155; cards.ts notes "low" was 1.82x slower at p50). Keep it that way: any wrapper that omits `thinking` on
  Haiku 5.5 silently turns thinking on.
- Same doc page: with thinking off Haiku 5.5 "sometimes writes reasoning-like text in the reply" - relevant to the
  `why` field length.

### Structured outputs [DOC https://platform.claude.com/docs/en/build-with-claude/structured-outputs]
- Supported on Haiku 5.5. First use of a schema pays grammar-compile latency; compiled grammars cached **24 h from last
  use**; changing the schema invalidates the prompt cache; adds a hidden system prompt (token count not stated).
- Use only with a fixed schema; it removes parse failures/preambles but is not itself a latency win (unmeasured).

### Token-efficient tool use
- The old `token-efficient-tools-2025-02-19` beta page now redirects to the migration-guide index (fetched); I found
  no current Haiku 5.5 statement. Treat as not a lever [unverified].

### Other API items
- Streaming (`stop_sequences`, early abort): the API bills only tokens generated before you close the stream
  [EST: standard behaviour, not re-verified this session]. A client that stops reading at a decisive JSON prefix and
  aborts saves the remaining output tokens and their ~3 ms each.
- `stop_sequences` can end generation at a known delimiter (e.g. after the verdict array) to prevent trailing prose.
- Hedged requests for p99 (skill `latency-optimization/levers.md`): a second attempt at a deadline; pays twice only on
  the slow fraction.
- [REPO] `packages/llm/src/openrouter.ts`: Anthropic `cache_control` through OpenRouter is **default off**. If the
  shipped OpenRouter route runs Haiku without it, the 943-token system prompt is billed at full price every call
  (943 x $0.09/M = $0.000085/call, ~30% of the reader's input bill). Check which route production uses.

## 2. Gating and cascades (literature)

- **FrugalGPT** (Chen, Zaharia, Zou 2023): learned cascade + scorer; matches GPT-4 at **up to 98% lower cost**, or
  +4% accuracy at equal cost. Best case on their benchmarks. https://arxiv.org/abs/2305.05176
- **RouteLLM** (ICLR 2025): router trained on preference data; paper headline ">2x" cost cut without quality loss;
  project page: **85% on MT Bench, 45% MMLU, 35% GSM8K** at 95% of GPT-4 quality. https://arxiv.org/abs/2406.18665 ,
  https://sky.cs.berkeley.edu/project/routellm/
- **Cascades with early abstention** (2025): add an abstain threshold below the defer threshold at the cheap stage;
  small/large error correlation lets the cheap stage abstain on cases the big model would also abstain on.
  https://arxiv.org/abs/2502.09054 . Controlled-risk deployment (2024) notes RLHF models are poorly calibrated, so
  thresholds must be fitted on a calibration set. https://arxiv.org/abs/2410.02173 . Conformal cascades replace raw
  confidence thresholds with conformal sets for distribution-free guarantees. https://arxiv.org/abs/2607.25018
- **Adaptive-RAG** (Jeong et al. 2024): T5-Large (770M) query-complexity classifier routes no-retrieval / single /
  multi-step; FLAN-T5-XL relative time per query **3.60 vs 8.81** for always-multi-step (oracle 2.11) at comparable
  accuracy. https://arxiv.org/abs/2403.14403
- **QPP as a gate**: QPP estimates correlate strongly with answer quality in agentic RAG (2025); RAG-QPP helps most on
  low-effectiveness queries; old caveat (Hauff 2010): many predictors too weak to drive selective decisions.
  https://arxiv.org/abs/2507.10411 . TARG: training-free retrieve/skip gate from a short draft's uncertainty.
  https://arxiv.org/abs/2511.09803
- **Proactive "when to speak" gates**: PRISM (ICLR 2026) cost-sensitive gate, fast mode by default and slow
  (LLM) deliberation only near the decision boundary; false alarms -22.78%, F1 +20.14% over baselines.
  https://arxiv.org/abs/2602.01532 . DiscussLLM: RoBERTa-base binary "should I interrupt" classifier + generator
  reached 93.18% vs 96.59% end-to-end. https://arxiv.org/abs/2508.18167
- **Semantic caching** is risky for verdicts: MeanCache precision 0.72 vs **GPTCache 0.52** (233 false hits) in its
  end-to-end test; InstCache found GPTCache hits not reliably equivalent. Vendor numbers: 0.95 threshold ~15-25% hit
  rate with 1-3% false positives [vendor, unvalidated]. https://arxiv.org/abs/2403.02694 , https://arxiv.org/abs/2411.13820
  => use **exact-key verdict caching** (hash of request-normalised text + item ids/versions), not similarity.
- **Precompute at ingest ("sleep-time compute")**: Letta/Berkeley 2025: ~**5x less test-time compute** at equal
  accuracy; 2.5x lower cost per query when amortised across related queries; benefit depends on query
  predictability. https://arxiv.org/abs/2504.13171 . Eden's cards are already this; the extension is precomputing
  per-item "trigger" signatures (entities, verbs, conditions) so the request-time check is a lookup.

Failure modes common to all gates: miscalibrated confidence (needs a held-out calibration set and periodic re-fit);
distribution shift per tenant; cheap stage's systematic errors correlate with the teacher's (distillation copies
them); a gate that is too eager raises false-fire, one too strict loses recall silently (monitor sampled
shadow-runs of the full reader on gated-out traffic).

## 3. Latency off the critical path

- **Asynchronous / non-blocking**: AsyncLM (2024) - async function calls with interrupts gave **1.6-5.4x lower
  end-to-end latency** on BFCL at equal accuracy. https://arxiv.org/abs/2412.07017 . For Eden: return immediately,
  deliver bound context as an injection on the agent's *next* turn (or when the reader finishes before the agent's
  own model call ends). Critical-path latency -> gate time only. Cost: injection arrives one turn late; single-request
  tasks get nothing unless the reader beats the agent's TTFT.
- **Speculative execution**: Speculative Actions (ICLR 2026): fast model predicts next actions, run in parallel,
  commit on match; up to 55% next-action accuracy -> **~20% end-to-end lossless speedup**; cost grows with breadth.
  https://arxiv.org/abs/2510.04371 . Dynamic Speculative Agent Planning: up to 30% lower cost than fixed-step.
  https://arxiv.org/abs/2509.01920 . For Eden: start the reader on the user's message (or the first streamed tokens of
  the agent's request) before the agent finishes formulating its ask; pay a wasted call when the final request
  differs.
- **Prefetch / pre-warm**: skill reference `latency-optimization/levers.md`: prefetch moves typical waits more than
  tails; `max_tokens: 0` pre-warm only when traffic gaps exceed TTL.
- **Output minimisation / early exit**: every output token is ~3 ms here (brief). Put the decision first when the
  answer is "none" (e.g. `{"bind":[]}` short-circuit), keep `why` only when something binds, stream and abort as soon
  as the verdict array closes, `stop_sequences` on the closing delimiter. Caveat from the repo: D96 credits the `why`
  field with the decoy cut, so order/length changes need the eval.
- **Hedging** for p99 (skill reference).

## 4. Small local models (<=1B) as the relevance/entailment judge

- **MiniCheck** (EMNLP 2024): Flan-T5 770M fine-tuned on synthetic data reaches **GPT-4-level accuracy on
  LLM-AggreFact at ~400x lower cost**; beats earlier specialised checkers by 4-10 points.
  https://arxiv.org/abs/2404.10774
- **HHEM-2.1-Open** (Vectara, flan-t5-base): balanced accuracy 76.55 vs GPT-4 73.78 (AggreFact-SOTA), 64.42 vs 62.62
  (RAGTruth-Summ); **<1.5 s per 2k-token pair on an Intel Xeon CPU, <600 MB RAM**; drops to 62.58% on long premises.
  Vendor benchmarks. https://huggingface.co/vectara/hallucination_evaluation_model ,
  https://www.vectara.com/blog/hallucination-detection-commercial-vs-open-source-a-deep-dive
- **Qwen3-Reranker-0.6B**: LLM-style yes/no relevance scorer; MTEB-R 65.80 vs 57.03 for BGE-reranker-v2-m3.
  No published CPU latency. https://huggingface.co/Qwen/Qwen3-Reranker-0.6B
- **Cross-encoders (MiniLM-L6, 22M; ModernBERT)**: distilled cross-encoders can match ranking LLMs on TREC DL while
  being "orders of magnitude more efficient" (Webis, https://arxiv.org/abs/2405.07920). MiniLM-L6 int8 ONNX file
  15.2 MB; no published CPU per-pair latency (benchmark ourselves). sbert int8/ONNX guide:
  https://sbert.net/docs/cross_encoder/usage/efficiency.html . ModernBERT's speed edge depends on unpadding/flash
  attention; on non-flash backends it was slower than DeBERTa-v3 (MPS 120 vs 150 docs/s); DeBERTa-v3 better quality
  when data controlled. https://arxiv.org/abs/2504.08716
- **Distilling LLM labels into small classifiers**: GPT-4-labelled students near human-label students on 14 tasks
  (Pangakis & Wolken 2024); LlamBERT (https://arxiv.org/abs/2403.15938) comparable to LLM labelling at much lower
  cost; LLM systematic errors hurt students more than random noise; TnT-LLM distilled classifiers had higher
  precision, lower recall than GPT-4. RED-CT warns of overfitting noisy LLM labels: https://arxiv.org/abs/2408.08217
- LLM-judge agreement with humans is itself only moderate (kappa 0.20-0.64 in surveyed work; a supervised classifier
  beat LLMs, kappa 0.669 vs 0.332, in one specialised domain - EMNLP 2025 industry).
  https://aclanthology.org/anthology-files/pdf/emnlp/2025.emnlp-industry.132.pdf
- Hosting [EST]: a 22M-140M cross-encoder int8 on one vCPU scores ~12 short pairs in tens of ms (unmeasured; measure
  with primitives' benchmark rules); a 0.6B decoder on CPU is roughly 10x slower and wants a GPU or batching. Marginal
  cost is CPU time on the existing server - effectively $0 per call versus $0.00028.
  Eden already has a measured "hot kernels stay TypeScript" rule (D22) and few-deps policy: an ONNX runtime is a new
  dependency needing justification; a distilled linear/GBDT model over Eden's existing features (no new runtime) is
  the dependency-free first step.

## 5. Prioritised levers (see handback for the ranked list with effect sizes)

1. No-model gate in front of the reader (skip ~half of the reader calls). [EST] -40 to -55% reader cost and mean latency.
2. Take the reader off the agent's critical path (inject on the next turn). [DOC AsyncLM 1.6-5.4x] [EST] p50 added ~1.0 s -> gate time.
3. Exact-key verdict cache plus precomputed per-item triggers (sleep-time compute). [EST] 10-40% fewer calls on long horizons.
4. Cut the output: decision first, "why" only on bind, ids not text, abort the stream. [EST] -0.3 to -0.4 s, -20 to -25% cost.
5. Cache the stable part of the uncached 1,860 tokens; sort items deterministically. [EST] up to -30% reader cost.
6. Distil the reader into a local small judge (cascade). [DOC MiniCheck/HHEM] [EST] -70 to -90% calls if calibrated.
7. Batch API for cards and intents (50%). [DOC] -~6% of Eden's bill.
8. Hygiene / pitfalls: thinking off on Haiku 5.5, cache_control on OpenRouter, 4,096 min on Haiku 4.5, global geo, no tools.
9. Speculative start on the user message. [DOC Speculative Actions ~20%] [EST] -0.3 to -0.5 s, +wasted calls.
10. Not levers: Priority Tier (legacy, no Haiku 5.5), fast mode (Opus only), 1h TTL for the 943-token prefix.
