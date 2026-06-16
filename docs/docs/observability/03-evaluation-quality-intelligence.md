---
title: "03 — Evaluation Quality Intelligence (Cat 3)"
status: IMPLEMENTED v1
last_updated: 2026-06-11
version: 1.1
---

# 03 — Evaluation Quality Intelligence (Cat 3)

> **Status:** IMPLEMENTED v1 (2026-06-11). All 13 evaluation-quality
> services now have real implementations under
> `src/eden/evaluation/eval_intel/`. Services read from
> `judge_scores` (failure clusterer, eval-version regression
> detector, auto-dataset bridge) and from
> `eval_versions`/`eval_hil_tasks` (registry, HiL task lookup).
> CLHF + MultiModal + AutoDataset services use the existing
> `OpenRouterClient` for spec generation / scoring. The
> eval-to-guardrail lifecycle writes to both
> `eval_to_guardrail_links` and `guardrail_policies` and fires
> `GuardrailHook.on_judge_threshold_breach`. The eval-version
> regression detector fires
> `PromotionHook.on_judge_regression` when a new version's
> judge scores drop > 0.05 vs. the previous active version.
> All 14 Cat 3 tables (added in migration 020) are used;
> no migration changes needed.
>
> **The 7 new LLM-as-judge scorers** (`GroundednessJudge`,
> `RelevanceJudge`, `SafetyJudge`, `SatisfactionJudge`,
> `ActionCompletionJudge`, `ToolSelectionQualityJudge`,
> `ReasoningCoherenceJudge`) were already registered in
> `JudgeRegistry` via `register_intelligence_judges()` in
> `src/eden/llmops/judges/builtin_v9.py` before this ship —
> Cat 3 ships the 13 service classes that wrap them.
>
> **This was the largest appendix** because Cat 3 subsumes
> features from **Galileo** (CLHF, 3 agentic metrics,
> eval-to-guardrail), **LangSmith** (HiL+pairwise, multi-modal,
> Polly AI), **Arize** (6 modalities, dataset versioning),
> **Langfuse** (Boolean/Categorical, Custom Python, user
> feedback), and **Braintrust** (auto-dataset, Loop AI).

## Table of Contents

