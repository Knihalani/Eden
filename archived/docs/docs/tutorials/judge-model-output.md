---
id: judge-model-output
title: Judge a model output
sidebar_label: Judge a model output
sidebar_position: 4
---

# Tutorial — Judge a model output

Time: **15 minutes**. By the end you'll have two judges running
against your traces — one deterministic, one LLM-based — and you'll
see per-trace scores plus a regression alert in the portal.

## What you'll build

A pair of judges that score every trace from the FAQ bot you built
in [Auto-instrument OpenAI](/tutorials/auto-instrument-openai):

1. **`no_pii`** — deterministic, fails the trace if the response
   contains an email or phone number.
2. **`is_concise`** — LLM judge with a 1–5 rubric for response length.

## Step 1 — Open the Eval tab

Portal → **Eval** → **Runs** → **New run**.

## Step 2 — Configure a deterministic scorer

Deterministic checks (regex absence, JSON validation, etc.) are
configured as **scorers** on a dataset eval run or in your CI config.
There is no persistent "create a deterministic judge" flow in the portal.

Add a scorer to your eval run config:

```json
{
  "scorers": [
    {
      "type": "regex_absent",
      "pattern": "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b",
      "fields": ["response"],
      "name": "no_pii"
    }
  ]
}
```

The scorer runs against every item in your dataset. Results appear in
the Eval run report — no separate "judge score" rows are written for
deterministic scorers.

## Step 3 — Create an LLM judge

| Field | Value |
|-------|-------|
| Name | `is_concise` |
| Kind | `llm` |
| Model | `gpt-4o-mini` |
| Rubric scale | `[1, 2, 3, 4, 5]` |
| Prompt template | (use the default) |
| Criteria | `Is the response appropriately brief for the question?` |
| Pass threshold | `4.0` |
| Warn threshold | `3.0` |

Save. LLM judges have a 60-second cooldown (configurable) to avoid
double-scoring the same trace.

## Step 4 — Run a batch eval against existing traces

Portal → **Eval** → **Runs** → **New run** → pick `no_pii` and
`is_concise` → sample 100 traces from the last 24 hours.

The run takes a few minutes. You'll see:

- Total traces scored
- Pass / warn / fail counts
- Mean score, p50 score

Click into the run to see per-trace scores. Failures link back to
the originating trace so you can read the prompt and response.

## Step 5 — Set up a regression alert

Portal → **Eval** → **Alerts** → **New alert**.

| Field | Value |
|-------|-------|
| Judge | `is_concise` |
| Condition | `mean_score` drops by `≥ 0.5` vs the previous run |
| Severity | `warning` |
| Channel | `slack` (configure Slack in Settings → Integrations first) |

Now if your prompt regresses — say a model upgrade pushes responses
from a 4.5 mean to 3.8 — you'll get a Slack ping within an hour.

## Step 6 — Inspect scores from the API

```bash
curl https://api.edenobservability.com/orgs/$EDEN_ORG_ID/evals \
  -H "X-Org-Api-Key: $EDEN_API_KEY" \
  -H "X-Org-Id: org_..." \
  | jq '.data[] | {eval_id, judge_id, stats}'
```

Or fetch a single run:

```bash
curl https://api.edenobservability.com/orgs/$EDEN_ORG_ID/evals/eval_abc \
  -H "X-Org-Api-Key: $EDEN_API_KEY" \
  -H "X-Org-Id: org_..." \
  | jq '.data.stats'
```

## Step 7 — Add the score to your trace view

The portal's **Trace** detail page now shows:

```
Trace trc_abc · 1.84 s · 1240 input tok · 410 output tok
├── openai.chat.completions · 0.79 s · gpt-4o-mini
└── judge scores
    ├── no_pii       1.00  ✓ pass
    └── is_concise   4.50  ✓ pass
```

This makes it easy to spot which call caused a regression: drill
into the failing trace, see the judge score, click through to the
prompt that produced it.

## What you learned

- Deterministic judges run on every trace in real time (zero cost).
- LLM judges are sampled, throttled, and stored as `judge_scores`.
- Runs batch-evaluate a sample of traces; alerts fire when the
  aggregate crosses a threshold.
- Scores join back to traces so you can always see which prompt
  caused a regression.

## Where next

- [How-to — Build a regression-safe eval pipeline](/how-to/judges)
- [Reference — Evaluations API](/reference/api-eval)