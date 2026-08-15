# F42: Behavioral Drift Pinpoint Reports

| Field | Value |
|---|---|
| **Feature ID** | F42 |
| **Slug** | `behavioral-drift-pinpoint` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **PARTIAL** |
| **Competitive source** | BentoLabs |
| **UI spec** | [U05 Book & Drift](../ui/u05-book-and-drift.md) |
| **Closes gap** | 4.4 |
| **Dependencies** | Cat 13 PSI, N03, N05, DriftAlertHook, N21, F47 |

---

## 1. Summary

Weekly (and on-demand) **drift pinpoint reports** — what shifted in agent behavior (tool mix, routing, prompt version, model, cost, latency, stumble rate) with PSI scores and plain-English summaries. Extends shipped `DriftAlertHook` (`promotion_hooks.py:1550`) with operator UX + autonomous heal triggers (N21 reweight).

---

## 2. Eden current state

| Shipped | Path | Status |
|---|---|---|
| `DriftAlertHook` | `llmops/promotion_hooks.py:1550` | **SHIPPED** — fires events |
| Cat 13 PSI | partial | No agent-facing reports |
| Columnar compaction drift | `columnar/_common.py` | Storage drift only |
| Portal drift UI | — | **MISSING** |

**Gap:** Hook fires but no `drift_baselines` table, no `/agents/{id}/drift` API, no Slack digest.

---

## 3. Target behavior

```
Weekly DriftWorker ( + on-demand ):
    → Baseline: 30d rolling histogram per dimension
    → Compare: last 24h vs baseline
    → Dimensions:
        tool_distribution, model_mix, prompt_version_mix,
        avg_steps, cost_per_trace, stumble_rate, mcp_error_rate
    → PSI >0.2 → flag dimension in report
    → LLM plain-English summary (optional, async)
    → Portal report + Slack digest (F47) top 3 dimensions
    → N05 fleet card badge
    → N21: if model_mix drift + canary fail → suggest reweight heal
```

### Autonomous (N22 T2+)
- `model_mix` PSI >0.25 after deploy → auto-queue N21 `reweight` proposal
- Never auto-heal without StatGate + policy (N21)

---

## 4. Architecture

| Component | Path |
|---|---|
| `DriftWorker` | `intelligence/drift/worker.py` |
| `PsiCalculator` | `intelligence/drift/psi.py` |
| `DriftReportBuilder` | `intelligence/drift/report.py` |
| Hook consumer | extends `DriftAlertHook` output |

**Wire existing hook:**

```python
# promotion_hooks.py DriftAlertHook → enqueue DriftWorker job
await drift_worker.compute(org_id, agent_id, dimension, current, baseline)
```

---

## 5. Data model

```sql
CREATE TABLE drift_baselines (
    org_id UUID NOT NULL,
    agent_id TEXT NOT NULL,
    dimension TEXT NOT NULL,
    baseline_histogram JSONB NOT NULL,  -- bin edges + counts
    sample_count INT NOT NULL,
    window_days INT DEFAULT 30,
    computed_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (org_id, agent_id, dimension)
);

CREATE TABLE drift_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    agent_id TEXT NOT NULL,
    report_period_start TIMESTAMPTZ NOT NULL,
    report_period_end TIMESTAMPTZ NOT NULL,
    dimensions JSONB NOT NULL,  -- [{dimension, psi, flagged, summary, delta_pct}]
    top_dimensions TEXT[],
    plain_english_summary TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 6. API specification

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/orgs/{org_id}/agents/{agent_id}/drift` | Latest PSI scores per dimension |
| `GET` | `/orgs/{org_id}/agents/{agent_id}/drift/report/latest` | Full report |
| `GET` | `/orgs/{org_id}/agents/{agent_id}/drift/reports` | History |
| `POST` | `/orgs/{org_id}/agents/{agent_id}/drift/compute` | On-demand refresh |

**MCP (F04):** `get_drift_report(agent_id)`, `get_drift_dimensions(agent_id)`

---

## 7. Implementation plan

1. Migration + baseline nightly job
2. `PsiCalculator` — standard PSI formula, bin alignment
3. Consume `DriftAlertHook` for incremental updates
4. Report builder + optional SLM summary ($0.01/report)
5. Portal drift tab
6. F47 weekly Slack digest (top 3)
7. N05 fleet badge + N21 reweight suggestion

---

## 8. Feature flags & rollout

| Flag | Default |
|---|---|
| `behavioral_drift_reports_v1` | off |
| `drift_psi_threshold` | 0.2 |
| `drift_slack_digest` | on |

---

## 9. Test plan

- Model swap fixture → `model_mix` PSI >0.2 within 24h
- PSI matches manual calculation on golden histogram pair
- Agent <100 traces/week → skipped with reason
- DriftAlertHook event → report row updated
- N21 suggestion created on model_mix + deploy correlation

---

## 10. Acceptance criteria

- [ ] Model swap detected within 24h
- [ ] Report shows top 3 drift dimensions
- [ ] PSI matches manual calculation on fixture
- [ ] Slack digest sent weekly (F47)
- [ ] N05 fleet shows drift badge
- [ ] MCP returns same report as portal

---

## 11. Performance & cost optimization

### Cost model

- **Core analytics: $0 LLM** — SQL histograms + PSI math
- Optional plain-English summary: 1 SLM call ~$0.01/report
- Pre-compute nightly; API serves cached report p95 <500ms
- Skip agents with <100 traces/week

### Latency budgets

| Operation | p50 | p95 |
|---|---|---|
| Drift API (cached) | 30ms | 500ms |
| Nightly compute per agent | 2s | 15s |
| On-demand compute | 5s | 30s |

### Caching strategy

- Latest report Redis 1h
- Baselines refreshed daily only

### Degradation modes

- Insufficient sample → dimension marked `insufficient_data`
- Histogram bin mismatch → recompute baseline

### Monitoring

```
eden_drift_psi_computed_total{dimension,flagged}
eden_drift_report_duration_seconds
eden_drift_hook_events_total
eden_drift_n21_suggest_total
```

---

## 12. Dependencies

| Spec | Relationship |
|---|---|
| N03 | Eval drift dimension |
| N05 | Fleet badge |
| N21 | Reweight on model drift |
| F47 | Slack digest |
| DriftAlertHook | Event source |

---

*Extends Cat 13 + shipped hook; feeds N05 fleet + autonomous N21.*
