---
title: "17 — Closed-Loop Wiring (operational)"
status: ✅ IMPLEMENTED v1 (advisory hooks; fire from Cat 2/3/4/8/9/10/13 — fired-logged, no auto-side-effects)
last_updated: 2026-06-12
version: 1.2
---

# 17 — Closed-Loop Wiring (operational)

> **Status:** STUB v0 (hooks). The 5 v0 hooks +
> 4 v1.3b/v1.4 hooks in `src/eden/llmops/promotion_hooks.py`
> are no-op loggers. They become **active** as each cat
> ships its real implementation. **This is the cat that
> makes Eden an automation platform, not just an
> observability platform.** Per Article 1: "Most
> platforms detect problems; very few solve them."

## Table of Contents

1. [Goal & motivation](#goal--motivation)
2. [Source articles](#source-articles)
3. [What's already in Eden](#whats-already-in-eden)
4. [The 5 v0 + 4 v1.3b hooks](#the-5-v0--4-v13b-hooks)
5. [Wiring model](#wiring-model)
6. [Data model](#data-model)
7. [Hook implementation patterns](#hook-implementation-patterns)
8. [Failure modes & guardrails](#failure-modes--guardrails)
9. [Telemetry](#telemetry)
10. [Test plan](#test-plan)
11. [Acceptance criteria](#acceptance-criteria)
12. [Open questions](#open-questions)
13. [Cross-references](#cross-references)

## Goal & motivation

The closed loop is what makes Eden an **automation**
platform, not just an observability platform. The hooks
fire from the event stream, do the right thing, and
record what they did. The 5 v0 hooks cover the standard
"Observation → Evaluation → Optimization → Automation"
chain. The 4 v1.3b/v1.4 hooks cover the new surfaces
(DSL linter, columnar compaction, custom-metric studio,
auto-judge budget).

The user story:

> "I just deployed a new prompt version. 30 minutes
> later, the drift detector fires. The closed-loop
> hook automatically rolls back the canary. The judge
> detector fires. The hook automatically blocks the next
> deployment until a human reviews. I never had to be
> woken up at 3am."

## Source articles

* **Article 1 §17 (Closed-Loop Optimization)**: "Most
  platforms detect problems; very few solve them.
  Closed-loop optimization is the chain
  Observation → Evaluation → Attribution → Optimization →
  Automation."
* **Galileo eval-to-guardrail lifecycle** — the
  reference for `GuardrailHook.on_judge_threshold_breach`.
* **Braintrust auto-rollback on regression** — the
  reference for `PromotionHook.on_judge_regression`.

## What's already in Eden

* `src/eden/llmops/promotion_hooks.py` — the hook
  singletons. v0 logs only; v5 (Phase 5) wires them
  to do real work.
* `src/eden/llmops/promotion.py` — `PromotionLoop`
  (existing canary-deploy mechanism). The
  `PromotionHook.on_judge_regression` calls
  `PromotionLoop.rollback(canary_id)`.
* `src/eden/llmops/production_monitor.py` —
  `ProductionMonitor` (existing). Subscribes to judge
  scores and emits the events the hooks consume.
* `src/eden/observability/alerts.py` (Cat 0) — the
  existing `AnomalyAlert` infrastructure. The hooks
  reuse this for alert delivery.
* `org_audit_log` — every hook action is audit-logged.
* `JudgeRegistry` (Cat 3) — the hook
  `on_judge_threshold_breach` reads the registry to
  find the judge to promote.

## The 5 v0 + 4 v1.3b/v1.4 hooks

| Hook | Cat | Event source | Action |
|---|---|---|---|
| `PromotionHook.on_judge_regression` | 3, 8, 16 | `JudgeRunner.on_score` (score < baseline by >5%) | Call `PromotionLoop.rollback(canary_id)`; require human approval for re-promote |
| `PromotionHook.on_judge_improvement` | 3, 8, 16 | `JudgeRunner.on_score` (score > baseline by >3% for 24h) | Auto-suggest canary bump to 50%; require human approval for full 100% |
| `PromotionHook.on_drift_alert` | 2, 8, 13 | `DriftDetector.on_alert` (PSI > 0.2) | Call `PromotionLoop.rollback(canary_id)`; page on-call if `severity = critical` |
| `GuardrailHook.on_judge_threshold_breach` | 3, 15 | `JudgeRunner.on_score` (judge reliably below threshold for 7d) | Promote the judge to a production guardrail (Galileo eval-to-guardrail lifecycle); write to `guardrail_policies` |
| `GuardrailHook.on_judge_below_floor` | 3, 15 | `JudgeRunner.on_score` (promoted guardrail is now too noisy) | Auto-disable the guardrail; alert the org admin |
| `ExperimentHook.on_winner` | 12 | `ExperimentWinnerDetector.on_winner` (Bayesian posterior > 0.95) | Archive the losing variant; reallocate 100% traffic to winner |
| `DSLHook.on_alert_lint_warning` (v1.3b) | 19 | `EQLLinter.on_lint` (warning severity) | Surface the warning to the DSL Alert Editor; `strict` mode blocks deployment |
| `ColumnarHook.on_compaction_drift` (v1.3b) | 18 | `ColumnarCompactor.on_sla_breach` (compaction lag > 4h) | Send a Cat 9 alert; trigger an out-of-band compaction |
| `MetricStudioHook.on_metric_promotion` (v1.3b) | 21 | `CustomMetricRegistry.register` (metric promoted to `production`) | Wire the metric into the Cat 3 `JudgeRegistry`; fire on subsequent regressions |
| `JudgeBudgetHook.on_auto_judge_budget_exceeded` (v1.4) | 3, 9 | `UsageService.on_cost_threshold` (auto-judge budget exhausted) | Auto-disable auto-judge for the org; alert the org admin |

**Total: 9 hooks. v0 ships the first 5; v1.3b/v1.4
adds 4 more.**

## Wiring model

The hooks are **singletons** that subscribe to events
from across the system. The wiring pattern:

```python
# src/eden/llmops/promotion_hooks.py
class PromotionHook:
    _instance = None

    def __init__(self):
        self._subscribers = []
        self._enabled = False  # becomes True in Phase 5

    @classmethod
    def instance(cls):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def subscribe(self, event_type, handler):
        self._subscribers.append((event_type, handler))

    async def on_judge_regression(self, judge_name, score, baseline, **ctx):
        if not self._enabled:
            logger.debug(f"[hook-stub] on_judge_regression: {judge_name} {score} vs {baseline}")
            return
        # Real implementation (Phase 5)
        canary_id = ctx.get("canary_id")
        if canary_id and score < baseline * 0.95:
            await PromotionLoop.instance().rollback(canary_id)
            await org_audit_log.record(org_id=ctx["org_id"],
                                      action="promotion.rollback",
                                      actor="system:hook",
                                      target=canary_id,
                                      after_state={"judge": judge_name, "score": score})
```

`register_all_hooks()` is called from the lifespan in
`src/eden/api/app.py`. In stub mode it just registers
the subscribers; in Phase 5 it sets `_enabled = True`
and the hooks do real work.

## Data model

The hooks themselves don't own tables — they read from
existing tables and write to existing tables. The
audit log is the existing `org_audit_log`. The
`guardrail_policies` (Cat 15) is the destination for
the eval-to-guardrail hook. The `experiment_traffic_splits`
(Cat 12) is the destination for the winner-detection
hook.

```sql
-- Hook actions land in org_audit_log with a structured
-- "action" prefix:
--
-- promotion.rollback (from on_judge_regression / on_drift_alert)
-- promotion.advance (from on_judge_improvement)
-- guardrail.promote  (from on_judge_threshold_breach)
-- guardrail.disable  (from on_judge_below_floor)
-- experiment.archive_loser (from on_winner)
-- judge.auto_disable (from on_auto_judge_budget_exceeded)
--
-- This is implemented as a sub-action namespace in the
-- existing org_audit_log.action column.
```

## Hook implementation patterns

### Pattern A: read event → call service → audit log

```python
async def on_judge_regression(self, judge_name, score, baseline, **ctx):
    if not self._enabled: return
    canary_id = ctx.get("canary_id")
    if not canary_id: return
    if score >= baseline * 0.95: return  # not a regression
    # 1. Roll back
    await PromotionLoop.instance().rollback(canary_id)
    # 2. Audit
    await org_audit_log.record(
        org_id=ctx["org_id"],
        action="promotion.rollback",
        actor="system:hook:on_judge_regression",
        target=canary_id,
        before_state={"judge": judge_name, "score": baseline},
        after_state={"judge": judge_name, "score": score},
    )
    # 3. Alert the on-call (Cat 8 anomaly_alerts)
    await AnomalyAlerts.instance().fire(
        org_id=ctx["org_id"],
        type="judge_regression_rollback",
        severity="high",
        target=canary_id,
        summary=f"Judge {judge_name} regressed {1 - score/baseline:.1%}; auto-rolled back canary",
    )
```

### Pattern B: read event → promote judge to guardrail

```python
async def on_judge_threshold_breach(self, judge_name, breach_count, **ctx):
    if not self._enabled: return
    if breach_count < 7: return  # not a sustained breach
    # 1. Create a guardrail policy from the judge
    policy = GuardrailPolicy(
        org_id=ctx["org_id"],
        name=f"auto_promoted_{judge_name}",
        judge_name=judge_name,
        threshold=ctx.get("threshold", 0.5),
        verdict_on_breach="block",
        created_by="system:hook:on_judge_threshold_breach",
    )
    await db.insert_guardrail_policy(policy)
    # 2. Audit
    await org_audit_log.record(
        org_id=ctx["org_id"],
        action="guardrail.promote",
        actor="system:hook:on_judge_threshold_breach",
        target=judge_name,
        before_state={"status": "judge"},
        after_state={"status": "guardrail", "policy_id": policy.id},
    )
```

### Pattern C: read event → kill auto-judge (v1.4 LLM-as-judge opt-in)

```python
async def on_auto_judge_budget_exceeded(self, org_id, judge_name, **ctx):
    if not self._enabled: return
    # 1. Auto-disable the auto-judge for this org
    await db.update_organization_features(
        org_id=org_id,
        features={f"auto_judge_{judge_name}": False, "auto_judge_disabled_at": now()},
    )
    # 2. Audit
    await org_audit_log.record(
        org_id=org_id,
        action="judge.auto_disable",
        actor="system:hook:on_auto_judge_budget_exceeded",
        target=judge_name,
        rationale="auto-judge daily budget exhausted",
    )
    # 3. Alert the org admin
    await AnomalyAlerts.instance().fire(
        org_id=org_id,
        type="auto_judge_budget_exhausted",
        severity="high",
        target=judge_name,
        summary=f"Auto-judge for {judge_name} disabled — daily budget exhausted",
    )
```

## Failure modes & guardrails

| Mode | Mitigation |
|---|---|
| Hook fires on a false-positive drift signal | The rollback is reversible; the org_admin re-promotes in < 5 minutes; the false-positive rate is tracked in the Cat 13 drift dashboard |
| Hook cascade (drift → rollback → judge regresses from rollback → drift → ...) | Hooks have a debounce window (5 minutes for drift, 1 hour for judge regression); the same event doesn't fire twice in the window |
| Hook fails to fire (subscription missed) | The audit log records every hook attempt; the `PromotionLoop` records every rollback; a separate watchdog cron (`watchdog_scan_unprocessed_events`) runs hourly and fires any missed hook |
| Hook fires on a destructive action by accident | All destructive actions (`promotion.rollback`, `guardrail.disable`, `judge.auto_disable`) require the org_admin to manually re-apply; the audit log records the action with the hook name |
| Hook is too aggressive (rolls back on every 1% dip) | The hook reads the threshold from `organizations.features.promotion_hook_thresholds`; default 5% regression for rollback, 3% improvement for advance |
| Hook is too lax (never fires) | The Cat 13 risk score is computed daily; a high risk score + zero hook firings in 7 days = a separate alert |

## Telemetry

* `intelligence_hook_fired` (counter, tagged by `hook` and `action`)
* `intelligence_hook_disabled_due_to_cascade` (counter, tagged by `hook`)
* `intelligence_hook_missed_event` (counter — should always be 0; the watchdog cron fires if > 0)
* `intelligence_hook_reversible_rollback` (counter, tagged by `org_id`)

## Test plan

* Each hook fires from its event source correctly
* Each hook is idempotent (same event twice = one
  action, two audit log entries)
* Each hook's audit log entry is well-formed
* The cascade debounce works (same event in 5 min
  fires once)
* The watchdog cron catches a missed event
* Disabled state (`_enabled = False`) prevents any
  real work
* RLS: a different org's event doesn't trigger this
  org's hook

Target: **~15 tests, ~0.5s.**

## Acceptance criteria

- [ ] All 9 hooks (5 v0 + 4 v1.3b/v1.4) implemented
- [ ] Each hook is idempotent
- [ ] Each hook writes a well-formed audit log entry
- [ ] Cascade debounce works
- [ ] Watchdog cron catches missed events
- [ ] Disabled state prevents real work
- [ ] All 15 tests pass
- [ ] RLS verified

## Open questions

* **Hook ordering** — what if `on_judge_regression` and
  `on_drift_alert` both fire on the same incident?
  **Recommendation: `on_drift_alert` wins (broader
  signal); `on_judge_regression` is skipped if the
  same `canary_id` was rolled back in the last 5 min.**
  (Owner: Platform team)
* **Hook thresholds** — are the 5% / 3% defaults right?
  **Recommendation: ship defaults; expose per-hook
  thresholds in `organizations.features`.** (Owner:
  Platform team)
* **Hook cascade detection** — beyond a simple 5-min
  debounce, should we detect true cycles? **Recommendation:
  v0 is fine with debounce; v2.1 ships cycle detection
  via a per-hook action-graph.** (Owner: Platform team)

## Cross-references

* Master doc: [`eden-observability-gap-roadmap.md`](../eden-observability-gap-roadmap.md) § Cat 17
* Hook file: [`src/eden/llmops/promotion_hooks.py`](../../src/eden/llmops/promotion_hooks.py)
* Promotion loop (the `rollback` callee):
  [`src/eden/llmops/promotion.py`](../../src/eden/llmops/promotion.py)
* Production monitor (the event source):
  [`src/eden/llmops/production_monitor.py`](../../src/eden/llmops/production_monitor.py)
* Cat 3 (judge — the `on_judge_regression` event
  source): [`03-evaluation-quality-intelligence.md`](./03-evaluation-quality-intelligence.md)
* Cat 2 (RCA — the `on_drift_alert` event source):
  [`02-root-cause-incidents.md`](./02-root-cause-incidents.md)
* Cat 13 (Predictive — the CUSUM event source):
  [`13-predictive-intelligence.md`](./13-predictive-intelligence.md)
* Cat 15 (Guardrails — the `on_judge_threshold_breach`
  destination): [`15-runtime-protection-guardrails.md`](./15-runtime-protection-guardrails.md)
* Cat 12 (Experiment — the `on_winner` source):
  [`12-experimentation-intelligence.md`](./12-experimentation-intelligence.md)
* Cat 18 (Columnar — the `on_compaction_drift`
  source, v1.3b): [`18-query-performance.md`](./18-query-performance.md)
* Cat 19 (EQL — the `on_alert_lint_warning` source,
  v1.3b): [`19-trace-query-dsl.md`](./19-trace-query-dsl.md)
* Cat 21 (Custom-Metric — the `on_metric_promotion`
  source, v1.3b): [`21-custom-metric-studio.md`](./21-custom-metric-studio.md)
* v1.4 LLM-as-judge opt-in policy (the
  `on_auto_judge_budget_exceeded` source):
  master doc § Conventions > LLM-as-judge opt-in policy
