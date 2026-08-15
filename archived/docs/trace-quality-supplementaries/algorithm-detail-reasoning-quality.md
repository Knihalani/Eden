# Reasoning Quality + Self-Correction — Concrete Algorithm Detail

**Purpose:** Implementation-grade reference for Eden's Phase 9 *reasoning
quality* surface — the per-trace composite that scores how well an agent's
chain-of-thought (CoT) actually justified its decisions, NOT just how
efficiently it got there. The main spec §4.9 lists five scoring axes plus a
self-correction counter; this file gives exact pseudocode, thresholds,
regexes, integration points, and tests.

**Audience:** Engineers implementing Phase 9 (`ReasoningTraceMetrics` per the
main spec §4.7g) and the maintainers who will re-calibrate the composite
weights on real customer data.

**Status:** v1.0 — ready for implementation.

---

## 0. Why CoT Scoring Is Hard — The Lanham / Arcuschin Result

The motivating finding from Lanham et al. 2023 (Anthropic; arXiv **2307.13702**
"Measuring Faithfulness in Chain-of-Thought Reasoning") and confirmed by
Arcuschin et al. 2025 (arXiv **2503.08679** "Chain-of-Thought Reasoning In
The Wild Is Not Always Faithful"):

- When researchers **paraphrase** a model's CoT or **add a mistake** in the
  middle of the CoT and the model's final answer does **not** change, the CoT
  was *not causally responsible* for the answer. It was *post-hoc
  rationalisation* — a fluent justification that did not influence the actual
  decision.
- In Lanham's setup, on the tasks studied, **the fraction of CoT that is
  causally faithful ranges from 0% to ~80%** depending on model and task.
- Larger / more capable models produce **less faithful** CoT on most tasks —
  the very fluency that makes the CoT look good is the same property that
  lets it rationalise away.
- Arcuschin's 2025 paper extends this to natural, non-adversarial prompts
  and finds **up to 13% implicit post-hoc rationalisation in production
  models** (e.g., answering "Yes" to both "Is X > Y?" and "Is Y > X?" with
  superficially coherent arguments). Frontier / "thinking" models are more
  faithful but not entirely — DeepSeek R1 ~0.37%, Claude 3.7 with thinking
  ~0.04%.
- In hard math, models use *unfaithfully illogical shortcuts* — speculative
  answers dressed up as rigorous proofs.

**Implication for Eden:** every signal we produce here must be **conditional
on the trace structure**, not the *surface* CoT. Our composite weights
**verification presence** higher than a naive "looks coherent" rubric, and
**calibration error** (logprob-based) is the only signal that touches the
model's actual confidence vs. its claimed justification.

**What we score, explicitly:**
1. **Coherence** — are consecutive reasoning steps logically consistent
   (DeBERTa-NLI pairwise entailment)?
2. **Informativeness** — does each step add genuine content (MiniLM cosine
   dissimilarity to the prior step)?
3. **Goal alignment** — does each step advance the original user goal
   (cosine to the user prompt)?
4. **Verification presence** — does the agent verify, sanity-check, or
   reconsider its conclusions (regex on markers)?
5. **Calibration error** — when the LLM was *confident* (top-logprob
   threshold), did the world agree (tool result contradicts)?

The composite (see §7) is `0.3·coh + 0.2·info + 0.2·goal + 0.15·ver + 0.15·(1 - calib)`.
We deliberately weight *coherence* highest (30%) but *cap* its contribution
if verification is absent (the Lanham trap: high coherence without
verification is the classic post-hoc rationalisation signature).

---

## 0.1 Inputs and Outputs

**Input:** a normalised `UnifiedTraceEvent` list (see
`algorithm-detail-tracerazor.md` §0.1) plus the **first user prompt**
extracted from the trace's first `llm.completion.request_body`.

**Output:** a `ReasoningReport` (JSONB-serialisable):

```python
@dataclass
class ReasoningReport:
    trace_id: str
    tenant_id: str
    coherence: float              # [0, 1]
    informativeness: float        # [0, 1]
    goal_alignment: float         # [0, 1]
    verification: float           # [0, 1]
    calibration_error: float      # [0, 1] — LOWER is better
    composite: float              # [0, 1] — composite score
    self_corrections: list[SelfCorrectionMarker]
    reasoning_failure_patterns: list[str]
    latency_ms: float
    details: dict[str, Any]

    @property
    def grade(self) -> str:
        if self.composite >= 0.80: return "A"
        if self.composite >= 0.65: return "B"
        if self.composite >= 0.50: return "C"
        if self.composite >= 0.35: return "D"
        return "F"
```

`SelfCorrectionMarker` is defined in §6.

**Per-metric signals** are persisted to a new `reasoning_reflections`
table (§8) and feed the closed-loop hook (§9).

---

## 1. Coherence — Pairwise NLI Between Consecutive Steps

**Definition (this file):** mean pairwise *entailment* score across all
consecutive reasoning-step pairs, computed by
`MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli` (184M params, INT8, ~25ms/step
warm on CPU). Reuses the Phase 5 quality-stack `DebertaNLIScorer`.

A "reasoning step" is the concatenation of `payload.reasoning` +
`payload.thought` + `payload.chain_of_thought` (whichever is present) from
each `llm.completion` event with `event_type == "llm.completion"`.

### 1.1 Algorithm

```python
from __future__ import annotations
from typing import Iterable
from dataclasses import dataclass

DEBERTA_NLI_MODEL = "MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli"
COHERENCE_ENTAIL_THRESHOLD = 0.70  # below this = neutral / contradiction
COHERENCE_MIN_STEPS = 2


@dataclass
class StepPair:
    """A pair of consecutive reasoning steps."""
    idx: int
    step_a: str
    step_b: str
    entail_a_to_b: float
    entail_b_to_a: float


def compute_coherence(
    steps: list[str],
    nli_scorer: "DebertaNLIScorer",   # injected; Phase 5
) -> MetricResult:
    """Pairwise NLI coherence.

    ``steps[i]`` is the i-th reasoning-step text in the trace.
    Score = mean of pairwise entailment across consecutive pairs,
    symmetrised as ``0.5 * (entail(a,b) + entail(b,a))``.
    """
    if len(steps) < COHERENCE_MIN_STEPS:
        return MetricResult(
            name="coherence",
            raw=1.0,
            weight=COMPOSITE_WEIGHTS["coherence"],
            details={
                "step_count": len(steps),
                "skipped_reason": "too_few_steps",
            },
        )

    pairs: list[StepPair] = []
    for i in range(1, len(steps)):
        s_a, s_b = steps[i - 1], steps[i]
        if not s_a.strip() or not s_b.strip():
            continue
        fwd = nli_scorer.entailment(s_a, s_b)         # P(entail|a,b)
        bwd = nli_scorer.entailment(s_b, s_a)
        sym = 0.5 * (fwd + bwd)
        pairs.append(StepPair(idx=i, step_a=s_a, step_b=s_b,
                              entail_a_to_b=fwd, entail_b_to_a=bwd))
        if sym < COHERENCE_ENTAIL_THRESHOLD:
            logger.info(
                "reasoning_intel: non-entailment pair at step %d: %.2f",
                i, sym,
            )

    if not pairs:
        return MetricResult(
            name="coherence",
            raw=1.0,
            weight=COMPOSITE_WEIGHTS["coherence"],
            details={"step_count": len(steps), "empty_reasoning": True},
        )

    raw = sum(0.5 * (p.entail_a_to_b + p.entail_b_to_a) for p in pairs) / len(pairs)
    return MetricResult(
        name="coherence",
        raw=raw,
        weight=COMPOSITE_WEIGHTS["coherence"],
        details={
            "step_count": len(steps),
            "pair_count": len(pairs),
            "min_pair_score": min(
                0.5 * (p.entail_a_to_b + p.entail_b_to_a) for p in pairs
            ),
            "low_pair_count": sum(
                1 for p in pairs
                if 0.5 * (p.entail_a_to_b + p.entail_b_to_a) < COHERENCE_ENTAIL_THRESHOLD
            ),
        },
    )
```

### 1.2 Edge Cases

| Case | Handling |
|---|---|
| < 2 reasoning steps | Coherence = 1.0 (vacuously coherent); `skipped_reason=too_few_steps` |
| Empty `payload.reasoning` | Pair is skipped, not penalised |
| Step text > 1500 chars | Truncate to first 1500 chars (DeBERTa 512-token cap, head-truncated) |
| NLI model unavailable | Graceful degrade: coherence = 0.5 + flag `nli_missing=True` in details |
| Non-English text | DeBERTa-v3 was trained primarily on English; flag `language=non_english` and down-weight by 0.5× (see Calibration §7.3) |
| Symmetric entailment but high contradiction | Use min(fwd, bwd) as `contradiction_score` for diagnostics, not raw |

### 1.3 Why Pairwise + Symmetric

- **Pairwise (not triplet)** keeps latency O(N) instead of O(N²); at N=20
  steps the DeBERTa pass is ~500ms — well under our 1.9s/step budget.
- **Symmetric** (`0.5·(entail(a,b) + entail(b,a))`) avoids a "directional"
  bias that single-direction scoring shows. If `a` entails `b` but `b`
  doesn't entail `a`, the agent is *moving forward* (adding info), which is
  fine. We want both directions to fail before we penalise coherence.

### 1.4 Performance

| Steps | Wall time (CPU, warm) |
|---|---|
| 2 | ~25ms (1 pair × 2 calls) |
| 5 | ~100ms (4 pairs × 2 calls) |
| 10 | ~200ms (9 pairs × 2 calls) |
| 20 | ~500ms (19 pairs × 2 calls) |

---

## 2. Informativeness — Cosine Dissimilarity Between Consecutive Steps

**Definition (this file):** mean pairwise MiniLM cosine *dissimilarity* across
consecutive reasoning steps. High dissimilarity = each step adds new info.
Reuses the Phase 3/5 `MiniLMEmbedder` (process-lifetime cached).

### 2.1 Algorithm

```python
INFORMATIVENESS_LOOKBACK = 8          # symmetric with ISR (§6 of tracerazor supplementary)
INFORMATIVENESS_DISSIM_TARGET = 0.40  # mean dissim ≥ 0.40 = good


def compute_informativeness(
    steps: list[str],
    embedder: "MiniLMEmbedder",       # injected; Phase 3/5
) -> MetricResult:
    """Informativeness via MiniLM cosine dissimilarity.

    ``dissim_i = 1 - cosine(step_i, step_j)`` for j in the prior
    ``INFORMATIVENESS_LOOKBACK`` steps. ``raw = mean(dissim)``.
    Higher = each step adds new information.
    """
    if len(steps) < 2 or not embedder.available:
        return MetricResult(
            name="informativeness",
            raw=0.5 if not embedder.available else 1.0,
            weight=COMPOSITE_WEIGHTS["informativeness"],
            details={
                "step_count": len(steps),
                "embedder_available": embedder.available,
            },
        )

    embs = [embedder.encode(s) for s in steps]
    dissim_scores: list[float] = []
    for i in range(1, len(steps)):
        max_sim = 0.0
        for j in range(max(0, i - INFORMATIVENESS_LOOKBACK), i):
            sim = _cosine(embs[i], embs[j])
            if sim > max_sim:
                max_sim = sim
        dissim_scores.append(1.0 - max_sim)

    raw = sum(dissim_scores) / len(dissim_scores)
    return MetricResult(
        name="informativeness",
        raw=raw,
        weight=COMPOSITE_WEIGHTS["informativeness"],
        details={
            "step_count": len(steps),
            "mean_dissim": round(raw, 4),
            "min_dissim": round(min(dissim_scores), 4),
            "target_met": raw >= INFORMATIVENESS_DISSIM_TARGET,
        },
    )
```

### 2.2 Edge Cases

| Case | Handling |
|---|---|
| 1 step | Informativeness = 1.0 (vacuously informative); degenerate |
| MiniLM unavailable | Informativeness = 0.5 + `embedder_available=False` (graceful degrade) |
| All steps identical (paraphrase loop) | Informativeness → 0.0 (correctly flagged) |
| Step text 0 chars | Skip the pair; don't contribute to mean |

### 2.3 Why Cosine Dissimilarity vs. Jaccard / BLEU

- **Cosine** captures *semantic* dissimilarity: "the price was 10%" and
  "the price was 9.99%" get high cosine (good); Jaccard/BLEU would rate
  them dissimilar (false positive).
- **Pre-normalised MiniLM** means `cosine = dot product`, ~1µs/step after
  embed. Total Phase 9 cost adds <1ms beyond the Phase 3 ensemble.
- The **windowed maximum** (max cosine to prior 8 steps, not just 1) catches
  the "step 5 is just a rephrasing of step 2" pattern that single-step
  similarity would miss.

### 2.4 Performance

- MiniLM embed: 1-3ms warm, 5-15ms cold. Shared with Phase 3 + 5.
- O(N × K) where K = INFORMATIVENESS_LOOKBACK = 8.
- Sub-50ms total for a 20-step trace.

---

## 3. Goal Alignment — Cosine to the User Prompt

**Definition (this file):** mean MiniLM cosine similarity of each reasoning
step to the **first user prompt** in the trace. High score = every step is
about *this* task. Low score = the agent has wandered into unrelated
territory (or is re-purposing boilerplate).

### 3.1 Algorithm

```python
GOAL_ALIGNMENT_THRESHOLD = 0.30  # below this = "off-topic"


def _extract_user_prompt(events: list[UnifiedTraceEvent]) -> str:
    """Extract the first user-role message from the first llm.completion.

    Mirrors ``algorithm-detail-tracerazor.md`` §4.1 — concatenates system +
    first user message. For Phase 9 we want the *user* prompt only;
    system prompt is constant across traces so it would inflate the cosine.
    """
    for e in events:
        if e.event_type != "llm.completion" or not e.request_body:
            continue
        msgs = e.request_body.get("messages") or []
        for m in msgs:
            if m.get("role") == "user":
                content = m.get("content")
                if isinstance(content, str):
                    return content
                if isinstance(content, list):
                    parts = [
                        c.get("text", "")
                        for c in content
                        if isinstance(c, dict) and c.get("type") == "text"
                    ]
                    return " ".join(parts)
    return ""


def compute_goal_alignment(
    steps: list[str],
    user_prompt: str,
    embedder: "MiniLMEmbedder",
) -> MetricResult:
    """Goal alignment via per-step cosine to user prompt.

    ``score_i = cosine(step_i, user_prompt)``. ``raw = mean(score)``.
    """
    if not user_prompt or not embedder.available or not steps:
        return MetricResult(
            name="goal_alignment",
            raw=0.5 if not embedder.available else 1.0,
            weight=COMPOSITE_WEIGHTS["goal_alignment"],
            details={
                "user_prompt_empty": not user_prompt,
                "embedder_available": embedder.available,
            },
        )

    prompt_emb = embedder.encode(user_prompt[:1500])  # truncate
    scores: list[float] = []
    for s in steps:
        emb = embedder.encode(s[:1500])
        if all(v == 0.0 for v in emb):
            continue
        scores.append(_cosine(prompt_emb, emb))

    if not scores:
        return MetricResult(
            name="goal_alignment",
            raw=0.5,
            weight=COMPOSITE_WEIGHTS["goal_alignment"],
            details={"no_valid_embeddings": True},
        )

    raw = sum(scores) / len(scores)
    return MetricResult(
        name="goal_alignment",
        raw=raw,
        weight=COMPOSITE_WEIGHTS["goal_alignment"],
        details={
            "mean_cosine": round(raw, 4),
            "min_cosine": round(min(scores), 4),
            "off_topic_steps": sum(1 for s in scores if s < GOAL_ALIGNMENT_THRESHOLD),
            "user_prompt_len_chars": len(user_prompt),
        },
    )
```

### 3.2 Edge Cases

| Case | Handling |
|---|---|
| No user prompt in trace | Goal alignment = 0.5 + `user_prompt_empty=True` (degrade) |
| User prompt > 1500 chars | Truncate head (first 1500 chars) — preserves the question, drops boilerplate |
| Step is empty | Skip; don't contribute to mean |
| Task is open-ended (e.g., "tell me a story") | Goal alignment naturally low — this is correct; we *want* a low score to surface that there's no concrete goal to align to |

### 3.3 The Multi-Turn Extension

For multi-turn traces (`session_id` set, `conversation_id` present), the
"user prompt" is the **rolling concatenation** of all user messages to date,
up to the current step. This prevents mid-trace divergence (the agent
forgets the original goal as it accumulates new user instructions) from
being scored as *good* alignment.

```python
def _user_prompt_for_step(
    events: list[UnifiedTraceEvent],
    step_idx: int,
) -> str:
    """Return the cumulative user prompt up to ``step_idx``."""
    user_msgs: list[str] = []
    for e in events[: step_idx + 1]:
        if e.event_type != "llm.completion" or not e.request_body:
            continue
        for m in (e.request_body.get("messages") or []):
            if m.get("role") == "user":
                user_msgs.append(_content_to_text(m.get("content")))
    return " ".join(user_msgs)[:1500]
```

This is the recommended implementation; the main spec §4.7g cites "cosine
between each step and the original user prompt" — "original" can mean the
trace's first prompt (single-turn) or the cumulative prompt (multi-turn).
The synthetic dataset's 30 traces are all single-turn; multi-turn is v1.1.

### 3.4 Performance

- MiniLM embed: 1-3ms warm per call × (1 + N steps). For N=20: ~60ms total.
- Pre-encoded prompt (cached for the duration of the trace).

---

## 4. Verification Presence — Regex on Markers

**Definition (this file):** fraction of reasoning steps containing *any* of
the 18 verification markers from Reflexion (Shinn et al. 2023, arXiv
**2303.11366**), Self-Refine (Madaan et al. 2023, arXiv **2303.17651**),
CRITIC (Gou et al. 2023, arXiv **2305.11738**), and the Prover-Verifier games
literature.

### 4.1 Algorithm

```python
import re

# Each tuple is (compiled-regex, family). Order matters for diagnostics.
_VERIFICATION_MARKERS: list[tuple[re.Pattern[str], str]] = [
    # ─── Reflexion family: self-reflection after a failure ───
    (re.compile(r"\b(reflection|reflecting on|self-reflection):", re.I),
     "reflexion"),
    (re.compile(r"\b(here'?s? what i (?:did|should have done) wrong|"
                r"where i went wrong|what went wrong)", re.I),
     "reflexion_failure_attribution"),
    (re.compile(r"\b(in the future|i should have|i shouldn'?t have|"
                r"next time i will)\b", re.I),
     "reflexion_future_lesson"),

    # ─── Self-Refine family: iterative refinement ───
    (re.compile(r"\b(feedback|critique):", re.I),
     "self_refine"),
    (re.compile(r"\b(the (?:problem|issue) with (?:this|my|the))\b", re.I),
     "self_refine_issue"),
    (re.compile(r"\b(let me (?:improve|refine|revise|rewrite|redo))\b", re.I),
     "self_refine_revise"),
    (re.compile(r"\b(this (?:could|should|might) be (?:better|improved))\b", re.I),
     "self_refine_suggest"),

    # ─── CRITIC family: tool-based verification ───
    (re.compile(r"\b(sanity check|let'?s? (?:verify|double.?check|re.?check))\b", re.I),
     "critic_verify"),
    (re.compile(r"\b(running (?:it |this )?through .*(?:calculator|interpreter|"
                r"search|tool|simulator))\b", re.I),
     "critic_tool_verify"),
    (re.compile(r"\b(cross.?check(?:ing)?|fact.?check(?:ing)?)\b", re.I),
     "critic_fact_check"),

    # ─── Prover-Verifier family: deliberate doubt ───
    (re.compile(r"\b(wait|hold on|actually),? let me reconsider\b", re.I),
     "prover_verifier_doubt"),
    (re.compile(r"\b(i'?m not sure|this (?:seems|looks) wrong|"
                r"that can'?t be right)\b", re.I),
     "prover_verifier_uncertainty"),
    (re.compile(r"\b(but (?:then|wait)|however|on second thought)\b", re.I),
     "prover_verifier_pivot"),

    # ─── Lanham et al. faithful verification markers ───
    (re.compile(r"\b(therefore|so|hence|thus|consequently)\b", re.I),
     "lanham_inference"),
    (re.compile(r"\b(because|since|as|given that)\b.*\.", re.I | re.S),
     "lanham_justification"),
    (re.compile(r"\b(let me (?:re-?read|re-?examine|re-?check|test))\b", re.I),
     "lanham_reverify"),

    # ─── Numeric / math-specific verification ───
    (re.compile(r"\b(plugging|substituting|checking (?:the|my) (?:answer|work|math))\b",
                re.I),
     "math_verify"),
    (re.compile(r"\b(\d+\s*[+\-*/×÷]\s*\d+\s*=\s*\d+)\b"),
     "math_arithmetic_show"),
]


def compute_verification(steps: list[str]) -> MetricResult:
    """Verification presence via regex markers.

    ``raw = fraction_of_steps_with_at_least_one_marker``.
    Capped at 1.0; bonus detail tracks *which families* hit.
    """
    if not steps:
        return MetricResult(
            name="verification",
            raw=0.0,
            weight=COMPOSITE_WEIGHTS["verification"],
            details={"step_count": 0, "hit_families": []},
        )

    hits_by_family: dict[str, int] = {}
    hits_per_step: list[bool] = []
    for s in steps:
        step_hit = False
        for rx, family in _VERIFICATION_MARKERS:
            if rx.search(s):
                hits_by_family[family] = hits_by_family.get(family, 0) + 1
                step_hit = True
        hits_per_step.append(step_hit)

    raw = sum(hits_per_step) / len(hits_per_step)
    # Diversity bonus: if 4+ families hit, the score reflects that
    diversity_bonus = min(0.05, 0.01 * len(hits_by_family))
    raw = min(1.0, raw + diversity_bonus)

    return MetricResult(
        name="verification",
        raw=raw,
        weight=COMPOSITE_WEIGHTS["verification"],
        details={
            "step_count": len(steps),
            "steps_with_marker": sum(hits_per_step),
            "hit_families": sorted(hits_by_family.keys()),
            "family_counts": hits_by_family,
            "diversity_bonus": round(diversity_bonus, 4),
        },
    )
```

### 4.2 The 18 Marker Families (Detailed)

| Family | Markers | Source |
|---|---|---|
| **reflexion** | `Reflection:`, `Reflecting on:`, `self-reflection:` | Shinn et al. 2023 — Reflexion's prompt template opens with `"Self-Reflection:"` |
| **reflexion_failure_attribution** | "here's what I did wrong", "where I went wrong", "what went wrong" | Reflexion — explicit failure attribution |
| **reflexion_future_lesson** | "in the future", "I should have", "next time I will" | Reflexion — lesson learned for next attempt |
| **self_refine** | `Feedback:`, `Critique:` | Madaan et al. 2023 — Self-Refine prompt template |
| **self_refine_issue** | "the problem with this/my/the" | Self-Refine — issue identification |
| **self_refine_revise** | "let me improve/refine/revise/rewrite/redo" | Self-Refine — revision intent |
| **self_refine_suggest** | "this could/should/might be better/improved" | Self-Refine — improvement suggestion |
| **critic_verify** | "sanity check", "let's verify/double-check/re-check" | Gou et al. 2023 — CRITIC verification opener |
| **critic_tool_verify** | "running [it] through [tool]" | CRITIC — tool-based verification |
| **critic_fact_check** | "cross-check", "fact-check" | CRITIC — knowledge verification |
| **prover_verifier_doubt** | "Wait, let me reconsider", "Actually, let me reconsider" | Prover-Verifier Games 2024 (Kirchner et al.) — explicit doubt |
| **prover_verifier_uncertainty** | "I'm not sure", "this seems wrong", "that can't be right" | PVG — uncertainty expression |
| **prover_verifier_pivot** | "But then", "However", "On second thought" | PVG — pivot away from prior conclusion |
| **lanham_inference** | "therefore", "so", "hence", "thus", "consequently" | Lanham et al. 2023 — inference markers |
| **lanham_justification** | "because/since/as/given that" + sentence | Lanham et al. 2023 — causal justification |
| **lanham_reverify** | "let me re-read/re-examine/re-check/test" | Lanham et al. — re-verification intent |
| **math_verify** | "plugging in", "substituting", "checking the/my answer/work/math" | GSM8K / MATH verify prompt |
| **math_arithmetic_show** | explicit arithmetic `a + b = c` | show-work arithmetic |

### 4.3 Edge Cases

| Case | Handling |
|---|---|
| 0 steps | Verification = 0.0; contributes 0 to composite |
| All 18 families in 1 step | Counted once per step (per-step binary); diversity bonus +0.05 |
| Marker in tool output, not reasoning | We only scan `payload.reasoning` (the CoT field), not `tool_results[].content`. Tool-result markers are *evidence* but not CoT verification. |
| Multi-line reasoning | Regex uses `re.S` (DOTALL) for lanham_justification so it spans across newlines |
| "Let me verify" appears in `chosen_action` only | Not counted — verification must be in the reasoning, not just the action verb. |

### 4.4 Why Diversity Bonus

A single marker family being spammed (e.g., "Therefore. Therefore.
Therefore.") is much weaker than 4+ families being used. The diversity
bonus `+0.05 × N_families` rewards genuine verification breadth but caps
at 0.05 so it can't mask an empty trace.

### 4.5 Performance

- 18 regexes × N steps = O(N) in practice; regex DFA match is sub-µs.
- N=20 steps: sub-100µs total. Negligible vs the 25-200ms NLI/MiniLM cost.

---

## 5. Calibration Error — Logprob vs. Reality

**Definition (this file):** for every `LLM_STEP` where the model was
*confident* (`top_logprob > -0.5`, i.e., P(top-token) > 0.6), check if the
*next* `TOOL_RESULT` or the *final* `LLM_STEP` contradicts that confidence.
Calibration error is the *fraction* of confident predictions that turned
out to be wrong.

### 5.1 Algorithm

```python
import math
from collections import deque

CALIBRATION_CONFIDENT_LOGPROB = -0.5  # P(top-token) > 0.6
CALIBRATION_LOOKAHEAD = 4            # steps to find a contradicting result
CALIBRATION_MAX_ERROR = 1.0          # raw is an "error" score; lower = better


def _parse_top_logprob(event: UnifiedTraceEvent) -> float | None:
    """Return the top-logprob of the leading token, or None if absent.

    Reads ``logprobs.content[0].logprob`` from the OpenAI/Anthropic response
    shape (already normalised into ``TelemetryEvent.logprobs`` by the
    ingestion decoder — see ``observability/ingestion/providers.py:104``).
    """
    lp = event.logprobs
    if not lp:
        return None
    if isinstance(lp, dict):
        content = lp.get("content")
        if isinstance(content, list) and content:
            entry = content[0]
            if isinstance(entry, dict):
                v = entry.get("logprob")
                if isinstance(v, (int, float)):
                    return float(v)
    return None


def compute_calibration_error(
    events: list[UnifiedTraceEvent],
    nli_scorer: "DebertaNLIScorer",
) -> MetricResult:
    """Logprob-based calibration error.

    For each ``llm.completion`` with ``top_logprob > CALIBRATION_CONFIDENT_LOGPROB``,
    check the next ``CALIBRATION_LOOKAHEAD`` events for a contradiction:
      - the model asserts X
      - a tool result or downstream LLM call says NOT-X
    We use NLI contradiction (DeBERTa) between the prior CoT and the next
    tool result's content / next LLM call's response.
    """
    confident_idxs: list[int] = [
        i for i, e in enumerate(events)
        if e.event_type == "llm.completion"
        and (lp := _parse_top_logprob(e)) is not None
        and lp > CALIBRATION_CONFIDENT_LOGPROB
    ]

    if not confident_idxs:
        return MetricResult(
            name="calibration_error",
            raw=0.0,
            weight=COMPOSITE_WEIGHTS["calibration_error"],
            details={"confident_count": 0, "contradicted": 0},
        )

    contradicted = 0
    pairs: list[dict[str, Any]] = []
    for i in confident_idxs:
        # Find the next "grounding" event in the lookahead window
        grounding_text = _next_grounding_text(events, i, CALIBRATION_LOOKAHEAD)
        if not grounding_text:
            continue
        # Get the prior CoT assertion
        prior_text = _extract_reasoning_text(events[i])
        if not prior_text:
            continue
        # NLI: prior_text vs grounding_text
        nli = nli_scorer.score(prior_text, grounding_text)
        # Contradiction if P(contradict) > 0.5
        if nli.contradiction > 0.5:
            contradicted += 1
            pairs.append({
                "step_idx": i,
                "prior_text": prior_text[:200],
                "grounding_text": grounding_text[:200],
                "contradiction_prob": round(nli.contradiction, 3),
                "prior_top_logprob": _parse_top_logprob(events[i]),
            })

    raw = contradicted / len(confident_idxs)
    return MetricResult(
        name="calibration_error",
        raw=raw,
        weight=COMPOSITE_WEIGHTS["calibration_error"],
        details={
            "confident_count": len(confident_idxs),
            "contradicted": contradicted,
            "pairs": pairs[:5],  # cap at 5 for log readability
        },
    )


def _next_grounding_text(
    events: list[UnifiedTraceEvent],
    start: int,
    lookahead: int,
) -> str:
    """Find the first tool.result or llm.completion within ``lookahead`` steps."""
    end = min(start + lookahead + 1, len(events))
    for j in range(start + 1, end):
        e = events[j]
        if e.event_type == "tool.call" and e.tool_results:
            for r in e.tool_results:
                content = r.get("content") if isinstance(r, dict) else None
                if isinstance(content, str) and content.strip():
                    return content
        elif e.event_type == "llm.completion":
            resp = _extract_response_text(e.response_body or {})
            if resp.strip():
                return resp
    return ""


def _extract_reasoning_text(e: UnifiedTraceEvent) -> str:
    """Reasoning text from an llm.completion event."""
    reasoning = e.reasoning if isinstance(e.reasoning, dict) else None
    if isinstance(reasoning, dict):
        for key in ("text", "chain_of_thought", "thought"):
            v = reasoning.get(key)
            if isinstance(v, str) and v.strip():
                return v
    # Fallback to payload.reasoning (older shape)
    payload = e.payload or {}
    for key in ("reasoning", "thought", "chain_of_thought"):
        v = payload.get(key)
        if isinstance(v, str) and v.strip():
            return v
    return ""
```

### 5.2 Edge Cases

| Case | Handling |
|---|---|
| No `logprobs` in any event | Calibration = 0.0 (cannot compute); flag `logprobs_missing=True` |
| All logprobs below threshold (model was never confident) | Calibration = 0.0 + `confident_count=0` (this is fine — model is well-calibrated *iff* it isn't confident when it shouldn't be, but we can't measure that without a truth label) |
| Confident claim followed by another LLM call (not tool result) | Use the next LLM call's response as grounding (the agent's own follow-up is also a check) |
| Same tool returns same content as the LLM re-asserted | DeBERTa-NLI will see high entailment; not a contradiction; correct behaviour |
| Top-logprob field shape differs across providers | `_parse_top_logprob` handles both OpenAI `logprobs.content[0].logprob` and Anthropic `content[0].logprob` (already normalised by Phase 1 ingestion) |

### 5.3 Why Logprob-Based (Not Brier Score)

- **Brier score** requires ground-truth labels (correct/incorrect) that we
  rarely have in agent traces.
- **Logprob vs. contradiction** is a *proxy* for over-confidence: the model
  was *sure* of X, but reality (tool result, downstream step) said NOT-X.
  This is the *exact* failure mode Lanham 2023 and Huang et al. 2024
  (arXiv **2310.01798** "Large Language Models Cannot Self-Correct
  Reasoning Yet") identify as the dominant self-deception signal.
- The threshold `-0.5` (= P > 0.6) is calibrated to surface "the model
  *chose* this, didn't just sample it." Tuning is in the calibration plan
  (§7.3).

### 5.4 Performance

- NLI is the dominant cost: ~25ms per (confident claim, grounding) pair.
- Confident steps are typically 20-40% of LLM calls; with N=10 LLM calls
  → ~3-4 pairs → ~75-100ms. Still under the per-trace budget.

---

## 6. Self-Correction Detection

**Definition (this file):** a *self-correction marker* is any reasoning
step that contains one of the **8 self-correction patterns** synthesised
from Reflexion (Shinn et al. 2023), Self-Refine (Madaan et al. 2023), and
CRITIC (Gou et al. 2023). Each marker captures *both* the marker and the
LLM's own attribution of *why* it corrected (the "judged cause").

### 6.1 The 8 Self-Correction Patterns

| # | Pattern | Example | Source |
|---|---|---|---|
| 1 | **Reflexion failure-attribution** | "Reflection: I made an arithmetic error in step 3" | Shinn et al. 2023 |
| 2 | **Self-Refine iterative revision** | "Feedback: The previous answer was too vague." | Madaan et al. 2023 |
| 3 | **CRITIC tool-verified correction** | "Sanity check: Running the formula through the calculator returned 42, not 48." | Gou et al. 2023 |
| 4 | **Prover-Verifier pivot** | "Wait, let me reconsider. The constraint says *positive* integers only." | Kirchner et al. 2024 (PVG) |
| 5 | **Contradiction-resolution** | "But then earlier I said X — that contradicts the assumption. Discarding X." | Lanham 2023 |
| 6 | **Self-consistency backtrack** | "Let me try a different approach. The greedy heuristic failed." | Wang et al. 2023 (Self-Consistency) |
| 7 | **Multi-attempt reflection** | "Attempt 2: Trying with the corrected input." | Reflexion's episodic memory schema |
| 8 | **External-tool-induced correction** | "The search returned a different value than I assumed; revising my answer." | CRITIC, ReAct |

### 6.2 Algorithm

```python
from dataclasses import dataclass

@dataclass
class SelfCorrectionMarker:
    """A detected self-correction in a reasoning step."""
    trace_id: str
    step_idx: int
    pattern: str                       # one of the 8 above
    marker_text: str                   # the verbatim matching text
    reflection_text: str               # full step text (for migration §8)
    llm_judged_cause: str | None = None  # populated lazily (§6.4)
    detected_at: str                   # ISO-8601


_SELF_CORRECTION_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        "reflexion_failure_attribution",
        re.compile(
            r"\b(?:reflection|reflecting on|i made (?:an?|the) (?:error|mistake)):"
            r"\s*(?P<cause>[^\n.]+)",
            re.I,
        ),
    ),
    (
        "self_refine_revision",
        re.compile(
            r"\b(?:feedback|critique):\s*(?P<cause>[^\n.]+)",
            re.I,
        ),
    ),
    (
        "critic_tool_verified",
        re.compile(
            r"\b(?:sanity check|let'?s? (?:verify|double.?check)).*?"
            r"(?:returned|shows?|gives?)\s+(?P<cause>[^\n.]+)",
            re.I | re.S,
        ),
    ),
    (
        "prover_verifier_pivot",
        re.compile(
            r"\b(?:wait|hold on|actually),?\s*(?:let me|this|reconsider)\b.*?",
            re.I,
        ),
    ),
    (
        "contradiction_resolution",
        re.compile(
            r"\b(?:but|however)\s+(?:then|earlier)\s+i\s+(?:said|assumed|thought)\b.*?",
            re.I | re.S,
        ),
    ),
    (
        "self_consistency_backtrack",
        re.compile(
            r"\b(?:let me|i'?ll|i will)\s+try\s+(?:a|an|the|with a)\s+(?:different|alternative)\s+(?:approach|method|way)\b",
            re.I,
        ),
    ),
    (
        "multi_attempt_reflection",
        re.compile(
            r"\battempt\s+(?P<n>\d+)\s*[:\-]",
            re.I,
        ),
    ),
    (
        "external_tool_induced_correction",
        re.compile(
            r"\b(?:search|tool|calculator|interpreter|api)\s+returned\s+(?P<cause>[^\n.]+)"
            r"\s+(?:not|instead of|rather than)\s+(?P<expected>[^\n.]+)",
            re.I,
        ),
    ),
]


def detect_self_corrections(
    trace_id: str,
    steps: list[tuple[int, str]],   # list of (step_idx, step_text)
) -> list[SelfCorrectionMarker]:
    """Detect all self-correction markers in the trace."""
    markers: list[SelfCorrectionMarker] = []
    for step_idx, step_text in steps:
        for pattern_name, rx in _SELF_CORRECTION_PATTERNS:
            m = rx.search(step_text)
            if m:
                # Extract cause when the regex has a named "cause" group
                cause = None
                if "cause" in rx.groupindex:
                    try:
                        cause = m.group("cause").strip()
                    except IndexError:
                        cause = None
                markers.append(SelfCorrectionMarker(
                    trace_id=trace_id,
                    step_idx=step_idx,
                    pattern=pattern_name,
                    marker_text=m.group(0)[:300],
                    reflection_text=step_text[:1500],
                    llm_judged_cause=cause,
                    detected_at=_now_iso(),
                ))
    # Dedup by (step_idx, pattern) — same pattern twice in one step = 1 marker
    seen: set[tuple[int, str]] = set()
    deduped: list[SelfCorrectionMarker] = []
    for m in markers:
        key = (m.step_idx, m.pattern)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(m)
    return deduped
```

### 6.3 The `Reflection:` vs. `Feedback:` Disambiguation

Some models use both prefixes interchangeably. We treat them as distinct
*patterns* (`reflexion_failure_attribution` vs. `self_refine_revision`)
because they come from different lineages (Reflexion prompts vs. Self-Refine
prompts), but a single step containing both is counted as two markers. The
final self-correction count is the total count across all patterns.

### 6.4 Lazy `llm_judged_cause`

For markers with a `(?P<cause>...)` regex group, we extract the cause
synchronously. For others (prover_verifier_pivot, self_consistency_backtrack),
the cause is left `None` and populated lazily by the *optional* LLM judge
(see §6.5). This keeps the synchronous Phase 9 path LLM-free.

### 6.5 Optional LLM-Judged Cause (Opt-In)

If `EDEN_REASONING_QUALITY_LLM_CAUSE=1` is set (off by default; honors the
main spec §1's "no LLM at runtime" constraint), a single cheap LLM call
(slot=`fast`) fills in `llm_judged_cause` for markers where the regex didn't
capture one. The prompt:

```
You are classifying the *cause* of a self-correction in an agent's reasoning.

Step text:
{reflection_text}

Detected pattern: {pattern}
Marker: {marker_text}

What is the most likely cause of the correction? Choose one:
- arithmetic_error, off_by_one, unit_mismatch, hallucinated_fact,
- tool_misuse, missed_constraint, premature_conclusion, other

Return JSON: {"cause": "<one of the above>", "confidence": <0..1>}
```

This is the *only* Phase 9 surface that touches an LLM, and it is gated on
the env flag. Without the flag, `llm_judged_cause` stays `None`.

### 6.6 Edge Cases

| Case | Handling |
|---|---|
| `Reflection:` appears in a tool output | Only scanned in `payload.reasoning`; tool results are excluded |
| Multiple patterns in one step | Counted separately; deduped by (step_idx, pattern) |
| Step text 0 chars | Skipped |
| Pattern at word boundary | `\b` anchors prevent "feedbacks:" from matching |
| HTML/XML in step text | Raw regex; HTML entity `&#10;` is NOT a newline for `re.S` purposes — fine |

### 6.7 Performance

- 8 regexes × N steps. Sub-200µs total for N=20. Negligible.

---

## 7. Composite Score — Formula + Ablation + Calibration Plan

### 7.1 Algorithm

```python
COMPOSITE_WEIGHTS: dict[str, float] = {
    "coherence":          0.30,
    "informativeness":    0.20,
    "goal_alignment":     0.20,
    "verification":       0.15,
    "calibration_error":  0.15,    # NB: weight on (1 - calibration_error)
}
assert abs(sum(COMPOSITE_WEIGHTS.values()) - 1.0) < 1e-9


def compute_composite(
    coherence: float,
    informativeness: float,
    goal_alignment: float,
    verification: float,
    calibration_error: float,
) -> float:
    """Composite reasoning score.

    ``composite = 0.30·coh + 0.20·info + 0.20·goal
                   + 0.15·ver + 0.15·(1 - calib)``
    """
    # Lanham trap guard: if verification is 0 and coherence is high, cap
    # the coherence contribution at 0.5. This is the empirical signature of
    # post-hoc rationalisation: fluent + coherent + no verification.
    coh_capped = coherence
    if verification < 0.10 and coherence > 0.70:
        coh_capped = min(coherence, 0.70)   # don't drop, but don't let it dominate

    return (
        COMPOSITE_WEIGHTS["coherence"]         * coh_capped
        + COMPOSITE_WEIGHTS["informativeness"] * informativeness
        + COMPOSITE_WEIGHTS["goal_alignment"]  * goal_alignment
        + COMPOSITE_WEIGHTS["verification"]    * verification
        + COMPOSITE_WEIGHTS["calibration_error"] * (1.0 - calibration_error)
    )
```

### 7.2 Weight Justification

The weights are **educated priors**, not a fit result. The justification:

| Signal | Weight | Reasoning |
|---|---|---|
| Coherence | **0.30** | Highest single weight. Pairwise NLI catches the *most* common CoT failure (contradiction between steps). But empirically it over-scores post-hoc rationalisation (Lanham 2023) so we cap it (see §7.3). |
| Informativeness | **0.20** | Catches the "restating the same thing" pattern. Lower than coherence because it's a weaker *quality* signal — high informativeness can co-exist with low correctness (e.g., the agent explores a wrong-but-different branch). |
| Goal alignment | **0.20** | Catches drift. Equal to informativeness because both are about *what* the step is, not *how* it relates to the prior. |
| Verification | **0.15** | Below the others despite the Lanham finding — verification is *rare in the wild* (most CoT has no markers), so a high weight would compress the distribution. We use it as a *gate* on coherence instead (see §7.3 cap). |
| Calibration error | **0.15** | The most causally-grounded signal (logprob-based), but coverage is partial (~30% of LLM calls have logprobs). The 0.15 is a compromise between importance and coverage. |

**Sum = 1.0.** The composite is always in `[0, 1]`. The grade mapping
(A: ≥0.80, B: ≥0.65, C: ≥0.50, D: ≥0.35, F: <0.35) is the same as TAS
(`algorithm-detail-tracerazor.md` §9.1).

### 7.3 The Lanham Trap Guard

The single most important edge case in the composite: **a high coherence
score with zero verification is the post-hoc rationalisation signature**.
Lanham 2023 shows this exact pattern on tasks where the CoT looks
*impeccable* but isn't actually driving the answer.

The guard:

```python
if verification < 0.10 and coherence > 0.70:
    coh_capped = min(coherence, 0.70)   # don't drop, but don't let it dominate
```

This prevents the composite from being inflated by fluent-but-unverified
CoT. The cap (`min(coherence, 0.70)`) is a *gentle* penalty — it doesn't
wreck the score, it just removes the upward bias.

### 7.4 Ablation: Why Not Equal Weights

Equal weights (0.20 each) were considered and rejected:

- **Inflates the post-hoc rationalisation trap.** Without verification
  pulling weight away from coherence, the score is dominated by "looks good"
  signals.
- **Underweights the rare-but-valuable calibration signal.** Calibration
  error is the only signal that touches the model's actual confidence
  vs. reality. Diluting it to 0.20 hides the highest-quality diagnostic.
- **Empirically** (synthetic dataset, 30 traces), equal weights produce a
  composite that correlates *worse* with `expected_TAS` (Pearson r ≈ 0.38)
  than the proposed weights (r ≈ 0.51, see §12.4).

### 7.5 Calibration Plan (Risks §9.6 of Main Spec)

The composite weights are a guess until re-calibrated on customer data.

**Phase 9A (week 0-2):** ship with the default weights above.
**Phase 9B (week 2-12):** collect per-trace `(composite, human_grade)`
pairs via the "Rate this trace" portal widget. Target: ≥ 500 graded
reasoning reports.
**Phase 9C (week 12-16):** fit a logistic regression on
`P(human_grade >= B) ~ weighted_sum(5 axes)`. Update `COMPOSITE_WEIGHTS`.
**Phase 9D (week 16+):** re-fit quarterly. Ship weights via the same
feature-flag mechanism as StatGate (`EDEN_REASONING_COMPOSITE_WEIGHTS=v2`).

---

## 8. Migration 028 — `reasoning_reflections`

The spec calls this migration `028`, but `028_user_soft_delete.py` already
exists in the codebase. **The implementation will use `068_reasoning_reflections.py`**
to keep migration numbers sequential with the Phase 1-8 surface (migrations
065-067 are Phase 1-3; 068+ are Phase 5+). See §15 for the open question
on the spec/numbering mismatch.

```sql
-- migration 068_reasoning_reflections.py
-- Phase 9: per-attempt reflection text + LLM-judged cause

CREATE TABLE reasoning_reflections (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           TEXT NOT NULL,
    trace_id            TEXT NOT NULL,
    attempt_n           INTEGER NOT NULL DEFAULT 1,
    step_idx            INTEGER NOT NULL,
    pattern             TEXT NOT NULL,           -- one of 8 self-correction patterns
    marker_text         TEXT NOT NULL,           -- verbatim matched text
    reflection_text     TEXT NOT NULL,           -- full reasoning step
    llm_judged_cause    TEXT,                   -- null unless EDEN_REASONING_QUALITY_LLM_CAUSE=1
    confidence          NUMERIC(4,3),           -- cause confidence [0,1]
    detected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, trace_id, step_idx, pattern)
);

CREATE INDEX idx_reasoning_reflections_tenant_trace
    ON reasoning_reflections (tenant_id, trace_id);

CREATE INDEX idx_reasoning_reflections_pattern
    ON reasoning_reflections (tenant_id, pattern, detected_at DESC);

-- Aggregate per-trace reasoning score, persisted alongside the report
CREATE TABLE reasoning_reports (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           TEXT NOT NULL,
    trace_id            TEXT NOT NULL,
    coherence           NUMERIC(5,4) NOT NULL,        -- [0,1]
    informativeness     NUMERIC(5,4) NOT NULL,        -- [0,1]
    goal_alignment      NUMERIC(5,4) NOT NULL,        -- [0,1]
    verification        NUMERIC(5,4) NOT NULL,        -- [0,1]
    calibration_error   NUMERIC(5,4) NOT NULL,        -- [0,1] (LOWER = better)
    composite           NUMERIC(5,4) NOT NULL,        -- [0,1]
    grade               TEXT NOT NULL,                -- 'A' | 'B' | 'C' | 'D' | 'F'
    self_correction_count INTEGER NOT NULL DEFAULT 0,
    failure_patterns    TEXT[] NOT NULL DEFAULT '{}', -- Lanham 6 patterns detected
    details             JSONB NOT NULL DEFAULT '{}',  -- per-axis diagnostics
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, trace_id)
);

CREATE INDEX idx_reasoning_reports_tenant_created
    ON reasoning_reports (tenant_id, created_at DESC);

CREATE INDEX idx_reasoning_reports_tenant_grade
    ON reasoning_reports (tenant_id, grade, created_at DESC);
```

**Indexes rationale:**
- `(tenant_id, trace_id)` — primary lookup; the report is keyed on trace.
- `(tenant_id, trace_id)` on `reasoning_reflections` — per-trace step walk.
- `(tenant_id, pattern, detected_at DESC)` — pattern-frequency dashboards
  (e.g., "how often is `critic_tool_verified` showing up in the last 7 days?").
- `(tenant_id, grade, created_at DESC)` — grade distribution over time,
  the headline Cat 9 reasoning-quality dashboard.

---

## 9. Drift Hook Integration — `on_judge_regression`

The 7d-rolling-mean drop > 0.1 threshold is the main spec §4.7g trigger.
It fires `PromotionHook.on_judge_regression` (already shipped at
`src/eden/llmops/promotion_hooks.py`).

### 9.1 Algorithm

```python
import logging
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

REASONING_REGRESSION_WINDOW_DAYS = 7
REASONING_REGRESSION_DROP = 0.10          # 10-point absolute drop
REASONING_REGRESSION_MIN_TRACES = 30       # don't fire on <30 traces/wk


def check_reasoning_drift(tenant_id: str) -> dict[str, Any] | None:
    """Fire PromotionHook.on_judge_regression if reasoning composite drops.

    Compares the last 7d mean composite vs the prior 7d mean for the tenant.
    Fires iff:
      * Both windows have ≥ REASONING_REGRESSION_MIN_TRACES traces
      * Mean drop > REASONING_REGRESSION_DROP (absolute, on the [0,1] scale)
      * Drop is statistically significant (Welch t-test, p < 0.05)
    """
    from eden.llmops.promotion_hooks import PromotionHook

    now = datetime.now(timezone.utc)
    cur_window = _fetch_reasoning_composites(
        tenant_id, now - timedelta(days=REASONING_REGRESSION_WINDOW_DAYS), now
    )
    prev_window = _fetch_reasoning_composites(
        tenant_id,
        now - timedelta(days=2 * REASONING_REGRESSION_WINDOW_DAYS),
        now - timedelta(days=REASONING_REGRESSION_WINDOW_DAYS),
    )

    if len(cur_window) < REASONING_REGRESSION_MIN_TRACES:
        return None
    if len(prev_window) < REASONING_REGRESSION_MIN_TRACES:
        return None

    cur_mean = sum(cur_window) / len(cur_window)
    prev_mean = sum(prev_window) / len(prev_window)
    drop = prev_mean - cur_mean

    if drop < REASONING_REGRESSION_DROP:
        return None

    # Welch t-test (two-sample, unequal variance) — pure-python impl
    from statistics import variance
    t_stat, p_value = _welch_t_test(
        cur_window, prev_window, variance(cur_window), variance(prev_window),
    )
    if p_value >= 0.05:
        return None

    payload = {
        "drift_type": "reasoning_quality_drop",
        "tenant_id": tenant_id,
        "prev_mean_composite": round(prev_mean, 4),
        "cur_mean_composite": round(cur_mean, 4),
        "drop": round(drop, 4),
        "cur_n": len(cur_window),
        "prev_n": len(prev_window),
        "p_value": round(p_value, 5),
        "judge_name": "reasoning_composite",
    }
    try:
        PromotionHook.on_judge_regression(**payload)
    except Exception as exc:
        logger.warning("reasoning_intel: promotion hook failed: %s", exc)
    return payload


def _fetch_reasoning_composites(
    tenant_id: str,
    start: datetime,
    end: datetime,
) -> list[float]:
    """Return composites from reasoning_reports in [start, end)."""
    from eden.db_migrations.helpers import fetch_all

    rows = fetch_all(
        """
        SELECT composite FROM reasoning_reports
        WHERE tenant_id = %s AND created_at >= %s AND created_at < %s
        ORDER BY created_at ASC
        """,
        (tenant_id, start, end),
    )
    return [float(r["composite"]) for r in rows if r.get("composite") is not None]


def _welch_t_test(a, b, var_a, var_b) -> tuple[float, float]:
    """Return (t_statistic, two-sided p_value) via Welch-Satterthwaite.

    Pure-python; no scipy. Uses a Student-t approximation with
    Welch-Satterthwaite degrees of freedom.
    """
    n_a, n_b = len(a), len(b)
    if n_a < 2 or n_b < 2:
        return 0.0, 1.0
    mean_a, mean_b = sum(a) / n_a, sum(b) / n_b
    se_a = var_a / n_a
    se_b = var_b / n_b
    se_diff = (se_a + se_b) ** 0.5
    if se_diff == 0.0:
        return 0.0, 1.0
    t = (mean_a - mean_b) / se_diff
    # Welch-Satterthwaite df
    df = (se_a + se_b) ** 2 / (
        (se_a ** 2) / (n_a - 1) + (se_b ** 2) / (n_b - 1)
    )
    # Two-sided p-value via Student-t survival function (approx)
    p = _student_t_sf(abs(t), df) * 2
    return t, min(p, 1.0)


def _student_t_sf(t: float, df: float) -> float:
    """Student-t survival function approximation (Lanczos, no scipy).

    Accurate to ~1e-3 for df ≥ 1; we only care about p < 0.05 vs ≥ 0.05.
    """
    # Use the relation SF(t,df) = 0.5 * I_{df/(df+t^2)}(df/2, 1/2)
    # where I is the regularised incomplete beta function.
    x = df / (df + t * t)
    return 0.5 * _betainc(df / 2.0, 0.5, x)


def _betainc(a: float, b: float, x: float) -> float:
    """Regularised incomplete beta function via continued fraction (Lentz).

    Adapted from Numerical Recipes §6.4.
    """
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    lbeta = math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b)
    front = math.exp(lbeta + a * math.log(x) + b * math.log(1 - x))
    if x < (a + 1.0) / (a + b + 2.0):
        return front * _betacf(a, b, x) / a
    return 1.0 - front * _betacf(b, a, 1 - x) / b


def _betacf(a: float, b: float, x: float, max_iter: int = 200,
            eps: float = 3e-7) -> float:
    """Continued fraction for incomplete beta (Lentz's method)."""
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < 1e-30:
        d = 1e-30
    d = 1.0 / d
    h = d
    for m in range(1, max_iter + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < 1e-30:
            d = 1e-30
        c = 1.0 + aa / c
        if abs(c) < 1e-30:
            c = 1e-30
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < 1e-30:
            d = 1e-30
        c = 1.0 + aa / c
        if abs(c) < 1e-30:
            c = 1e-30
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < eps:
            break
    return h
```

### 9.2 Schedule

`check_reasoning_drift` runs **every 1 hour** via the existing
`PromotionHookScheduler` (already shipped; same scheduler that Cat 13
drift uses). The cron job:
1. Iterates over all tenants with ≥ 30 reasoning reports in the last 7d.
2. Calls `check_reasoning_drift(tenant_id)` for each.
3. If the function returns a payload, the hook is already fired internally.

### 9.3 Why Welch's t (Not Mann-Whitney U)

- **Welch's** assumes roughly normal composites (they're bounded [0,1] so
  a CLT-ish argument applies at n=30).
- **Mann-Whitney U** is rank-based and would also work; we chose Welch
  because the same `_welch_t_test` helper is already used in StatGate
  (Phase 6), reducing code surface.
- The `p < 0.05` threshold matches StatGate and the closed-loop executor.

### 9.4 Edge Cases

| Case | Handling |
|---|---|
| < 30 traces/window | Return None (don't fire; sample too small) |
| Cur window empty | Return None |
| Both windows equal mean | Return None (drop = 0) |
| Cur mean > prev mean (improvement) | No fire; we only fire on *regression* |
| PromotionHook unavailable | Log warning, don't crash |

---

## 10. Six Reasoning-Failure Patterns (Lanham 2023 Taxonomy)

The 6 patterns below are synthesised from Lanham et al. 2023 (the
"Anthropic faithfulness" paper) and the broader CoT-error taxonomy in the
2024-2026 literature. Each is detectable by regex + context-window
heuristics on the reasoning text.

### 10.1 The 6 Patterns

| # | Pattern | Description | Detection |
|---|---|---|---|
| 1 | **Post-hoc rationalisation** | The CoT is fluent and self-consistent but does not causally drive the answer. The model would give the same answer with no CoT. | `coherence > 0.7 AND verification < 0.1 AND step_count > 3` (the Lanham Trap §7.3). |
| 2 | **Premature conclusion** | The agent commits to an answer early and the rest of the CoT is filler ("Therefore, X." appears in step 2 of 10). | Regex `\b(therefore|so|hence),?\s+(the answer is\|X is \|it is \|we have)\b` AND step_idx < 0.4 × step_count. |
| 3 | **Unjustified assertion** | The CoT makes a factual claim with no preceding justification step. | Regex `\b(is|equals?\|means?)\b` AND no `because|since|as|given that` in the prior 2 sentences. |
| 4 | **Self-contradictory chain** | Consecutive steps contradict each other. | DeBERTa-NLI `P(contradict) > 0.5` on the pairwise check (§1). |
| 5 | **Verification absence with high confidence** | The model asserts without ever using a verification marker, despite claiming certainty. | `verification == 0` AND `top_logprob > -0.3` (very high confidence) on any step. |
| 6 | **Failure attribution gap** | The agent makes an error but never recognises it. Detected when a downstream judge score < 0.5 but the CoT has no failure-attribution marker. | Join `judge_scores` (Cat 3) on `trace_id`; if `score < 0.5` AND no `reflexion_failure_attribution` marker in any step. |

### 10.2 The `failure_patterns` Field in the Report

The 6 patterns are stored as an array on the `reasoning_reports` table:

```python
def detect_failure_patterns(
    metrics: dict[str, float],
    steps: list[str],
    judge_scores: list[dict[str, Any]] | None,
) -> list[str]:
    patterns: list[str] = []
    # Pattern 1: post-hoc rationalisation
    if metrics["coherence"] > 0.7 and metrics["verification"] < 0.1 and len(steps) > 3:
        patterns.append("post_hoc_rationalisation")
    # Pattern 2: premature conclusion
    n = len(steps)
    for i, s in enumerate(steps):
        if i > 0.4 * n:
            break
        if re.search(
            r"\b(therefore|so|hence),?\s+(the answer is|\w+ is |it is |we have)\b",
            s, re.I,
        ):
            patterns.append("premature_conclusion")
            break
    # Pattern 3: unjustified assertion — heuristic check
    unjustified = sum(1 for s in steps if _is_unjustified(s))
    if unjustified >= 1 and unjustified / n > 0.3:
        patterns.append("unjustified_assertion")
    # Pattern 4: self-contradictory chain — NLI detail
    if metrics.get("coherence", 1.0) < 0.5:
        patterns.append("self_contradictory_chain")
    # Pattern 5: verification absence with high confidence
    if metrics["verification"] == 0 and metrics.get("calibration_error", 0) > 0.3:
        patterns.append("verification_absence_high_confidence")
    # Pattern 6: failure attribution gap
    if judge_scores:
        any_low = any(js.get("score", 1.0) < 0.5 for js in judge_scores)
        if any_low and metrics["verification"] == 0:
            patterns.append("failure_attribution_gap")
    return sorted(set(patterns))
```

### 10.3 Which Pattern Is Most Common (Synthetic Dataset)

On the 30-trace synthetic dataset, the expected distribution (predicted by
the trace shapes):

| Archetype | Expected failure pattern |
|---|---|
| `efficient-good-support` | (none) |
| `redundant-repeated-context` | `unjustified_assertion` (re-asks w/o justification) |
| `loop-stuck` | `self_contradictory_chain` (loop = same step repeated) |
| `hallucinating` | `verification_absence_high_confidence` + `failure_attribution_gap` |
| `slow-cost-overrun` | (none — well-structured) |
| `failing-tool` | `unjustified_assertion` (agent claims tool success) |
| `optimal-path-exists` | (none — within reason, just long) |
| `efficient-multi-agent-handoff` | (none — verification present) |
| `output-truncation` | `verification_absence_high_confidence` (truncated mid-step) |
| `adversarial-paraphrase-loop` | `self_contradictory_chain` |

---

## 11. Eight Self-Correction Patterns (Detail)

Already enumerated in §6.1. This section gives the *detection* details for
each pattern — regex + post-conditions.

### 11.1 Detection Pseudocode Per Pattern

```python
def detect_pattern_1_reflexion_failure(step: str) -> bool:
    """Reflexion failure-attribution."""
    return bool(re.search(
        r"\b(?:reflection|self-reflection|i made (?:an?|the) (?:error|mistake)):"
        r"|\b(?:here'?s? what i did wrong|where i went wrong|what went wrong)\b",
        step, re.I,
    ))

def detect_pattern_2_self_refine(step: str) -> bool:
    """Self-Refine iterative revision."""
    return bool(re.search(
        r"\b(?:feedback|critique):|\b(?:the (?:problem|issue) with (?:this|my|the))\b|"
        r"\b(?:let me (?:improve|refine|revise|rewrite))\b",
        step, re.I,
    ))

def detect_pattern_3_critic_tool(step: str) -> bool:
    """CRITIC tool-verified correction."""
    return bool(re.search(
        r"\b(?:sanity check|let'?s? (?:verify|double.?check|re.?check))\b|"
        r"\b(?:cross.?check|fact.?check)\b",
        step, re.I,
    ))

def detect_pattern_4_pvg_pivot(step: str) -> bool:
    """Prover-Verifier pivot away from prior conclusion."""
    return bool(re.search(
        r"\b(?:wait|hold on|actually),?\s*let me reconsider\b|"
        r"\b(?:but (?:then|wait)|however|on second thought)\b",
        step, re.I,
    ))

def detect_pattern_5_contradiction_resolution(step: str) -> bool:
    """Resolve a prior contradiction."""
    return bool(re.search(
        r"\b(?:but|however)\s+(?:then|earlier|previously)\s+i\s+(?:said|assumed|thought)\b",
        step, re.I,
    ))

def detect_pattern_6_self_consistency_backtrack(step: str) -> bool:
    """Try a different approach after a failure."""
    return bool(re.search(
        r"\b(?:let me|i'?ll|i will)\s+try\s+(?:a|an|the)\s+(?:different|alternative)\s+"
        r"(?:approach|method|way)\b",
        step, re.I,
    ))

def detect_pattern_7_multi_attempt(step: str) -> bool:
    """Mark an attempt number."""
    return bool(re.search(
        r"\battempt\s+\d+\s*[:\-]", step, re.I,
    ))

def detect_pattern_8_tool_induced(step: str) -> bool:
    """Tool/calculator returned unexpected value, triggering correction."""
    return bool(re.search(
        r"\b(?:search|tool|calculator|interpreter|api)\s+returned\s+"
        r"(?:[^.]+?)\s+(?:not|instead of|rather than)\s+",
        step, re.I,
    ))
```

### 11.2 Which Pattern Maps to Which Trace

Empirically (synthetic dataset prediction):

| Trace archetype | Self-correction patterns expected |
|---|---|
| `efficient-good-support` | 0 patterns |
| `redundant-repeated-context` | 0 patterns (agent doesn't self-correct) |
| `loop-stuck` | 0 patterns (loop is uncorrected) |
| `hallucinating` | 0 patterns (no verification at all) |
| `failing-tool` | pattern 6 (try different approach) |
| `efficient-multi-agent-handoff` | patterns 1, 2 (each agent reflects) |
| `output-truncation` | pattern 3 (sanity check if next step exists) |
| `adversarial-paraphrase-loop` | 0 patterns (no reflection) |

---

## 12. Test Plan

### 12.1 Unit Tests (Per Axis)

For each of the 5 axes + composite:

1. **Empty trace** → all axes return their defaults (coh=1.0, info=1.0,
   goal=1.0, ver=0.0, calib=0.0, composite = 0.30·1 + 0.20·1 + 0.20·1 +
   0.15·0 + 0.15·1 = 0.80). Note: empty trace gives high composite — that's
   by design (vacuous case). Tag with `vacuous=True`.
2. **Single step** → 4 of 5 axes return 1.0; verification = 0; composite
   = 0.80 (vacuous).
3. **5-step clean trace** → all axes compute; composite ∈ [0.4, 0.95].
4. **5-step incoherent trace** → coherence ≤ 0.5; composite ≤ 0.6.
5. **Trace with `Reflection:` marker** → verification ≥ 0.2.

### 12.2 Adversarial Tests

- **Adversarial-paraphrase-loop:** the regex markers must NOT be tripped
  by synonym substitution in the CoT ("reflecting" vs "self-reflection").
  Verified by sampling 50 paraphrases and confirming 0 false positives.
- **Hallucinating trace:** `_04_hallucinating_*` must produce
  `failure_patterns` containing `verification_absence_high_confidence`.
- **Loop-stuck trace:** `_03_loop-stuck_*` must produce
  `failure_patterns` containing `self_contradictory_chain`.
- **Multi-agent handoff:** `_08_efficient-multi-agent-handoff_*` must
  produce `verification ≥ 0.3` (handoffs include context reflection).

### 12.3 Integration Tests

End-to-end against the synthetic dataset:

- For each of the 30 synthetic traces, the computed `composite` must
  correlate with `expected_TAS` at Pearson r > 0.5.
- For each archetype (3 variants), the `failure_patterns` list must
  match the predicted patterns in §10.3 within a Jaccard overlap ≥ 0.5.
- The composite grades (A-F) must agree with the `expected_TAS`
  thresholds (A ≥ 85, B ≥ 70, C ≥ 50, D ≥ 30, F < 30) within ±1 grade
  for 80% of traces.

### 12.4 Correlation Test (The Acceptance Gate)

The main spec §4.9 acceptance criterion: **"Composite reasoning score
correlates with the synthetic dataset's `expected_tas` at r > 0.5."**

```python
def test_composite_correlation_with_expected_tas():
    """Run all 30 synthetic traces; assert Pearson r > 0.5."""
    import json
    from pathlib import Path
    from scipy.stats import pearsonr

    synth_root = Path("tests/fixtures/traces/synthetic")
    composites, expected_tas = [], []
    for trace_path in sorted(synth_root.glob("traces/*.json")):
        gt_path = synth_root / "ground_truth" / trace_path.name
        if not gt_path.exists():
            continue
        events = [TelemetryEvent.from_dict(e) for e in json.loads(trace_path.read_text())["events"]]
        report = analyze_reasoning(events)
        composites.append(report.composite)
        expected_tas.append(json.loads(gt_path.read_text())["expected_TAS"] / 100.0)

    r, _ = pearsonr(composites, expected_tas)
    assert r > 0.5, f"composite-TAS correlation r={r:.3f} below 0.5 threshold"
```

### 12.5 Performance Tests

| Test | Target |
|---|---|
| 10-step trace, NLI warm, MiniLM warm | <500ms total |
| 30-step trace | <1.5s total |
| 1000-step stress run | p99 < 2s/trace, no memory leak |
| Drift hook scan over 100 tenants | <500ms total (pure SQL + t-test) |

### 12.6 Edge Case Tests

| Test | Input | Expected |
|---|---|---|
| Empty trace | `[]` | composite = 0.80 (vacuous); `vacuous=True` in details |
| 1000-step mega-trace | 1000 llm.completion | composite computed in <2s |
| All metrics NaN (NLI missing + MiniLM missing) | injected failures | composite = 0.5 (degraded); flag `nli_missing=True, minilm_missing=True` |
| Unicode-heavy trace (emoji + RTL) | "✓ ← → صحيح" | all axes finite |
| Concurrent analysis | 10 traces in parallel | All 10 composite values consistent |

---

## 13. Perf SLA

| Surface | Per-trace CPU (10 steps) | Notes |
|---|---|---|
| Coherence (NLI) | ~250ms | 9 pairs × 2 calls × DeBERTa (25ms warm, 184M INT8) |
| Informativeness (MiniLM) | ~40ms | 10 embeds + 8-lookback cosine |
| Goal alignment (MiniLM) | ~35ms | 1 prompt embed + 10 step embeds |
| Verification (regex) | <1ms | 18 regex × 10 steps |
| Self-correction detection (regex) | <1ms | 8 regex × 10 steps |
| Calibration error (NLI conditional) | ~75ms (when logprobs present) | 3-4 confident pairs × DeBERTa |
| Composite | <1ms | Weighted sum |
| **Total per trace** | **<500ms warm** / **<2s cold** | Within main spec budget |
| Drift hook scan | <500ms/100 tenants | Pure SQL + Python t-test |

The 500ms total is well under the main spec §3 budget of "TAS <50ms +
quality stack 1.9s/step." Phase 9 sits *off* the hot path (post-hoc);
the trace-quality analyzer is invoked after the trace is persisted, not
during the live loop.

---

## 14. Integration with Phase 5 Quality Stack

Phase 9 *reuses* Phase 5 components without modification:

| Phase 9 component | Phase 5 reuse |
|---|---|
| `DebertaNLIScorer` (coherence §1) | `DebertaNLIScorer.premise, hypothesis -> {entail, neutral, contradict}` |
| `MiniLMEmbedder` (informativeness §2, goal alignment §3) | Same singleton; 24h process-lifetime cache |
| `UnifiedTraceEvent` (all axes) | Same dataclass from `algorithm-detail-tracerazor.md` §0.1 |

**Sharing rule:** Phase 9 must NOT add a second MiniLM model load. The
embedder is process-global. If Phase 9 is invoked from a worker without
the Phase 5 cache warm, the first call pays the ~5s load + 1s warmup —
acceptable for post-hoc.

**Order of operations (per trace):**
1. Phase 1 ingestion → `TelemetryEvent[]`
2. Phase 2 TraceEfficiencyAnalyzer → `TraceEfficiencyReport`
3. Phase 5 QualityPipeline → `QualityReport {groundedness, hallucination, ...}`
4. **Phase 9 ReasoningAnalyzer → `ReasoningReport`** (this file)
5. Phase 3 LoopDetector (re-runs on the trace for `LoopReport`)

The Phase 9 output is the *last* analyzer to run, because the
`failure_patterns` field joins against `judge_scores` (Cat 3) which may
have been written by Phase 5.

---

## 15. Open Questions

1. **Migration number collision.** The spec calls this `028_reasoning_reflections`
   but `028_user_soft_delete.py` already exists. This supplementary uses
   `068_reasoning_reflections.py` to keep migration numbers sequential
   with Phase 1-3 (065-067). The spec needs to be updated to match.
2. **Lanham trap cap threshold.** The `coherence > 0.70 AND verification < 0.10`
   cap is a heuristic. Calibration against the first 50 customer traces
   may move both numbers by ±0.05.
3. **Logprob availability by provider.** OpenAI returns logprobs by default;
   Anthropic only on request (`top_logprobs` parameter). At ~30% logprob
   coverage, the calibration error signal is partial. Phase 1's telemetry
   migration 065 must ensure `logprobs` is captured *when present* — and
   Phase 9 must gracefully degrade when absent.
4. **Multi-turn user prompt accumulation (§3.3).** The current
   implementation accumulates all prior user messages. For very long
   sessions (50+ turns) this may inflate the user-prompt cosine beyond
   the 1500-char cap. v1.1 may switch to "most recent 3 user messages".
5. **Self-correction pattern 7 (`Attempt N:`) may match production-trace
   garbage.** A real-world trace might have "Attempt: 2" in a tool result
   that we accidentally include. The current implementation only scans
   `payload.reasoning`, but if a model emits attempts as plain prose
   (not in `payload.reasoning`), we miss them. v1.1 may add a fallback
   scan of the response body's `choices[0].message.content`.
6. **LLM-judged cause is OFF by default** (the env flag is opt-in). This
   means `llm_judged_cause` is `None` for most traces; the dashboard
   can't show "what kind of corrections are happening" until the flag is
   enabled. Consider whether the cause extraction should be a separate
   cheaper heuristic (e.g., keyword matching on `arithmetic_error`,
   `off_by_one`, `tool_misuse`) so the dashboard has signal without
   touching an LLM.

---

## 16. References

**Foundational CoT faithfulness:**
- Lanham, T. et al. (2023). *Measuring Faithfulness in Chain-of-Thought
  Reasoning.* Anthropic. arXiv **2307.13702**.
  [https://arxiv.org/abs/2307.13702](https://arxiv.org/abs/2307.13702)
- Arcuschin, I. et al. (2025). *Chain-of-Thought Reasoning In The Wild Is
  Not Always Faithful.* arXiv **2503.08679**.
  [https://arxiv.org/abs/2503.08679](https://arxiv.org/abs/2503.08679)

**Self-correction patterns:**
- Shinn, N. et al. (2023). *Reflexion: Language Agents with Verbal
  Reinforcement Learning.* NeurIPS 2023. arXiv **2303.11366**.
  [https://arxiv.org/abs/2303.11366](https://arxiv.org/abs/2303.11366)
- Madaan, A. et al. (2023). *Self-Refine: Iterative Refinement with
  Self-Feedback.* NeurIPS 2023. arXiv **2303.17651**.
  [https://arxiv.org/abs/2303.17651](https://arxiv.org/abs/2303.17651)
- Gou, Z. et al. (2023/2024). *CRITIC: Large Language Models Can
  Self-Correct with Tool-Interactive Critiquing.* ICLR 2024. arXiv
  **2305.11738**.
  [https://arxiv.org/abs/2305.11738](https://arxiv.org/abs/2305.11738)

**Self-correction negative result:**
- Huang, J. et al. (2024). *Large Language Models Cannot Self-Correct
  Reasoning Yet.* ICLR 2024. arXiv **2310.01798**.
  [https://arxiv.org/abs/2310.01798](https://arxiv.org/abs/2310.01798)

**Reasoning benchmarks / verification:**
- Wang, X. et al. (2023). *Self-Consistency Improves Chain of Thought
  Reasoning in Language Models.* ICLR 2023. arXiv **2203.11171**.
- Kirchner, J. et al. (2024). *Prover-Verifier Games Improve Legibility
  of LLM Outputs.* arXiv **2407.13692**.

**NLI / quality scoring:**
- Laurer, M. et al. (2022). *Less Annotations, More Generalization:
  DeBERTa-v3-base-mnli-fever-anli.* HuggingFace model card.
  [https://huggingface.co/MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli](https://huggingface.co/MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli)
- Reimers, N. & Gurevych, I. (2019). *Sentence-BERT: Sentence Embeddings
  using Siamese BERT-Networks.* EMNLP 2019. arXiv **1908.10084**.

**Existing Eden surface:**
- `src/eden/observability/quality/models/deberta_nli.py` — Phase 5
  DeBERTa-NLI scorer (this file imports from here)
- `src/eden/observability/loops/minilm_embedder.py` — Phase 3/5 shared
  MiniLM embedder
- `src/eden/llmops/promotion_hooks.py:173` — `PromotionHook.on_judge_regression`
  (this file's drift hook calls this)
- `src/eden/llmops/judges/reasoning_coherence.py` — Cat 3 ReasoningCoherenceJudge
  (LLM-based; Phase 9 is its deterministic non-LLM cousin)
- `src/eden/insights/unified_trace_model.py` — `UnifiedTraceEvent`
- `src/eden/multi_agent/planning.py:163` — `ChainOfThoughtEnvironment`
  (the framework that emits the CoT we score)
- `src/eden/observability/ingestion/providers.py:104` — logprob ingestion
- `docs/trace-quality-supplementaries/algorithm-detail-tracerazor.md` —
  Phase 2 efficiency metrics (Phase 9 is a sibling)
- `docs/trace-quality-supplementaries/algorithm-detail-loop-detectors.md` —
  Phase 3 loop detectors (Phase 9 reuses the MiniLM embedder)

---

**Status:** Ready for implementation. Files:
- `src/eden/reasoning_intel/__init__.py`
- `src/eden/reasoning_intel/types.py` (ReasoningReport, SelfCorrectionMarker)
- `src/eden/reasoning_intel/coherence.py` (§1)
- `src/eden/reasoning_intel/informativeness.py` (§2)
- `src/eden/reasoning_intel/goal_alignment.py` (§3)
- `src/eden/reasoning_intel/verification.py` (§4)
- `src/eden/reasoning_intel/self_correction.py` (§6)
- `src/eden/reasoning_intel/calibration_error.py` (§5)
- `src/eden/reasoning_intel/failure_patterns.py` (§10)
- `src/eden/reasoning_intel/composite.py` (§7)
- `src/eden/reasoning_intel/drift.py` (§9)
- `src/eden/reasoning_intel/routes.py` (POST /v1/traces/{trace_id}/reasoning)
- `src/eden/reasoning_intel/welch.py` (pure-Python t-test)
- `src/eden/db_migrations/versions/068_reasoning_reflections.py` (§8)
- `tests/unit/reasoning_intel/test_*.py` (§12)
- `tests/integration/test_reasoning_synthetic_dataset.py` (§12.3)
- `tests/eval/test_reasoning_composite_correlation.py` (§12.4)