1. [Goal & motivation](#goal--motivation)
2. [Source articles](#source-articles)
3. [What's already in Eden](#whats-already-in-eden)
4. [The 6 canonical metrics + 3 Galileo metrics](#the-6-canonical-metrics--3-galileo-metrics)
5. [Feature inventory (20 features)](#feature-inventory-20-features)
6. [API contracts](#api-contracts)
7. [Data model (14 tables)](#data-model-14-tables)
8. [Algorithm / pseudo-code](#algorithm--pseudo-code)
9. [Failure modes & guardrails](#failure-modes--guardrails)
10. [Telemetry](#telemetry)
11. [Test plan](#test-plan)
12. [Acceptance criteria](#acceptance-criteria)
13. [Implementation order](#implementation-order)
14. [Open questions](#open-questions)
15. [Cross-references](#cross-references)

## Goal & motivation

Every LLM interaction is scored on **six canonical metrics**
(accuracy, groundedness, relevance, completeness, safety, satisfaction)
plus **three Galileo Luna-2 agentic metrics** (Action Completion,
Tool Selection Quality, Reasoning Coherence). Failures are
**clustered by signature**, **versioned by deployment SHA**, and
**promotable to production guardrails** via the eval-to-guardrail
lifecycle.

The user story is:

> "I just shipped a new prompt version. Before I roll it out to
> 100% of traffic, I want to know whether it improves the
> hallucination rate, whether it still answers the questions
> the previous version answered, and whether the action-
> completion score has dropped. If a judge has reliably
> flagged regressions, I want it to become a guardrail
> automatically."

This requires:

1. **Multi-judge scoring** — 6 canonical + 3 agentic metrics
2. **Failure clustering** — group failures by signature (so 132
   similar failures surface as 1 cluster)
3. **Deployment versioning** — bind scores to a deployment SHA
   (so a regression points to a specific commit)
4. **CLHF** — turn 2-5 examples into a custom metric
5. **HiL + pairwise annotation** — humans-in-the-loop refine
   the eval
6. **Multi-modal** — score text, image, audio inputs
7. **6 eval modalities** — LLM-as-judge, online, offline, trace-
   level, session-level, human annotations
8. **Boolean/Categorical scores** — non-continuous score types
9. **Custom Python eval** — let users write their own eval
   functions
10. **User feedback** — thumbs / rating / comment collection
11. **Auto-dataset from failures** — auto-curate eval datasets
    from low-score traces
12. **Eval-to-guardrail lifecycle** — promote a reliable judge
    into a production guardrail

## Source articles

* **Article 1 §3** (Evaluation Intelligence): "Every interaction
  scored, metrics: accuracy, groundedness, relevance, completeness,
  safety, user satisfaction. Regression Detection: what changed,
  when, which deployment. Failure Clustering. Evaluation
  Versioning."
* **Article 2 (Galileo)**: Luna-2 SLM eval model, CLHF, 3 agentic
  metrics, Eval-to-Guardrail lifecycle.
* **Article 2 (LangSmith)**: Human-in-the-loop annotation, pairwise
  queues, multi-modal evaluators.
* **Article 2 (Arize)**: 6 eval modalities, experiment-driven
  dataset versioning.
* **Article 3 (Langfuse)**: Boolean and Categorical LLM-as-Judge
  scores, custom Python eval functions, user feedback collection.
* **Article 3 (Braintrust)**: auto-dataset generation, Loop AI
  for natural language queries.

## What's already in Eden

* `HallucinationJudge`, `CorrectnessJudge`, `ToneJudge` at
  `src/eden/llmops/judges/`.
* `JudgeRegistry` + `JudgeRunner` at
  `src/eden/llmops/judges/`.
* `judge_scores` table at migration `010_judge_scores.py`.
* `JudgeDetector` in `src/eden/insights/detectors.py:749` bridges
  raw scores to `Insight` objects.
* `auto_dataset.py` at `src/eden/evaluation/auto_dataset.py`
  (curated from prod failures).
* `JudgeScore` dataclass with `judge_name`, `judge_version`,
  `trace_id`, `span_id`, `score`, `rationale`, `model`,
  `scored_at`, `latency_ms`, `metadata`.

## The 6 canonical metrics + 3 Galileo metrics

| Metric | Source | What it scores | Range |
|---|---|---|---|
| **Hallucination** | Existing (Eden) | Factual accuracy / fabrication | 0..1 (1 = factual) |
| **Correctness** | Existing (Eden) | Task correctness & completeness | 0..1 (1 = correct) |
| **Tone** | Existing (Eden) | Brand voice / style adherence | 0..1 (1 = on-brand) |
| **Groundedness** | Standard (this PR) | Answer vs context support | 0..1 (1 = grounded) |
| **Relevance** | Standard (this PR) | Answer vs question | 0..1 (1 = relevant) |
| **Safety** | Standard (this PR) | Toxicity, PII leakage, refusal correctness | 0..1 (1 = safe) |
| **Satisfaction** | Standard (this PR) | Proxy from user_feedback + behavioural signals | 0..1 (1 = satisfied) |
| **Action Completion** ⭐ | Galileo Luna-2 | Whether the chosen action advances the goal | 0..1 (1 = completes) |
| **Tool Selection Quality** ⭐ | Galileo Luna-2 | Whether the agent picked the best available tool | 0..1 (1 = optimal) |
| **Reasoning Coherence** ⭐ | Galileo Luna-2 | Whether the CoT justifies the action | 0..1 (1 = coherent) |

After this PR, Eden ships **10 judges total** (3 existing + 7
new). The 3 Galileo judges are reused by the Cat 16 Decision
Scorer to score individual decisions.

## Feature inventory (20 features)

### Group A: New judges (7)

| Feature | Class | File | Effort |
|---|---|---|---|
| Groundedness | `GroundednessJudge` | `src/eden/llmops/judges/groundedness.py` | S |
| Relevance | `RelevanceJudge` | `src/eden/llmops/judges/relevance.py` | S |
| Safety | `SafetyJudge` | `src/eden/llmops/judges/safety.py` | S |
| Satisfaction | `SatisfactionJudge` | `src/eden/llmops/judges/satisfaction.py` | S |
| Action Completion | `ActionCompletionJudge` ⭐ | `src/eden/llmops/judges/action_completion.py` | M |
| Tool Selection Quality | `ToolSelectionQualityJudge` ⭐ | `src/eden/llmops/judges/tool_selection_quality.py` | M |
| Reasoning Coherence | `ReasoningCoherenceJudge` ⭐ | `src/eden/llmops/judges/reasoning_coherence.py` | M |

### Group B: Versioning & clustering (3)

| Feature | Class | File | Routes |
|---|---|---|---|
| Eval Versioner | `EvalVersioner` | `src/eden/evaluation/eval_intel/versioner.py` | 1 |
| Eval Registry | `EvalRegistry` | same | 1 |
| Failure Clusterer | `FailureClusterer` | same | 1 |

### Group C: CLHF (Galileo signature) (1)

| Feature | Class | File | Routes |
|---|---|---|---|
| CLHF Generator | `CLHFGenerator` | `src/eden/evaluation/eval_intel/versioner.py` | 1 |

### Group D: Human-in-the-loop (LangSmith signature) (2)

| Feature | Class | File | Routes |
|---|---|---|---|
| HiL Task Service | `HumanInTheLoopService` | `src/eden/evaluation/eval_intel/versioner.py` | 2 |
| Pairwise Annotation Service | `PairwiseAnnotationService` | same | 2 |

### Group E: Multi-modal (LangSmith) (1)

| Feature | Class | File | Routes |
|---|---|---|---|
| Multi-modal Evaluator | `MultiModalEvaluator` | same | 1 |

### Group F: Eval-to-Guardrail (Galileo) (1)

| Feature | Class | File | Routes |
|---|---|---|---|
| Eval-to-Guardrail Link | `EvalToGuardrailLink` | same | 1 |

### Group G: Modalities (Arize) (1)

| Feature | Class | File | Routes |
|---|---|---|---|
| Six-Modalities Registry | `SixModalitiesRegistry` | same | 1 |

### Group H: Score types (Langfuse) (2)

| Feature | Class | File | Routes |
|---|---|---|---|
| Boolean/Categorical Score | `BooleanCategoricalScore` | same | 1 |
| Custom Python Eval | `CustomPythonEval` | same | 1 |

### Group I: User feedback (Langfuse, Lunary) (1)

| Feature | Class | File | Routes |
|---|---|---|---|
| User Feedback Service | `UserFeedbackService` | same | 1 |

### Group J: Auto-dataset (Braintrust) (1)

| Feature | Class | File | Routes |
|---|---|---|---|
| Auto-Dataset Bridge | `AutoDatasetBridge` | same | 1 |

## API contracts

All routes are `POST` or `GET` under
`/orgs/{org_id}/intelligence/eval/...`, gated by the
`intelligence_gap_v0` feature flag.

### Group A (judges)

Judges are registered in `JudgeRegistry`; they do not have
dedicated HTTP routes. A real implementation runs them in the
existing `JudgeRunner` (cat 1's hooks can subscribe to score
events).

### Group B (versioning)

```
POST /orgs/{org_id}/intelligence/eval/versions/tag
  body: {
    "deployment_sha": "abc123...",
    "prompt_version": "v3",
    "judge_set": ["hallucination", "groundedness", "relevance"]
  }
  → {
    "status": "not_implemented",
    "feature": "eval_versioner",
    "data": {
      "eval_version_id": "uuid",
      "deployment_sha": "abc123...",
      "prompt_version": "v3"
    }
  }

GET  /orgs/{org_id}/intelligence/eval/versions
  → { "status": "not_implemented", "data": { "versions": [...] } }
```

### Group C (failure clustering)

```
POST /orgs/{org_id}/intelligence/eval/failure-clusters
  body: {
    "judge_name": "hallucination",
    "window": "24h"
  }
  → {
    "status": "not_implemented",
    "data": {
      "clusters": [
        {
          "signature": "agent=planner+error_category=tool_timeout",
          "member_count": 132,
          "sample_score": 0.31
        }
      ]
    }
  }
```

### Group D (CLHF)

```
POST /orgs/{org_id}/intelligence/eval/clhf/generate
  body: {
    "name": "my_metric",
    "examples": [
      { "input": "...", "output": "...", "score": 0.2, "rationale": "..." },
      { "input": "...", "output": "...", "score": 0.8, "rationale": "..." }
    ]
  }
  → {
    "status": "not_implemented",
    "data": {
      "metric_id": "uuid",
      "spec": {
        "rubric": "...",
        "score_range": [0, 1],
        "prompt_template": "..."
      }
    }
  }
```

CLHF requires **2-5 examples** (Galileo's spec). Requests with
<2 or >5 examples return 400.

### Group E (HiL + pairwise)

```
POST /orgs/{org_id}/intelligence/eval/hil/tasks
  body: { "name": "annotate planner failures", "spec": { ... } }
  → { "data": { "task_id": "uuid" } }

POST /orgs/{org_id}/intelligence/eval/hil/annotations
  body: {
    "task_id": "uuid",
    "trace_id": "trace_abc",
    "label": "tool_failure",
    "rationale": "..."
  }
  → { "data": { "annotation_id": "uuid" } }

POST /orgs/{org_id}/intelligence/eval/pairwise/queues
  body: { "name": "compare v2 vs v3", "spec": { ... } }
  → { "data": { "queue_id": "uuid" } }

POST /orgs/{org_id}/intelligence/eval/pairwise/preferences
  body: {
    "queue_id": "uuid",
    "variant_a_id": "v2",
    "variant_b_id": "v3",
    "preferred": "v3"
  }
  → { "data": { "preference_id": "uuid" } }
```

### Group F (multi-modal)

```
POST /orgs/{org_id}/intelligence/eval/multimodal/evaluate
  body: {
    "modality": "text" | "image" | "audio",
    "input_url": "https://...",
    "spec": { "criteria": [...] }
  }
  → { "data": { "score": 0.85, "rationale": "..." } }
```

Unsupported modalities (e.g. "video") return 400.

### Group G (eval-to-guardrail)

```
POST /orgs/{org_id}/intelligence/eval/promote-to-guardrail
  body: {
    "judge_name": "hallucination",
    "threshold": 0.6
  }
  → {
    "data": {
      "guardrail_policy_id": "uuid",
      "linked_judge": "hallucination",
      "threshold": 0.6
    }
  }
```

This creates a row in `guardrail_policies` and a link in
`eval_to_guardrail_links`. The actual enforcement happens in
Cat 15's `InterventionEngine`.

### Group H (modalities)

```
POST /orgs/{org_id}/intelligence/eval/modalities/declare
  body: {
    "modality": "llm_as_judge" | "online" | "offline" |
                "trace_level" | "session_level" | "human_annotation",
    "config": { ... }
  }
  → { "data": { "modality_id": "uuid" } }
```

The 6 modalities are declared in a single endpoint; expansion
to dedicated endpoints happens when each modality gets a real
implementation.

### Group I (Boolean/Categorical)

```
POST /orgs/{org_id}/intelligence/eval/boolean-categorical
  body: {
    "score_type": "boolean" | "categorical",
    "value": "true" | "category_a"
  }
  → { "data": { "score": 1.0, "value": "true" } }
```

### Group J (Custom Python eval)

```
POST /orgs/{org_id}/intelligence/eval/custom-eval/register
  body: {
    "name": "length_penalty",
    "function_ref": "my_module.length_penalty_v1",
    "spec": { "threshold": 1000 }
  }
  → { "data": { "eval_id": "uuid" } }
```

`function_ref` is a dotted path to a Python function with
signature `(input: dict) -> float`. The function is dynamically
imported and called by the `JudgeRunner` when the eval is
referenced by name.

### Group K (User feedback)

```
POST /orgs/{org_id}/intelligence/eval/feedback
  body: {
    "trace_id": "trace_abc",
    "thumbs": "up" | "down",       // optional
    "rating": 4,                     // optional, 1-5
    "comment": "Great answer!"       // optional
  }
  → { "data": { "feedback_id": "uuid" } }
```

At least one of `thumbs`, `rating`, or `comment` is required.

### Group L (Auto-dataset)

```
POST /orgs/{org_id}/intelligence/eval/auto-dataset
  body: {
    "judge_name": "hallucination",
    "target_dataset_name": "hallucination_golden",
    "min_confidence": 0.85
  }
  → {
    "data": {
      "dataset_id": "uuid",
      "samples_added": 42
    }
  }
```

Wraps `src/eden/evaluation/auto_dataset.py` to auto-curate a
golden dataset from low-score traces.

## Data model (14 tables)

```sql
-- 1. Eval versions: bind scores to a deployment SHA
CREATE TABLE eval_versions (
    id                  UUID PRIMARY KEY,
    org_id              VARCHAR(128) NOT NULL,
    deployment_sha      VARCHAR(64) NOT NULL,
    prompt_version      VARCHAR(64),
    judge_set_json      TEXT,
    status              VARCHAR(16) NOT NULL DEFAULT 'active',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_eval_versions_sha ON eval_versions (org_id, deployment_sha);

-- 2. Failure clusters: group failures by signature
CREATE TABLE eval_failure_clusters (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    judge_name      VARCHAR(64) NOT NULL,
    signature       VARCHAR(256) NOT NULL,
    member_count    INTEGER NOT NULL DEFAULT 0,
    sample_json     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_eval_failure_clusters_judge
    ON eval_failure_clusters (org_id, judge_name);

-- 3. CLHF runs: 2-5 examples → custom metric
CREATE TABLE eval_clhf_runs (
    id                      UUID PRIMARY KEY,
    org_id                  VARCHAR(128) NOT NULL,
    name                    VARCHAR(128) NOT NULL,
    examples_json           TEXT NOT NULL,
    generated_metric_json   TEXT,
    status                  VARCHAR(16) NOT NULL DEFAULT 'pending',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4-5. HiL tasks + annotations
CREATE TABLE eval_hil_tasks (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    name            VARCHAR(128) NOT NULL,
    spec_json       TEXT,
    status          VARCHAR(16) NOT NULL DEFAULT 'open',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE eval_hil_annotations (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    task_id         UUID NOT NULL,
    trace_id        VARCHAR(128) NOT NULL,
    annotator_id    VARCHAR(128),
    label           VARCHAR(64),
    rationale       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_eval_hil_annotations_task
    ON eval_hil_annotations (org_id, task_id);

-- 6-7. Pairwise queues + preferences (LangSmith)
CREATE TABLE eval_pairwise_queues (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    name            VARCHAR(128) NOT NULL,
    spec_json       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE eval_pairwise_preferences (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    queue_id        UUID NOT NULL,
    variant_a_id    VARCHAR(128) NOT NULL,
    variant_b_id    VARCHAR(128) NOT NULL,
    preferred       VARCHAR(16) NOT NULL,
    annotator_id    VARCHAR(128),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_eval_pairwise_preferences_queue
    ON eval_pairwise_preferences (org_id, queue_id);

-- 8. Multi-modal runs
CREATE TABLE eval_multimodal_runs (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    modality        VARCHAR(16) NOT NULL,
    input_url       TEXT,
    score           DOUBLE PRECISION,
    rationale       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_eval_multimodal_runs_modality
    ON eval_multimodal_runs (org_id, modality);

-- 9. Eval-to-guardrail links
CREATE TABLE eval_to_guardrail_links (
    id                  UUID PRIMARY KEY,
    org_id              VARCHAR(128) NOT NULL,
    judge_name          VARCHAR(64) NOT NULL,
    guardrail_policy_id UUID,
    threshold           DOUBLE PRECISION NOT NULL,
    status              VARCHAR(16) NOT NULL DEFAULT 'active',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 10. Modality declarations
CREATE TABLE eval_modality_declarations (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    modality        VARCHAR(32) NOT NULL,
    config_json     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 11. Boolean/Categorical scores
CREATE TABLE eval_boolean_categorical_scores (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    trace_id        VARCHAR(128) NOT NULL,
    score_type      VARCHAR(16) NOT NULL,
    value           VARCHAR(64) NOT NULL,
    rationale       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 12. Custom Python evals
CREATE TABLE eval_custom_python_evals (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    name            VARCHAR(128) NOT NULL,
    function_ref    VARCHAR(256) NOT NULL,
    spec_json       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 13. User feedback (Cat 3 duplicates Cat 9 to keep both
-- appendices self-contained; both are read by the
-- SatisfactionJudge)
CREATE TABLE eval_user_feedback (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    trace_id        VARCHAR(128) NOT NULL,
    user_id         VARCHAR(128),
    thumbs          VARCHAR(8),
    rating          INTEGER,
    comment         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_eval_user_feedback_trace
    ON eval_user_feedback (org_id, trace_id);

-- 14. Auto-dataset bridge
CREATE TABLE eval_auto_dataset_bridge (
    id                  UUID PRIMARY KEY,
    org_id              VARCHAR(128) NOT NULL,
    judge_name          VARCHAR(64) NOT NULL,
    source_dataset_id   UUID,
    target_dataset_id   UUID,
    status              VARCHAR(16) NOT NULL DEFAULT 'pending',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Algorithm / pseudo-code

### Judge extension pattern

All 7 new judges follow the same pattern as the existing
`HallucinationJudge` (see `src/eden/llmops/judges/hallucination.py`):

```python
class GroundednessJudge(Judge):
    name = "groundedness"
    version = "2026-06-10"
    model_slot = "fast"

    def matches(self, event):
        return super().matches(event) and (
            "openai" in (event.payload or {})
            or "anthropic" in (event.payload or {})
        )

    async def score(self, event, ctx):
        if ctx.llm_client is None:
            return self._low_confidence(event, ctx, reason="no llm_client")
        text, context = _extract_text_and_context(event)
        if not text or not context:
            return self._low_confidence(event, ctx, reason="missing_text_or_context")
        prompt = _GROUNDEDNESS_PROMPT.format(
            context=context[:1500], response=text[:1200]
        )
        try:
            resp = ctx.llm_client.call(
                agent=f"judge_{self.name}",
                prompt=prompt, slot=self.model_slot, max_tokens=120,
            )
            data = _parse_judge_response(resp, event, ctx)
            return data
        except Exception:
            return self._low_confidence(event, ctx, reason="llm_error")
```

### CLHF (Galileo signature algorithm)

```python
def generate_custom_metric(org_id, name, examples):
    assert 2 <= len(examples) <= 5, "CLHF requires 2-5 examples"
    # 1. Build a few-shot prompt with the examples
    few_shot = "\n\n".join(
        f"Input: {ex['input']}\nOutput: {ex['output']}\n"
        f"Score: {ex['score']}\nRationale: {ex['rationale']}"
        for ex in examples
    )
    # 2. Ask a judge-LLM to propose a metric spec
    spec = llm_client.call(
        agent="clhf_generator",
        prompt=CLHF_GENERATION_PROMPT.format(few_shot=few_shot),
        slot="fast",
    )
    # 3. Validate the spec (rubric, score range, prompt template)
    spec = validate_metric_spec(spec)
    # 4. Re-evaluate the examples to verify the metric
    #    reproduces the human-labelled scores
    scores = []
    for ex in examples:
        s = evaluate_with_spec(spec, ex["input"], ex["output"])
        scores.append(s)
    agreement = sum(
        1 for s, ex in zip(scores, examples)
        if abs(s - ex["score"]) < 0.15
    ) / len(examples)
    if agreement < 0.6:
        raise ValueError(f"CLHF metric agrees on only {agreement:.0%} of examples")
    # 5. Register the new judge
    new_judge = CustomJudge.from_spec(name, spec)
    JudgeRegistry().register(new_judge)
    return new_judge.id
```

### Failure clustering

```python
def cluster(org_id, judge_name, window):
    rows = SELECT * FROM judge_scores
            WHERE org_id = ? AND judge_name = ?
              AND scored_at > NOW() - window
              AND score < threshold
    # Group by (judge_name, agent_id, error_category) signature
    clusters = {}
    for row in rows:
        sig = f"{row['judge_name']}+{row['metadata'].get('agent_id')}+" \
              f"{row['metadata'].get('error_category')}"
        if sig not in clusters:
            clusters[sig] = {"signature": sig, "members": []}
        clusters[sig]["members"].append(row)
    return [
        {"signature": c["signature"], "member_count": len(c["members"]),
         "sample_score": mean(m["score"] for m in c["members"])}
        for c in clusters.values()
        if len(c["members"]) >= min_cluster_size
    ]
```

### Eval-to-guardrail lifecycle

```python
def promote_to_guardrail(org_id, judge_name, threshold):
    # 1. Validate the judge has at least N samples in the last 30 days
    sample_count = SELECT COUNT(*) FROM judge_scores
                   WHERE org_id = ? AND judge_name = ?
                     AND scored_at > NOW() - INTERVAL '30 days'
    if sample_count < 100:
        raise ValueError(f"need ≥100 samples, got {sample_count}")
    # 2. Compute the judge's FPR / FNR at the given threshold
    metrics = evaluate_threshold(org_id, judge_name, threshold)
    if metrics.fpr > 0.05:
        raise ValueError(f"judge FPR {metrics.fpr:.1%} too high")
    # 3. Create a new GuardrailPolicy of type "judge_link"
    policy = GuardrailPolicy.create(
        org_id=org_id,
        name=f"judge_link:{judge_name}@{threshold}",
        type="judge_link",
        spec={"judge_name": judge_name, "threshold": threshold},
    )
    # 4. Persist the link
    EvalToGuardrailLink.create(
        org_id=org_id, judge_name=judge_name,
        guardrail_policy_id=policy.id, threshold=threshold,
    )
    return policy.id
```

## Failure modes & guardrails

* **CLHF with <2 or >5 examples** — return 400 with explicit
  error message. Do not generate a metric.
* **CLHF metric disagrees with examples** — raise `ValueError`;
  the metric is not registered. The user must add more examples
  or refine the existing ones.
* **Multi-modal with unsupported modality** — return 400. The
  stub supports `text`, `image`, `audio` only.
* **Eval-to-guardrail with noisy judge (FPR > 5%)** — refuse
  to promote; return 400 with a clear error.
* **Custom Python eval with invalid function_ref** — return 400;
  the function is not importable.
* **User feedback without any of thumbs/rating/comment** —
  return 400.
* **HiL annotation against a closed task** — return 409 Conflict.

## Telemetry

Metrics emitted by the Cat 3 surface (each tagged with
`org_id`, `judge_name`, and `category`):

* `intelligence_judge_score` (counter) — number of scores
  written, by judge_name
* `intelligence_judge_latency_ms` (histogram) — judge call
  latency
* `intelligence_judge_error` (counter) — judge errors
* `intelligence_clhf_generation` (counter) — CLHF runs
* `intelligence_clhf_agreement` (histogram) — agreement
  between generated metric and example scores
* `intelligence_eval_to_guardrail` (counter) — promotions
* `intelligence_hil_annotation` (counter) — annotations
* `intelligence_pairwise_preference` (counter) — preferences
* `intelligence_multimodal_score` (histogram) — multi-modal
  scores
* `intelligence_user_feedback` (counter) — feedback submissions
* `intelligence_auto_dataset_built` (counter) — datasets
  curated

Dashboards (in the existing Grafana setup):

* **Cat 3 Overview** — judge score distribution, error rates,
  latency p50/p95
* **Eval Version Comparison** — side-by-side score
  distributions per deployment SHA
* **Failure Cluster Drilldown** — click a cluster to see
  members
* **CLHF Agreement** — agreement vs example count scatter
* **User Feedback** — thumbs up/down over time, by agent

## Test plan

* **Unit tests** (per service): 1-2 per public method, ~50 total
* **Integration tests** (per route): 1 per route, ~15 total
* **End-to-end tests**: deploy a new prompt version, verify
  scores are written, verify failure clusters surface
* **Property-based tests**: CLHF agreement on random examples
  is monotonically non-decreasing in example count

## Acceptance criteria

- [x] All 7 judges produce a `JudgeScore` with `score ∈ [0, 1]`
  on a synthetic test set of 100 events. *(Judges were
  shipped pre-Cat-3 in `src/eden/llmops/judges/` and
  registered via `register_intelligence_judges()`.)*
- [x] CLHF generates a metric that, when re-evaluated on the
  same examples, returns the same score ±0.15 on ≥ 60% of
  examples. (`CLHFGenerator.AGREEMENT_TOLERANCE = 0.15`,
  `AGREEMENT_THRESHOLD = 0.6`.)
- [x] Failure clusters are stable across re-runs (idempotent).
  Cluster signature = `judge_name + agent_id + error_category`;
  cluster id = `clu_<sha256[:16]>` of the signature — re-runs
  produce the same id.
- [x] User feedback flows into the `SatisfactionJudge` and
  updates the per-org satisfaction average within 60s. *(The
  existing `SatisfactionJudge` reads `user_feedback` rows;
  the new `UserFeedbackService` writes them.)*
- [x] Auto-dataset from low-judge-scores produces a
  `GoldenDataset` in the existing `auto_dataset.py` registry.
  (`AutoDatasetBridge.from_judge_failures` calls
  `AutoDatasetPromoter.process_traces`.)
- [x] Eval-to-guardrail promote creates a row in both
  `eval_to_guardrail_links` and `guardrail_policies`. (Fires
  `GuardrailHook.on_judge_threshold_breach` on success.)
- [x] Custom Python eval register returns 200 and the eval is
  callable via `JudgeRegistry`. (Import-only check in v1;
  real sandboxing is deferred per appendix Open Question 1.)
- [x] Multi-modal `text`, `image`, `audio` evaluations all
  return 200. (Image/audio routed as text in v1.)
- [x] Pairwise queue + preference flow round-trips.
- [x] HiL task + annotation flow round-trips. (Submitting
  against a closed task returns 409 conflict.)

## Verification checklist (2026-06-11)

- [x] **Build green:** all 13 services importable via the
  package's lazy re-export
  (`from eden.evaluation.eval_intel import EvalVersioner,
  EvalRegistry, FailureClusterer, CLHFGenerator,
  HumanInTheLoopService, PairwiseAnnotationService,
  MultiModalEvaluator, EvalToGuardrailLink,
  SixModalitiesRegistry, BooleanCategoricalScore,
  CustomPythonEval, UserFeedbackService, AutoDatasetBridge`).
- [x] **15 routes registered:**
  `POST /versions/tag`, `GET /versions`,
  `POST /failure-clusters`, `POST /clhf/generate`,
  `POST /hil/tasks`, `POST /hil/annotations`,
  `POST /pairwise/queues`, `POST /pairwise/preferences`,
  `POST /multimodal/evaluate`, `POST /promote-to-guardrail`,
  `POST /modalities/declare`, `POST /boolean-categorical`,
  `POST /custom-eval/register`, `POST /feedback`,
  `POST /auto-dataset`.
- [x] **Persistence to all 14 Cat 3 tables:**
  `eval_versions`, `eval_failure_clusters`, `eval_clhf_runs`,
  `eval_hil_tasks`, `eval_hil_annotations`,
  `eval_pairwise_queues`, `eval_pairwise_preferences`,
  `eval_multimodal_runs`, `eval_to_guardrail_links`,
  `eval_modality_declarations`,
  `eval_boolean_categorical_scores`,
  `eval_custom_python_evals`, `eval_user_feedback`,
  `eval_auto_dataset_bridge`. Plus the cross-cat write to
  `guardrail_policies` (Cat 15's table) from
  `EvalToGuardrailLink.promote_to_guardrail`.
- [x] **CLHF re-evaluation agreement gate:** 0.6 threshold,
  0.15 tolerance. Below threshold → 400 bad-request.
- [x] **Failure clusterer deterministic IDs:** `clu_<sha256[:16]>`
  of the signature — same input → same id.
- [x] **Eval-to-guardrail promotion gate:** ≥ 100 samples in
  last 30 days AND FPR ≤ 0.05. Below either gate → 400
  bad-request.
- [x] **Closed-loop hooks fire:**
  `PromotionHook.on_judge_regression` for eval-version
  regression detection (≥ 0.05 mean drop on the
  intersection of new and previous judge sets with
  ≥ 5 samples each).
  `GuardrailHook.on_judge_threshold_breach` for
  eval-to-guardrail promotion.
- [x] **HiL closed-task conflict:** `submit_annotation`
  returns 409 when the task status is `"closed"`.
- [x] **Custom Python eval import-check:** `register`
  returns 400 when the function_ref doesn't resolve via
  `importlib`.
- [x] **108 new tests pass:** 89 service-level unit tests +
  4 envelope tests + 5 package-contract tests + 15 route
  smoke tests. Total 108 tests, ~1.4s.
- [x] **No regressions in adjacent suites:** full
  `tests/intelligence/` = 382 passed (1 skipped, the
  pre-existing live-tail skip); `tests/unit/llmops/ +
  tests/unit/observability/` = 264 passed.
- [x] **Migration unchanged:** `020_intelligence_gap_tables.py`
  is the only schema needed; no migration 021 required.

**Net code change for Cat 3:**
7 new files in `src/eden/evaluation/eval_intel/` (1
shared `_common.py` ~480 LOC, 6 service files), 1
converted `versioner.py` to a thin re-export shim, 1
modified router (`intelligence_eval.py`, 15 `await`
keyword additions + 1 import update), 1 new test file
(`test_evaluation_intelligence.py` with 108 tests). Two
closed-loop hooks fired (`on_judge_regression`,
`on_judge_threshold_breach`).

## Implementation order

1. Group A (judges) — small, isolated, can ship first
2. Group B (versioning) — extends the existing
   `judge_scores` table with deployment SHA references
3. Group C (CLHF) — needs an LLM call; depends on JudgeRunner
4. Group E (HiL + pairwise) — small, isolated
5. Group F (multi-modal) — needs an image/audio model
6. Group G (eval-to-guardrail) — depends on Cat 15
7. Group H (modalities) — small, isolated
8. Group I (Boolean/Categorical) — small, isolated
9. Group J (Custom Python) — small, isolated
10. Group K (User feedback) — depends on Cat 9
11. Group L (Auto-dataset) — wraps existing `auto_dataset.py`

## Open questions

* **Custom Python eval sandbox** — should user-provided
  `function_ref` run in a subprocess / sandbox? For safety,
  probably yes. (Owner: Cat 3 lead)
* **CLHF metric version** — when a metric is regenerated, do
  we version the spec and keep both? (Owner: Cat 3 lead)
* **Multi-modal image model** — which model? GPT-4V? Claude 3
  Opus? A custom classifier? (Owner: Cat 3 lead)
* **Pairwise preference aggregation** — how do we aggregate
  multiple annotators' preferences into a single winner?
  Bradley-Terry model? Simple majority? (Owner: Cat 3 lead)
* **HiL task assignment** — do we ship a queue-management UI
  or integrate with an external labelling tool (Label Studio,
  Scale)? (Owner: Cat 3 lead)
* **Eval versioning storage** — should `judge_set_json` be a
  strict schema (Pydantic) or freeform JSON? (Owner: Cat 3
  lead)

## Cross-references

* Master doc: [`eden-observability-gap-roadmap.md`](/observability/gap-roadmap)
* Stub envelope: `src/eden/intelligence_envelope.py`
* Closed-loop hooks: `src/eden/llmops/promotion_hooks.py`
* Cat 15 (Guardrails): [`15-runtime-protection-guardrails.md`](./15-runtime-protection-guardrails.md)
* Cat 16 (Decision): [`16-decision-intelligence.md`](./16-decision-intelligence.md)
* Existing judges: `src/eden/llmops/judges/`
* Auto-dataset: `src/eden/evaluation/auto_dataset.py`
