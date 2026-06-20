---
id: judges
title: Build a judge pipeline
sidebar_label: Build a judge pipeline
sidebar_position: 9
---

# How-to — Build a judge pipeline

A regression-safe eval pipeline has four pieces:

1. **Deterministic judges** — regex, schema, JSON validators. Cheap
   and instant.
2. **LLM judges** — rubric-based scoring. Sampled and throttled.
3. **Golden datasets** — versioned `(input, expected)` pairs that
   drive batch evals.
4. **Regression alerts** — fire when an eval run's mean score
   drops.

## 1. Deterministic judges

These run on every trace in real time. They're free (no LLM call)
and instant. Use them for things you can express as a regex or
schema.

### Built-in judges

| Judge | Rule |
|-------|------|
| `no_pii` | Regex absence on email/phone/SSN/CC |
| `json_valid` | The response parses as JSON |
| `max_length` | Response length ≤ N tokens |
| `has_tool_call` | Response contains a tool call |
| `no_refusal` | Response doesn't contain a refusal phrase |

### Custom

Portal → **Eval** → **Judges** → **New judge** → Kind:
`deterministic`.

```json
{
  "name": "no_internal_secrets",
  "kind": "deterministic",
  "rule": {
    "type": "regex_absent",
    "pattern": "sk_(live|test)_[A-Za-z0-9]{20,}",
    "fields": ["response", "attributes"]
  },
  "threshold": { "pass": 1.0 }
}
```

Save. Runs on every trace immediately.

## 2. LLM judges

For subjective criteria (helpfulness, tone, accuracy), use an LLM
judge with a rubric.

### Sample prompt template

```markdown
You are evaluating the assistant's response to a user query.

User query: {prompt}
Assistant response: {response}

Score the response on a scale of 1–5 for each criterion:

- **Helpfulness** — Does it answer the question directly?
- **Accuracy** — Is it free of hallucinations?
- **Conciseness** — Is it appropriately brief?
- **Tone** — Is it on-brand and respectful?

Reply with JSON: {"helpfulness": N, "accuracy": N, "conciseness": N, "tone": N, "overall": N}
```

### Configure

Portal → **Eval** → **Judges** → **New judge** → Kind: `llm`.

```json
{
  "name": "support_quality",
  "kind": "llm",
  "model": "gpt-4o-mini",
  "prompt_template": "rubrics/support.md",
  "rubric": {
    "scale": [1, 2, 3, 4, 5],
    "criteria": ["helpfulness", "accuracy", "conciseness", "tone"]
  },
  "threshold": { "pass": 4.0, "warn": 3.0 },
  "cooldown_seconds": 60
}
```

`cooldown_seconds` is the dedupe window — the same trace isn't
re-judged within that interval.

## 3. Golden datasets

Versioned `(input, expected)` pairs that drive batch evals.

```bash
curl -X POST https://api.edenobservability.com/v1/datasets \
  -H "Authorization: Bearer sk_eden_..." \
  -H "X-Org-Id: org_abc" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "support_smoke_v1",
    "version": "1.0.0",
    "items": [
      {
        "input": { "user_query": "Where is my order #12345?" },
        "expected": {
          "must_contain": ["tracking", "shipped"],
          "must_not_contain": ["I don'\''t know"],
          "tools_called": ["orders.lookup"]
        },
        "metadata": { "tags": ["smoke"] }
      }
    ]
  }'
```

### Run a dataset against a judge

```bash
curl -X POST https://api.edenobservability.com/v1/datasets/ds_abc/run \
  -H "Authorization: Bearer sk_eden_..." \
  -H "X-Org-Id: org_abc" \
  -H "Content-Type: application/json" \
  -d '{
    "judge_id": "judge_abc",
    "model": "gpt-4o-mini",
    "prompt_version": "v3"
  }'
```

This runs every dataset item through your judge, with the agent
configured to use the named `prompt_version`. Compare runs across
prompt versions to find the best one.

## 4. Regression alerts

Portal → **Eval** → **Alerts** → **New alert**.

```json
{
  "name": "support_quality_regression",
  "judge_id": "judge_abc",
  "condition": "mean_score_drop",
  "threshold": 0.5,
  "severity": "warning",
  "channels": ["slack", "webhook"]
}
```

`condition` is one of:

| Condition | Fires when |
|-----------|------------|
| `mean_score_drop` | Mean score drops by ≥ threshold vs the previous run |
| `pass_rate_drop` | Pass rate drops by ≥ threshold (percentage points) |
| `threshold_breach` | Any single score crosses the configured threshold |
| `hard_regression` | Mean drops by ≥ 2× threshold (Bayesian hard-regression, per Cat 12) |

## Putting it all together

A typical pipeline:

1. **Real-time:** deterministic judges run on every trace → block
   PII / secrets in production immediately.
2. **Sampled:** LLM judges run on 1-in-N traces → store scores in
   `judge_scores`.
3. **Nightly:** golden dataset runs against the current prompt
   version → emit a daily eval summary.
4. **On PR:** dataset runs in CI against the PR's prompt version →
   block merge if mean score drops below baseline.
5. **Continuous:** regression alerts watch the live judge scores →
   Slack ping if quality drops.

The portal's **Eval** dashboard ties it all together: per-trace
scores, per-run stats, per-dataset coverage, and alert history.