# F33: Issue-Linked Production Experiments

| Field | Value |
|---|---|
| **Feature ID** | F33 |
| **Slug** | `issue-linked-experiments` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **PARTIAL** |
| **Competitive source** | Raindrop |
| **Closes gap** | 3.5 |
| **Dependencies** | F29, Cat 12 experiments, F41, F28, N17, N22 |

---

## 1. Summary

Link Cat 12 A/B experiments to F29 issues — measure whether a fix **actually reduced stumble rate** in production before F41 promotion. Raindrop "did the fix work?" loop; Eden adds StatGate metrics + Bayesian reporting + autonomous canary triggers (N18/N22).

---

## 2. Eden current state

| Shipped | Path | Gap |
|---|---|---|
| Experiments API | `intelligence_experiments.py` | No issue context |
| A/B assignment | Cat 12 partial | Not stumble-rate primary metric |
| F29 issues | spec (greenfield) | No experiment_id column |
| F41 EvidenceGate | spec | No experiment_result input |

---

## 3. Target behavior

### Operator flow
```
Issue resolved with fix deployed (prompt v2)
    → Wizard on issue page: "Run A/B: v2 vs v1"
    → Creates experiment with issue_id link
    → 7d run (configurable): measure stumble_rate + cost + N03 eval by variant
    → Bayesian report → F41 EvidenceGate input
    → N17 "Verify" column shows experiment progress
```

### Autonomous flow (N18/N22 T3)
```
Issue kind=prompt_regression + N18 canary active
    → Auto-create linked experiment (control=prod, treatment=canary)
    → If P(treatment better) > 0.95 for 48h + min samples:
        → F41 auto-promote prompt (T3)
    → Else: N17 card "Canary inconclusive"
```

---

## 4. Architecture

| Component | Path |
|---|---|
| `IssueExperimentWizard` | `experiments/issue_link.py` |
| `StumbleRateMetric` | `experiments/metrics/stumble_rate.py` |
| `BayesianReportBuilder` | `experiments/bayesian_report.py` |
| Portal UI | issue detail → Experiments tab |

**Metrics (primary):** F28 stumble_rate per variant — **$0 LLM**.

**Secondary:** cost/trace, N03 eval pass rate, StatGate block rate.

---

## 5. Data model

```sql
ALTER TABLE agent_issues ADD COLUMN IF NOT EXISTS experiment_id UUID;
ALTER TABLE agent_issues ADD COLUMN IF NOT EXISTS experiment_result JSONB;

CREATE TABLE issue_experiments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    issue_id UUID NOT NULL,
    experiment_id UUID NOT NULL,
    control_variant TEXT NOT NULL,
    treatment_variant TEXT NOT NULL,
    primary_metric TEXT DEFAULT 'stumble_rate',
    min_samples_per_variant INT DEFAULT 100,
    started_at TIMESTAMPTZ DEFAULT now(),
    ended_at TIMESTAMPTZ,
    status TEXT DEFAULT 'running'
);

-- experiment_result on issue:
-- {
--   "control_stumble_rate": 0.08,
--   "treatment_stumble_rate": 0.02,
--   "prob_treatment_better": 0.97,
--   "n_control": 1200,
--   "n_treatment": 1180,
--   "recommendation": "promote_treatment"
-- }
```

---

## 6. API specification

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/orgs/{org_id}/agent-issues/{id}/experiments` | Create linked experiment |
| `GET` | `/orgs/{org_id}/agent-issues/{id}/experiments/{exp_id}` | Status |
| `GET` | `/orgs/{org_id}/agent-issues/{id}/experiments/{exp_id}/report` | Bayesian report |
| `POST` | `/orgs/{org_id}/agent-issues/{id}/experiments/{exp_id}/stop` | Early stop |

Extends `intelligence_experiments.py` with `issue_id` filter.

**MCP (F04):** `create_issue_experiment(issue_id, treatment_variant)`, `get_experiment_report(exp_id)`

---

## 7. Implementation plan

1. Migration + issue experiment link table
2. Wizard API + portal UI
3. `StumbleRateMetric` hourly MV by variant
4. Bayesian beta-binomial for stumble yes/no per trace
5. F41 integration: read `experiment_result.recommendation`
6. N18 canary auto-experiment hook
7. F47 notify when experiment conclusive

---

## 8. Feature flags & rollout

| Flag | Default |
|---|---|
| `issue_experiments_v1` | off |
| `issue_experiment_auto_canary` | off (N18) |
| `issue_experiment_min_days` | 3 |

---

## 9. Test plan

- Create experiment → variants receive traffic per Cat 12
- Stumble rates match manual SQL on fixture
- Bayesian report: known rates → P>0.95 correct
- min_samples not met → report shows "insufficient data"
- F41 blocks promotion without conclusive experiment (when policy requires)

---

## 10. Acceptance criteria

- [ ] Experiment shows stumble delta on issue page
- [ ] F41 reads experiment_result for PR promotion
- [ ] Bayesian "95% confident treatment better" display
- [ ] Min 100 traces/variant before conclusion shown
- [ ] N17 Verify column shows running experiments
- [ ] N06 audit logs experiment create/stop/promote

---

## 11. Performance & cost optimization

### Latency budgets

| Operation | p50 | p95 | p99 |
|---|---|---|---|
| Create experiment | 100ms | 500ms | 1s |
| Report generation | 200ms | 2s | 3s |
| Hourly metric rollup | 5s | 30s | 60s |

### Cost model

- **Primary metrics from F28 stumbles** — no extra LLM
- Pre-aggregate hourly stumble rates by variant (MV)
- Report generation p95 <3s (cached)
- Experiment traffic: no additional ingest cost

### Caching strategy

- Report cached 5min while `status=running`
- Final report immutable after `ended_at`

### Degradation modes

- Cat 12 assignment down → experiment paused + alert
- Imbalanced traffic → report shows allocation warning

### Monitoring

```
eden_issue_experiment_created_total
eden_issue_experiment_report_duration_seconds
eden_issue_experiment_promote_recommended_total
```

---

## 12. Dependencies

| Spec | Relationship |
|---|---|
| F29 | Issue anchor |
| F41 | Promotion gate |
| F28 | Stumble metric |
| N03 | Secondary eval metric |
| N18 | Auto-canary experiments |
| N17 | Verify column |
| N22 | Auto-promote tier |

---

*See F41, Raindrop experiments parity, [AUTONOMOUS-MAINTENANCE.md](../AUTONOMOUS-MAINTENANCE.md).*
