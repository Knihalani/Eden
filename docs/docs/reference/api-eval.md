---
id: api-eval
title: Evaluations API
sidebar_label: Evaluations
sidebar_position: 5
---

# Evaluations API

Run judges against traces, build golden datasets, and ship
regression alerts. The portal's **Eval** tab wraps these endpoints.

## Concepts

| Concept | What it is |
|---------|-----------|
| **Judge** | A scoring function. Either a deterministic regex / schema check or an LLM call with a rubric. |
| **Eval** | A run of a judge against one or more traces. Produces a `judge_score` per trace. |
| **Dataset** | A versioned collection of `(input, expected_output)` pairs. Used to drive batch evals. |
| **Run** | An execution of an eval against a dataset. Used to compare prompt versions. |

## `POST /v1/judges`

Create a judge.

### Request — deterministic judge

```json
{
  "name": "no_pii_in_response",
  "kind": "deterministic",
  "rule": {
    "type": "regex_absent",
    "pattern": "\\b\\d{3}-\\d{2}-\\d{4}\\b",
    "fields": ["response"]
  },
  "threshold": { "pass": 1.0 },
  "scope": { "source_format": ["openai", "anthropic"] }
}
```

### Request — LLM judge

```json
{
  "name": "is_helpful",
  "kind": "llm",
  "prompt_template": "rubrics/is_helpful.md",
  "model": "gpt-4o",
  "rubric": {
    "scale": [0, 1, 2, 3, 4, 5],
    "criteria": [
      "Does the response answer the user's question directly?",
      "Is the response free of hallucinations?"
    ]
  },
  "threshold": { "pass": 4.0, "warn": 3.0 },
  "cooldown_seconds": 60
}
```

### Response

```json
{
  "data": {
    "judge_id": "judge_abc",
    "version": 1,
    "created_at": "2026-06-19T10:30:00Z"
  }
}
```

## `GET /v1/judges`

List judges. Filter by `name`, `kind`, `enabled`.

## `POST /v1/evals`

Run a judge against traces.

### Request — single trace

```json
{
  "judge_id": "judge_abc",
  "trace_ids": ["trc_xyz"],
  "async": false
}
```

### Request — sample of recent traces

```json
{
  "judge_id": "judge_abc",
  "sample": { "limit": 200, "since": "2026-06-18T00:00:00Z" },
  "async": true
}
```

### Response

```json
{
  "data": {
    "eval_id": "eval_abc",
    "judge_id": "judge_abc",
    "queued_traces": 200,
    "started_at": "2026-06-19T10:30:00Z",
    "status": "running"
  }
}
```

For async runs, poll `GET /v1/evals/{eval_id}` until `status` is
`complete`. Results land in `judge_scores` joined to
`telemetry_events` on `trace_id`.

## `GET /v1/evals/{eval_id}`

```json
{
  "data": {
    "eval_id": "eval_abc",
    "judge_id": "judge_abc",
    "status": "complete",
    "stats": {
      "total": 200,
      "passed": 184,
      "warned": 12,
      "failed": 4,
      "mean_score": 4.42,
      "p50_score": 4.5
    },
    "started_at": "2026-06-19T10:30:00Z",
    "ended_at": "2026-06-19T10:34:11Z"
  }
}
```

## `POST /v1/datasets`

Create a golden dataset.

```json
{
  "name": "checkout_smoke_v1",
  "version": "1.0.0",
  "items": [
    {
      "input": { "user_query": "Cancel order ord_123" },
      "expected": { "outcome": "success", "tools_called": ["stripe.refund"] },
      "metadata": { "tags": ["smoke"] }
    }
  ]
}
```

## `POST /v1/datasets/{dataset_id}/run`

Run a judge against every item in a dataset. Useful for prompt A/B
tests.

```json
{
  "judge_id": "judge_abc",
  "prompt_version": "v3",
  "model": "gpt-4o-mini",
  "async": true
}
```

## `GET /v1/evals/{eval_id}/scores`

Stream the per-trace judge scores as NDJSON. Used by the portal's
regression-review workflow.

## Webhook hooks

Eval runs fire:

- `judge.threshold_breach` — any score falls below the configured
  `threshold.warn`
- `judge.regression` — `mean_score` drops by ≥ 0.5 vs the previous
  run (configurable)

Both routes through [Webhooks](/reference/webhooks).

## Errors

| Status | Code | Cause |
|--------|------|-------|
| 404 | `judge_not_found` / `dataset_not_found` / `eval_not_found` | Unknown id |
| 422 | `invalid_rubric` | LLM judge rubric fails schema validation |
| 429 | `judge_quota_exceeded` | Per-org LLM-as-judge budget hit |