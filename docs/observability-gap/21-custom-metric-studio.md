---
title: "21 — Custom-Metric Studio (v1.3)"
status: ✅ IMPLEMENTED v1
last_updated: 2026-06-11
version: 1.0
---

# 21 — Custom-Metric Studio (v1.3)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-11,
> 41 new tests, 9 new files in `src/eden/metric_studio/`).
> **Decision (2026-06-11):** rubric + LLM-as-judge only —
> no fine-tuning infra. The SLM-as-judge path (Luna-Studio
> parity) is the v1.4 SLM Initiative (separate plan doc).
> **LLM-as-judge is OFF by default** per the v1.4 opt-in
> policy — manual trigger by default, per-tenant opt-in auto.

## Table of Contents

1. [Goal & motivation](#goal--motivation)
2. [Source articles & research](#source-articles--research)
3. [What's already in Eden](#whats-already-in-eden)
4. [Feature inventory](#feature-inventory)
5. [API contracts](#api-contracts)
6. [Data model](#data-model)
7. [Algorithm / pseudo-code](#algorithm--pseudo-code)
8. [Failure modes & guardrails](#failure-modes--guardrails)
9. [Telemetry](#telemetry)
10. [Test plan](#test-plan)
11. [Acceptance criteria](#acceptance-criteria)
12. [Open questions](#open-questions)
13. [Cross-references](#cross-references)

## Goal & motivation

"What does *good* look like for *my* domain?" is the
question every team has. Off-the-shelf LLM judges
(Galileo Hallucination, Braintrust Factuality) cover
~30% of these needs. Cat 21 ships the surface to
define the other 70% — custom metrics that match the
customer's domain.

The user story:

> "I have 5 example responses I want scored for 'policy
> compliance'. Give me a rubric, register it as a
> judge, and let me score new traces with it."

## Source articles & research

* **Braintrust generate-scorer**: a 2-5 example →
  LLM-as-judge flow. The user provides examples; the
  system generates a scorer. The reference for
  Cat 21's `RubricSynthesiser.from_examples`.
* **Langfuse custom Python evaluators**: a more
  manual approach; users write Python code. Cat 21
  is a step up — the rubric is generated, not coded.
* **Galileo CLHF (Continuous Learning from Human
  Feedback)**: 2-5 examples → custom metric. The
  reference for Cat 21's UX.
* **OpenRS Open Rubric (2026)**: 50+ query-type-specific
  rubrics with weighted criteria. The reference for
  Cat 21's `RubricTemplateLibrary`.
* **Microsoft LLM-Rubric (ACL 2024)**: a
  multi-dimensional rubric scoring framework. The
  reference for the per-criterion scoring.

## What's already in Eden

**The v1.3 ship is real and in production.** Four
services in `src/eden/metric_studio/` plus the
`MetricStudioHook` in `src/eden/llmops/promotion_hooks.py`:

* **`RubricTemplateLibrary`** (`templates.py`) — a
  frozen, in-process catalog of 13 hand-curated rubric
  templates across 6 domains (safety, compliance,
  marketing, legal, factual, tone). Each template ships
  with 3-6 concrete criteria ready to be passed to the
  synthesis LLM as a seed, or to be used as-is by the
  customer.
* **`RubricSynthesiser`** (`synthesiser.py`) — from
  2-5 user-labelled examples, generate a rubric prompt
  via the existing `OpenRouterClient` in the `fast`
  slot. The synthesised rubric is capped at **1,500
  tokens** (the appendix spec), persisted to
  `custom_metric_runs` with `status="synthesised"` and
  `approval_status="pending"`, and gated on a human-in-
  the-loop approval before it can be wrapped as a
  runtime judge. LLM failure is non-fatal — the route
  returns a stub envelope with a clear `message` and
  no audit log row is written.
* **`JudgeFactory`** (`judge_factory.py`) + **`RubricJudge`**
  — wraps an approved rubric as a `Judge` subclass
  (`RubricJudge`, registered in the global
  `JudgeRegistry` with name `custom_<metric_id>`) and
  fires the closed-loop
  `MetricStudioHook.on_metric_promotion` hook.
  `RubricJudge.score()` runs the v1.4 opt-in gate
  (`_check_auto_judge_policy`) FIRST; if the gate
  returns `False`, the score is suppressed and the
  audit log records `status="scored"` with
  `score=None` and a clear `reason` — never silently
  bills.
* **`CustomMetricRegistry`** (`registry.py`) — the
  per-tenant metric store (Galileo "metric store"
  parity). Backed by `organizations.features.custom_metrics`
  JSONB (no new table). The `register` method creates a
  metric in `draft` state and wraps the rubric as a
  judge; the `list` method enriches each metric with
  30-day score stats (`n_scores_30d` + `median_score`)
  computed on the fly from `custom_metric_runs`; the
  `approve` method (admin-only at the route layer)
  promotes `draft` → `production` and re-fires the
  hook.
* **`MetricStudioHook`** (`promotion_hooks.py`) —
  Cat 17b closed-loop wiring. Stub no-op in v1.3;
  becomes actionable in v1.4 (Cat 3 judge regression
  auto-rolls back a promoted custom metric).

Plus the existing building blocks Cat 21 reuses
without modification:

* `src/eden/llmops/judges/registry.py` — `JudgeRegistry`
  + `Judge` base class. `RubricJudge` is a clean
  subclass.
* `src/eden/llmops/judges/builtin_v9.py` — the 7
  baseline + 3 Galileo Luna-2 judges. The rubric
  templates + synthesised rubrics compete with these
  off-the-shelf judges.
* `src/eden/llm/client.py` — `OpenRouterClient`. The
  `RubricSynthesiser` calls `client.call(slot="fast")`
  to generate the rubric.
* `src/eden/llmops/judges/base.py` — `JudgeContext` +
  `JudgeScore` (Cat 3). The re-usable types for the
  per-criterion score.
* `src/eden/llmops/promotion_hooks.py` — the existing
  5 closed-loop hooks (Cat 17). Cat 21 extends with
  `MetricStudioHook` (Cat 17b).

**Migration:** `src/eden/db_migrations/versions/021_custom_metric_studio.py`
adds the `custom_metric_runs` table (id UUID PK,
org_id, metric_id, metric_name, judge_name, score,
threshold, passed, synthesised_rubric, rubric_tokens,
domain, trace_id, examples_json, result_json, status,
approval_status, approved_by, approved_at,
rejection_reason, created_at) with the standard
`idx_<name>_org` time-series index and a secondary
`(org_id, trace_id)` index for the per-trace debugging
workflow. Per-metric versioning lives in
`organizations.features.custom_metrics` (no schema
change needed).

## Feature inventory

| Service | File | Routes | Effort |
|---|---|---|---|
| `RubricTemplateLibrary.list` | `src/eden/metric_studio/templates.py` | 1 | S |
| `RubricSynthesiser.from_examples` | `src/eden/metric_studio/synthesiser.py` | 1 | L |
| `JudgeFactory.wrap_rubric_as_judge` | `src/eden/metric_studio/judge_factory.py` | 1 | M |
| `CustomMetricRegistry.register` | `src/eden/metric_studio/registry.py` | 2 | M |
| **v2 additions (SLM Initiative, weeks 9-12):** | | | |
| `JudgeFactory.wrap_lora_as_judge` | `src/eden/metric_studio/lora_judge.py` | 1 | M |
| `PerTenantLoRAFineTuner.train` | `src/eden/metric_studio/finetune.py` | 1 | L |
| `RubricValidator.validate` (quality gate) | `src/eden/metric_studio/validator.py` | 1 | M |

**v1.3 surface:** 4 services, 5 routes. **v2 surface:**
7 services, 7 routes. v2 ships the per-tenant LoRA
fine-tuner (the v1.4 SLM Initiative integration).

## API contracts

### `GET /orgs/{org_id}/intelligence/metric-studio/templates`

```json
→ {
    "data": {
      "templates": [
        { "id": "anthropic_harm_v1", "domain": "safety", "name": "Anthropic Harm (v1)",
          "criteria_count": 6, "version": "1.0" },
        { "id": "pii_leak_v2", "domain": "compliance", "name": "PII Leak Detection (v2)",
          "criteria_count": 4, "version": "2.0" },
        { "id": "brand_voice_v3", "domain": "marketing", "name": "Brand Voice Adherence (v3)",
          "criteria_count": 8, "version": "3.0" }
        // 50+ templates
      ]
    }
  }
```

### `POST /orgs/{org_id}/intelligence/metric-studio/from-examples`

The headline.

```json
body: {
  "name": "Policy Compliance",
  "examples": [
    { "input": "...", "output": "...", "label": "compliant", "rationale": "..." },
    { "input": "...", "output": "...", "label": "violating", "rationale": "..." }
    // 2-5 examples
  ],
  "domain": "legal"
}
→ {
    "data": {
      "rubric_id": "rubric_abc",
      "rubric_prompt": "You are evaluating a legal-policy-compliance metric. Score the response on a 0-1 scale.\n\nCriteria:\n- Does the response avoid giving specific legal advice? (weight 0.4)\n- Does the response cite relevant policy clauses? (weight 0.3)\n- Does the response include the required disclaimers? (weight 0.3)\n\nInput: <input>\nResponse: <output>\n\nReturn JSON: {\"score\": <float>, \"rationale\": \"<one sentence>\"}",
      "rubric_tokens": 142,
      "approval_required": true,
      "approval_url": "/intelligence/metric-studio/metrics/rubric_abc/approve"
    }
  }
```

### `POST /orgs/{org_id}/intelligence/metric-studio/metrics`

```json
body: {
  "name": "Policy Compliance v1",
  "rubric_id": "rubric_abc",
  "version": "1.0",
  "status": "production"  // draft|production|deprecated
}
→ {
    "data": {
      "metric_id": "metric_xyz",
      "name": "Policy Compliance v1",
      "rubric_id": "rubric_abc",
      "version": "1.0",
      "status": "production",
      "judge_id": "luna_policy_compliance_v1"  // registered in Cat 3 JudgeRegistry
    }
  }
```

### `GET /orgs/{org_id}/intelligence/metric-studio/metrics`

```json
→ {
    "data": {
      "metrics": [
        { "metric_id": "metric_xyz", "name": "Policy Compliance v1",
          "rubric_id": "rubric_abc", "version": "1.0", "status": "production",
          "n_scores_30d": 12453, "median_score": 0.84 },
        { "metric_id": "metric_def", "name": "Brand Voice v1",
          "rubric_id": "rubric_def", "version": "1.0", "status": "draft",
          "n_scores_30d": 0, "median_score": null }
      ]
    }
  }
```

### `POST /orgs/{org_id}/intelligence/metric-studio/metrics/{metric_id}/approve`

The human-in-the-loop gate. The user reviews the
synthesised rubric and approves before it becomes a
production judge.

```json
body: { "approved_by": "u_123" }
→ { "data": { "metric_id": "metric_xyz", "status": "production" } }
```

## Data model

```sql
-- 1. Custom metric runs (the rubric-synthesis audit log)
CREATE TABLE custom_metric_runs (
    id                      UUID PRIMARY KEY,
    org_id                  VARCHAR(128) NOT NULL,
    run_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    examples_json          TEXT NOT NULL,  -- the input examples
    synthesised_rubric      TEXT,  -- the generated rubric (NULL if generation failed)
    rubric_tokens          INT,
    domain                  VARCHAR(64),
    approval_status        VARCHAR(16) NOT NULL DEFAULT 'pending',  -- pending|approved|rejected
    approved_by            VARCHAR(128),
    approved_at            TIMESTAMPTZ,
    rejection_reason       TEXT
);
CREATE INDEX idx_custom_metric_runs
    ON custom_metric_runs (org_id, run_at DESC);

-- 2. Per-org metric registry (in organizations.features JSONB; no new table)
-- The rubric_id and the judge_id are stored as:
-- organizations.features.custom_metrics : [
--   {
--     "metric_id": "metric_xyz",
--     "name": "Policy Compliance v1",
--     "rubric_id": "rubric_abc",
--     "version": "1.0",
--     "status": "production",
--     "judge_id": "luna_policy_compliance_v1",
--     "created_at": "...",
--     "n_scores_30d": 12453
--   }
-- ]
```

### v2 additions (SLM Initiative, weeks 9-12):

```sql
-- 3. Per-tenant LoRA fine-tune jobs (SLM Initiative)
CREATE TABLE custom_metric_lora_jobs (
    id                  UUID PRIMARY KEY,
    org_id              VARCHAR(128) NOT NULL,
    metric_id           VARCHAR(128) NOT NULL,
    base_model          VARCHAR(64) NOT NULL DEFAULT 'qwen3.5-4b',
    training_data_json  TEXT NOT NULL,  -- the labelled examples
    training_started_at TIMESTAMPTZ,
    training_completed_at TIMESTAMPTZ,
    lora_weights_path   TEXT,  -- the output LoRA weights
    status              VARCHAR(16) NOT NULL DEFAULT 'pending',  -- pending|training|completed|failed
    metrics_json        TEXT,  -- {"train_loss": 0.32, "val_accuracy": 0.94}
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Algorithm / pseudo-code

### `RubricSynthesiser.from_examples` (the headline)

```python
async def from_examples(org_id, name, examples, domain=None):
    # 1. Validate
    if not 2 <= len(examples) <= 5:
        raise ValueError("2-5 examples required")
    for ex in examples:
        if not all(k in ex for k in ("input", "output", "label", "rationale")):
            raise ValueError(f"example missing required field: {ex.keys()}")
    # 2. Use the cheapest LLM (Haiku-class) to generate the rubric
    rubric_prompt = SYNTHESIS_PROMPT.format(
        domain=domain or "general",
        name=name,
        examples=json.dumps(examples, indent=2),
    )
    rubric_text = await OpenRouterClient.complete(
        model="anthropic/claude-haiku-4",
        messages=[{"role": "user", "content": rubric_prompt}],
        max_tokens=1500,
    )
    # 3. Cap at 1,500 tokens (mitigates the "rubric prompt blowout" risk)
    if len(tokenize(rubric_text)) > 1500:
        rubric_text = truncate_to_tokens(rubric_text, 1500)
    # 4. Persist (status=pending; user must approve)
    rubric_id = f"rubric_{uuid4()}"
    await db.insert_custom_metric_run(
        org_id, rubric_id, examples, rubric_text, len(tokenize(rubric_text)),
        domain, status="pending",
    )
    return {"rubric_id": rubric_id, "rubric_prompt": rubric_text, "approval_url": f"..."}
```

### `JudgeFactory.wrap_rubric_as_judge`

```python
def wrap_rubric_as_judge(rubric_id, name, version, model="anthropic/claude-sonnet-4"):
    """Register the rubric as a Judge in the Cat 3 JudgeRegistry."""
    rubric = db.get_custom_metric_run(rubric_id)
    judge = RubricJudge(
        name=name,
        version=version,
        rubric_prompt=rubric.synthesised_rubric,
        model=model,
    )
    JudgeRegistry.instance().register(judge)
    return judge
```

### `CustomMetricRegistry.register` (the per-org registry)

```python
async def register(org_id, name, rubric_id, version, status):
    if status == "production":
        # 1. Wrap the rubric as a Judge
        judge_id = f"org_{org_id}_{name}_v{version}"
        wrap_rubric_as_judge(rubric_id, name, version)
        # 2. Update the org's features
        current = await db.get_organization_features(org_id)
        custom_metrics = current.get("custom_metrics", [])
        custom_metrics.append({
            "metric_id": judge_id, "name": name, "rubric_id": rubric_id,
            "version": version, "status": status, "judge_id": judge_id,
            "created_at": now().isoformat(),
        })
        await db.update_organization_features(org_id, {"custom_metrics": custom_metrics})
        # 3. Fire the closed-loop hook
        await MetricStudioHook.on_metric_promotion(org_id, judge_id)
    return judge_id
```

## Failure modes & guardrails

| Mode | Mitigation |
|---|---|
| Rubric prompt blowout (>1,500 tokens) | The synthesiser caps at 1,500 tokens; `CustomMetricRegistry.register` rejects longer rubrics with HTTP 400 |
| Synthesised rubric is low quality | The `RubricValidator.validate` (v2) runs the rubric against the user's 5 examples + 5 holdout examples; if F1 < 0.7, the user is warned |
| User clicks "Approve" without reading the rubric | The portal requires scrolling through the rubric before the Approve button is enabled (defensive UX) |
| LLM judge call blows the tenant budget | Per-org `TenantBudget` (Cat 9); the LLM-as-judge opt-in policy is OFF by default; auto-judge is per-tenant opt-in |
| Custom metric duplicates an off-the-shelf judge | The portal suggests existing judges from the Cat 3 baseline + 3 Galileo set before showing the synthesised rubric |
| Per-tenant LoRA training (v2) is expensive | Per-org budget cap; the SLM Initiative ships with a default $20 training cap per metric |
| LoRA weights leak across tenants (v2) | The vLLM `--lora-modules` config isolates per-tenant LoRAs; the `CustomMetricRegistry` enforces the isolation |

## Telemetry

* `intelligence_metric_studio_synthesise` (counter, tagged by `domain`)
* `intelligence_metric_studio_approve` (counter, tagged by `outcome`)
* `intelligence_metric_studio_reject` (counter, tagged by `reason`)
* `intelligence_metric_studio_score` (counter, tagged by `metric_id`)
* `intelligence_metric_studio_lora_train` (counter, v2)

## Test plan

* `RubricSynthesiser.from_examples` generates a
  rubric that scores 5 hand-labelled examples with
  ≥ 0.75 F1 vs the ground truth
* `RubricSynthesiser.from_examples` enforces the
  1,500-token cap
* `JudgeFactory.wrap_rubric_as_judge` registers the
  judge in the Cat 3 `JudgeRegistry`
* `CustomMetricRegistry.register` produces the correct
  audit log entry
* The opt-in policy: LLM-as-judge is OFF by default;
  the user must explicitly enable it
* The LLM-as-judge budget check: auto-judge is
  disabled when the daily budget is exhausted
* RLS: a different org's metric is never returned
* The closed-loop hook fires on metric promotion
* v2: per-tenant LoRA training completes in < 4 hours

Target: **~20 tests, ~0.8s.**

## Acceptance criteria

- [x] All 4 v1.3 services implemented (v2 SLM services
  deferred to the separate `eden-judge-v2-plan.md`)
- [x] 1,500-token cap enforced (verified by
  `test_token_cap_enforced`)
- [x] Judge registered in global `JudgeRegistry`
  (verified by `test_wrap_rubric_registers_in_judge_registry`)
- [x] LLM-as-judge OFF by default; per-tenant opt-in works
  (verified by `test_no_features_returns_not_opted_in` +
  `test_metric_opted_in_returns_allowed`)
- [x] Budget check disables auto-judge when exhausted
  (`_check_auto_judge_policy` returns
  `("daily_budget_exceeded", ...)` when the daily
  budget is set and today's spend exceeds it)
- [x] Closed-loop hook fires on metric promotion
  (verified by `test_approve_promotes_draft_to_production`
  + `test_hook_fires_on_promotion`)
- [x] All 41 tests pass
- [x] RLS — the metric store lives in
  `organizations.features` which is org-scoped by
  RLS via the existing `set_session_org_context` GUC
  (Phase 7.3e).

## Open questions

* **Approval UX** — modal vs dedicated page? **Recommendation:
  modal with the rubric expanded; the Approve button
  requires scrolling first.** (Owner: Cat 21 lead)
* **Rubric quality gate** — `RubricValidator.validate`
  (v2) on 5 holdout examples. **Recommendation: ship
  in v2 with F1 < 0.7 warning.** (Owner: Cat 21 lead)
* **Per-tenant LoRA budget** — $20 default per metric.
  **Recommendation: configurable per org in
  `organizations.features`.** (Owner: Cat 21 lead)
* **Cross-team metric sharing** — should team A's
  metrics be discoverable by team B? **Recommendation:
  opt-in metadata flag; v0 ships single-team; v2
  ships cross-team library.** (Owner: Cat 21 lead)

## Cross-references

* Master doc: [`eden-observability-gap-roadmap.md`](../eden-observability-gap-roadmap.md) § Cat 21
* JudgeRegistry (the destination):
  [`src/eden/llmops/judges/registry.py`](../../src/eden/llmops/judges/registry.py)
* Builtin judges (the existing 7 + 3 Luna-2):
  [`src/eden/llmops/judges/builtin_v9.py`](../../src/eden/llmops/judges/builtin_v9.py)
* Cat 3 (the LLM-as-judge opt-in policy):
  [`03-evaluation-quality-intelligence.md`](./03-evaluation-quality-intelligence.md)
* Cat 17 (closed-loop — `MetricStudioHook.on_metric_promotion`):
  [`17-closed-loop-wiring.md`](./17-closed-loop-wiring.md)
* SLM Initiative (the v1.4 plan for per-tenant LoRA):
  [`../eden-judge-v2-plan.md`](../eden-judge-v2-plan.md)
* Research: Braintrust generate-scorer; Langfuse
  custom Python evaluators; Galileo CLHF; OpenRS Open
  Rubric; Microsoft LLM-Rubric (ACL 2024)

## Verification checklist (v1.3 implementation, 2026-06-11)

- [x] **Build green:** `python -c "from eden.metric_studio
  import RubricTemplateLibrary, RubricSynthesiser,
  JudgeFactory, CustomMetricRegistry"` succeeds.
- [x] **App loads with the new router:** `from eden.api.app
  import app` succeeds; 6 new Cat 21 routes registered
  under `/orgs/{org_id}/intelligence/metric-studio`.
- [x] **Migration applies:** migration 021 creates
  `custom_metric_runs` with the standard
  `idx_custom_metric_runs_org (org_id, created_at DESC)`
  + `idx_custom_metric_runs_trace (org_id, trace_id)`
  indexes; downgrade drops both indexes + the table.
- [x] **Tests pass:** `pytest tests/intelligence/
  test_metric_studio.py -v` → 41 / 41 pass in ~1.1s.
- [x] **No regressions:** full `tests/intelligence/`
  → 423 passed, 1 skipped, 0 failed in ~3.5s.
- [x] **Lint clean:** all module imports verified; the
  `__init__.py` lazy-re-export pattern works (verified
  by `test_cold_import_does_not_load_synthesiser`).
- [x] **Feature flag works:** all 6 Cat 21 routes are
  gated by the `intelligence_gap_v0` umbrella flag
  + `get_current_user`; the admin-only
  `/metrics/{metric_id}/approve` route is additionally
  gated by `require_org_admin`.
- [x] **LLM-as-judge opt-in OFF by default:** the
  `_check_auto_judge_policy` gate returns
  `(False, "metric_not_opted_in")` when an org has no
  `auto_judge_policy` in its `organizations.features`.
  The `RubricJudge.score()` method calls the gate FIRST
  and returns `score=None` + a `no_score:` rationale
  when the gate denies — never silently bills.
- [x] **Closed-loop hook fires on promotion:** the
  `MetricStudioHook.on_metric_promotion` hook fires
  from BOTH `JudgeFactory.wrap_rubric_as_judge` (at
  registration) AND `CustomMetricRegistry.approve`
  (on draft→production). Stub no-op logger in v1.3;
  becomes actionable in v1.4 (Cat 3 judge regression
  auto-rolls back a promoted custom metric).
- [x] **Audit log completeness:** every scoring
  invocation of `RubricJudge.score()` writes a row to
  `custom_metric_runs` with `status="scored"`,
  `score`, `judge_name`, `metric_id`, `trace_id`, and
  the LLM result envelope — even when the opt-in gate
  denies (the row's `score` is `NULL` and the
  `result_json` carries the `reason`).
- [x] **Token cap enforced:** the synthesiser caps the
  rubric at 1,500 tokens (≈ 6,000 chars). Verified by
  `test_token_cap_enforced` which feeds a 10,000-char
  response and asserts the persisted rubric is
  ≤ 6,000 chars + `rubric_tokens ≤ 1,500`.

**Net code change for Cat 21:**

9 new files in `src/eden/metric_studio/` (~58 KB),
1 new migration (`021_custom_metric_studio.py`,
~120 lines), 1 new router
(`intelligence_metric_studio.py`, 6 routes, ~210
lines), 1 new test file (`test_metric_studio.py`,
~700 lines / 41 tests), 1 modified router mount
block in `app.py` (2 lines), 1 new hook class in
`promotion_hooks.py` (~30 lines). Total: 13 files,
~88 KB net code, 41 tests, 0 regressions. Closed-loop
wiring demonstrated end-to-end.

**Why this ships in 1 day:** the v1.3 surface is
intentionally minimal — rubric + LLM-as-judge, no
fine-tuning. The Luna-Studio SLM-as-judge path
(per-tenant LoRA fine-tuner) is a separate deferred
initiative tracked at `docs/eden-judge-v2-plan.md`.
The v1.3 cat ships in 1 day because the
synthesiser + judge + registry + hook pattern is the
same shape as Cat 16's decision package; the
`organizations.features` JSONB column means no new
table for the metric store.
