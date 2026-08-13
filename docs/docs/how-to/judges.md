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

## 1. Deterministic scorers

Deterministic checks (regex, schema, exact-match) can be used in
two ways:

1. **Inline in Playground / CI** — specify a scorer in your task or
   eval config and it runs at evaluation time, no API call needed.
2. **Persistent judge definitions (W4-4)** — register a named
   deterministic judge via the API and reuse it across runs. The
   judge is stored in the metric-studio registry and can be executed
   on demand.

### Persistent deterministic judges (API)

Create a named deterministic judge backed by the scorer registry:

```bash
curl -X POST \
  "https://api.edenobservability.com/orgs/{org_id}/observability/judges/definitions" \
  -H "Authorization: Bearer sk_eden_..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "No-secrets check",
    "scorer_type": "regex",
    "scorer_config": { "pattern": "sk_(live|test)_[A-Za-z0-9]{20,}" }
  }'
```

This returns a `judge_id` (e.g. `djudge_abc123`). Use it to:

- **Execute** against a payload:
  ```bash
  curl -X POST \
    ".../judges/definitions/djudge_abc123/execute" \
    -d '{ "output": "Here is your key: sk_live_..." }'
  # → { "score": true, "detail": null }
  ```
- **List** all judges: `GET .../judges/definitions`
- **Get** one judge: `GET .../judges/definitions/{judge_id}`
- **Delete** (archive) a judge: `DELETE .../judges/definitions/{judge_id}`
  (admin only)

Writes (`POST`, `DELETE`) require an org admin token.

| Route | Method | Auth |
|---|---|---|
| `/orgs/{org_id}/observability/judges/definitions` | POST | Admin |
| `/orgs/{org_id}/observability/judges/definitions` | GET | Member |
| `/orgs/{org_id}/observability/judges/definitions/{judge_id}` | GET | Member |
| `/orgs/{org_id}/observability/judges/definitions/{judge_id}` | DELETE | Admin |
| `/orgs/{org_id}/observability/judges/definitions/{judge_id}/execute` | POST | Member |

### Built-in scorers (Playground / CI)

| Scorer type | What it checks |
|-------------|----------------|
| `regex_absent` | Pattern must be absent from the response |
| `regex_present` | Pattern must be present |
| `exact_match` | Response equals expected value |
| `contains` | Response contains a substring |
| `json_valid` | Response parses as valid JSON |
| `llm_judge` | Rubric-based LLM scoring (delegates to the judge registry) |

### Using scorers in a CI eval run

```json
{
  "dataset_id": "ds_abc",
  "scorers": [
    {
      "type": "regex_absent",
      "pattern": "sk_(live|test)_[A-Za-z0-9]{20,}",
      "fields": ["response"]
    },
    { "type": "json_valid" },
    { "type": "llm_judge", "axis": "correctness" }
  ]
}
```

Results land in the Playground run or CI report — no persistent
judge score rows are written for deterministic scorers.

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

Configure in your Playground task or CI eval config with `type: llm_judge`:

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

1. **CI / Playground:** deterministic scorers run on every eval dataset
   row → catch PII / secrets before promotion.
2. **Sampled:** LLM judges run on 1-in-N live traces → scores stored
   in `judge_scores`.
3. **Nightly:** golden dataset runs against the current prompt
   version → emit a daily eval summary.
4. **On PR:** dataset runs in CI against the PR's prompt version →
   block merge if mean score drops below baseline.
5. **Continuous:** regression alerts watch the live judge scores →
   Slack ping if quality drops.

The portal's **Eval** dashboard ties it all together: per-trace
scores, per-run stats, per-dataset coverage, and alert history.