# N04: Agent Change Impact Preview

| Field | Value |
|---|---|
| **Feature ID** | N04 |
| **Slug** | `agent-change-impact-preview` |
| **Priority** | P1 |
| **Effort** | L |
| **Eden status** | **MISSING** |
| **Market hypothesis** | "What breaks if I ship this prompt?" — top pre-deploy anxiety for agent teams |
| **Dependencies** | F01 (cached rerun), N01 (regression evals), F44, Cat 20 time-travel, N22, F41 |

---

## 1. Summary

Unified **Change Impact Report** before merge: detect agent config diffs in PRs, replay stratified production traces with cached-prefix debugger (F01), run regression evals (N01), diff trajectories and cost, and post results to PR + MCP. Combines Eden-unique capabilities competitors lack in one pre-deploy gate — essential for both **operator-led** and **autonomous** promotion (N20 T4 auto-merge requires N04 pass).

---

## 2. Eden current state

| Shipped | Path | Gap |
|---|---|---|
| Cached-prefix debugger | F01 spec | Not wired to CI |
| Eval runner | `evaluation/` | No PR-triggered orchestration |
| Experiments | `intelligence_experiments.py` | No change-impact report schema |
| GitHub App | partial (F22) | No config-change webhook |
| Time-travel replay | Cat 20 | Not integrated |

**Missing:** `src/eden/change_impact/preview.py`, `ChangeDetector`, `TrajectoryDiffer`.

---

## 3. Target behavior

### 3.1 Operator flow

```
Engineer opens PR changing prompts/checkout.yaml
    → Eden webhook detects agent config change
    → Impact Preview job enqueued:
        1. Select N production traces (stratified: recent, high-cost, past issues)
        2. Cached-prefix rerun (F01) with new config on each
        3. Run regression eval suite (N01)
        4. Diff trajectories + cost + stumble predictions (StatGate)
    → Post PR comment + GitHub Check Run
    → Optional: block merge if regression fails (branch protection)
    → N17 "Verify" column shows report link
```

### 3.2 Autonomous flow (N20 T4 / N22)

```
N22.may(run_impact_preview) == allow
    → Same job as above
    → If report.recommendation == 'auto_merge_safe':
        AND N01 pass AND StatGate pass
        → N20 auto-merge PR (T4 sandbox only)
    → Else: N17 "Proposed" card with divergence highlights
```

---

## 4. Impact report schema

```json
{
  "change_id": "pr-4821",
  "agent_id": "checkout-agent",
  "change_summary": {
    "files": ["prompts/checkout.yaml"],
    "prompt_version_delta": "v11 → v12",
    "model_delta": null
  },
  "traces_replayed": 50,
  "trajectory_divergence_rate": 0.12,
  "new_predicted_stumbles": 3,
  "cost_delta_pct": -0.08,
  "latency_delta_pct": 0.02,
  "regression_eval": {
    "passed": 47,
    "failed": 3,
    "failures": [{"case_id": "...", "reason": "loop detected"}]
  },
  "recommendation": "review_required",
  "recommendation_reasons": ["3 regression failures", "12% divergence"],
  "top_divergences": [
    {
      "trace_id": "...",
      "step": 8,
      "summary": "Tool bash invoked 4x vs 1x in baseline",
      "stumble_risk": "loop"
    }
  ],
  "policy_tier": "T2",
  "generated_at": "2026-07-09T12:00:00Z"
}
```

**Recommendation enum:** `safe`, `review_required`, `block`, `auto_merge_safe` (T4 only)

---

## 5. Architecture

| Component | Path | Role |
|---|---|---|
| `ChangeDetector` | `change_impact/detector.py` | GitHub webhook on `prompts/**`, `agent.yaml` |
| `ImpactPreviewOrchestrator` | `change_impact/preview.py` | Job coordinator |
| `TraceSampler` | `change_impact/sampler.py` | Stratified 7d production sample |
| `TrajectoryDiffer` | `change_impact/differ.py` | Step-level diff (F01 reuse) |
| `PRCommenter` | `change_impact/github.py` | Check Run + markdown |
| `ImpactReportStore` | `change_impact/store.py` | Postgres + S3 for large diffs |

**Stratified sampling buckets (default 50 traces):**
- 20 recent (24h)
- 10 high-cost (top decile)
- 10 linked to open/resolved issues (30d)
- 10 random baseline

**Cost control:** Cached prefix → only tail steps re-executed (~40% of full trace cost).

---

## 6. API specification

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/webhooks/github/change-impact` | PR opened/synchronize |
| `GET` | `/orgs/{id}/change-impact/{change_id}` | Fetch report |
| `POST` | `/orgs/{id}/change-impact/preview` | Manual trigger |

**MCP (F04):**

| Tool | Purpose |
|---|---|
| `preview_change_impact` | Manual trigger with config diff or PR ref |
| `get_impact_report` | Fetch report for PR/change_id |

---

## 7. Implementation plan

1. `ChangeDetector` — file path globs, diff agent_id resolution
2. `TraceSampler` + F01 debugger integration
3. N01 regression runner invocation (shared service)
4. `TrajectoryDiffer` — step alignment by tool/message sequence
5. GitHub Check Run + PR comment template
6. N17 Verify column + N06 audit ledger entry
7. N22 policy gate + N20 auto-merge hook

---

## 8. Eden moat (vs Laminar/Raindrop/Bento)

Combines **unique** Eden capabilities in one flow:
- Cached-prefix rerun (F01) — cheap production replay
- StatGate trajectory quality (not just LLM-judge)
- Environment generation (N07) — optional synthetic edge cases from failures
- Evidence-gated promotion (F41)
- Graded autonomy (N22) — same report gates human and auto-merge

---

## 9. Feature flags & rollout

| Flag | Default |
|---|---|
| `change_impact_preview_v1` | off |
| `change_impact_block_merge` | off |
| `change_impact_max_traces` | 50 |

---

## 10. Test plan

- PR touching `prompts/foo.yaml` → job enqueued within 30s
- 50-trace fixture → completes <30min with mocked F01
- Divergence rate matches manual diff on golden trace pair
- Failed N01 → recommendation `block`
- N22 T0 → manual trigger only, no auto-merge

---

## 11. Acceptance criteria

- [ ] PR touching prompt file triggers impact preview within 10 min
- [ ] 50-trace preview completes in <30 min with cached prefix
- [ ] PR comment shows divergence rate + regression eval failures
- [ ] Failed regression blocks merge when branch protection enabled
- [ ] MCP `preview_change_impact` returns same report as PR comment
- [ ] N20 T4 auto-merge requires `auto_merge_safe` recommendation
- [ ] N06 audit pack includes impact reports per deploy

---

## 12. Performance & cost optimization

### Latency budgets

| Operation | p50 | p95 | p99 |
|---|---|---|---|
| Webhook ack | 50ms | 200ms | 500ms |
| Trace sampling | 500ms | 2s | 5s |
| Single cached replay | 5s | 20s | 60s |
| Full 50-trace job | 8min | 25min | 45min |
| Report API | 30ms | 150ms | 400ms |

### Cost model

| Component | Est. cost per preview |
|---|---|
| 50 cached replays (avg 20 tail steps) | $1.50–4.00 |
| N01 regression (20 cases) | $0.20–0.80 |
| Trajectory diff (deterministic) | $0 |
| **Total typical** | **$2–5/PR** |

Caps: `max_previews_per_day/org=20`; N22 `daily_autonomy_budget_usd` includes preview spend.

### Caching strategy

- Baseline trajectories cached 24h by `(trace_id, config_hash)`
- Report served from store — immutable after generation

### Degradation modes

- F01 unavailable → judges-only mode on stored traces (cheaper, less accurate)
- Budget exceeded → queue preview, notify N17
- Partial failures → report with `traces_replayed < requested`

### Monitoring

```
eden_change_impact_preview_duration_seconds
eden_change_impact_preview_cost_usd_total
eden_change_impact_divergence_rate_histogram
eden_change_impact_block_merge_total
eden_change_impact_auto_merge_total
```

---

## 13. Dependencies

| Spec | Relationship |
|---|---|
| F01 | Cached-prefix replay engine |
| N01 | Regression eval in report |
| F41 | Promotion gate on block |
| N20 | T4 auto-merge consumes report |
| N22 | Policy for auto-run and auto-merge |
| N17 | Verify column UX |
| N06 | Audit trail per deploy |

---

*See [MARKET-HYPOTHESES.md](../MARKET-HYPOTHESES.md) §3.4, [AUTONOMOUS-MAINTENANCE.md](../AUTONOMOUS-MAINTENANCE.md).*
