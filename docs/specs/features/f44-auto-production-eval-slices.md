# F44: Auto-Curated Production Eval Slices

| Field | Value |
|---|---|
| **Feature ID** | F44 |
| **Slug** | `auto-production-eval-slices` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **PARTIAL** |
| **Competitive source** | BentoLabs |
| **Closes gap** | 4.6 |
| **Dependencies** | Cat 3 evals, N01, F28, N04, N16 |

---

## 1. Summary

Nightly job clusters production traces into **eval dataset slices** by agent + behavior cluster — exploratory coverage complementing N01 issue-driven regression cases. Powers CI eval on prompt changes (N04) and continuous maintenance confidence without manual dataset curation.

---

## 2. Eden current state

| Shipped | Path | Gap |
|---|---|---|
| Eval datasets | Cat 3 | No auto-curation job |
| Trace embeddings | partial | No clustering pipeline |
| N01 regression | spec | Priority over slices, not implemented |

**Greenfield:** `src/eden/evaluation/auto_curator.py`

---

## 3. Target behavior

```
AutoCurator (nightly 02:00 UTC):
    → For each active agent (top 20 by traffic/org):
        Sample 1k traces/day (stratified: random + stumbles + high-cost)
        Embed conversation summaries (text-embedding-3-small)
        K-means cluster (k=auto, elbow method, max 20 clusters)
        Pick medoid trace per cluster as eval case candidate
        Dedupe against existing cases (embedding similarity >0.95)
        Upsert production_eval_slices + eval_cases
    → Portal Datasets tab shows slices + cluster labels (LLM optional)
    → CI webhook: prompt change runs **linked slice** (not full 1k)
    → N01 regression cases always take priority in CI merge
```

### Stratified sampling buckets (1k/agent)

| Bucket | Count | Purpose |
|---|---|---|
| Random | 600 | Coverage |
| F28 stumbles | 200 | Failure modes |
| High cost top decile | 100 | Expensive paths |
| Recent issues linked | 100 | Maintenance relevance |

---

## 4. Architecture

| Component | Path |
|---|---|
| `AutoCurator` | `evaluation/auto_curator.py` |
| `TraceEmbedder` | `evaluation/embeddings/trace_summary.py` |
| `ClusterSelector` | `evaluation/clustering/selector.py` |
| `SliceLabelLLM` | optional — name clusters ~$0.01/agent |

---

## 5. Data model

```sql
CREATE TABLE production_eval_slices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    agent_id TEXT NOT NULL,
    dataset_id UUID NOT NULL,
    cluster_id INT NOT NULL,
    cluster_label TEXT,
    medoid_trace_id UUID NOT NULL,
    case_count INT NOT NULL,
    member_trace_ids UUID[],
    refreshed_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (org_id, agent_id, cluster_id)
);

CREATE TABLE auto_curator_runs (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    agent_id TEXT,
    traces_sampled INT,
    clusters_found INT,
    cases_upserted INT,
    cost_usd FLOAT,
    duration_seconds INT,
    status TEXT,
    completed_at TIMESTAMPTZ
);
```

---

## 6. API specification

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/orgs/{org_id}/production-datasets` | Slices + last refresh |
| `GET` | `/orgs/{org_id}/production-datasets/{agent_id}` | Agent slices detail |
| `POST` | `/orgs/{org_id}/production-datasets/refresh` | Manual trigger (async) |
| `GET` | `/orgs/{org_id}/production-datasets/runs` | Curator run history |

**MCP (F04):** `list_production_eval_slices(agent_id)`, `refresh_production_slices(agent_id)`

---

## 7. CI integration

```
GitHub webhook (prompt change)
    → N04 ImpactPreview + regression runner
    → Dataset selection order:
        1. N01 issue-linked regression cases (all)
        2. F44 slice medoids for changed agent (max 30 cases)
        3. Skip full 1k — cost cap
    → Post combined pass/fail
```

---

## 8. Implementation plan

1. Migration + curator job registration
2. Trace summary extractor (last user msg + tool sequence hash)
3. Embed + cluster pipeline
4. Medoid selection + dedupe
5. Eval case upsert into Cat 3 datasets
6. Portal datasets UI
7. N04/N01 CI dataset selection logic
8. Optional cluster labeling LLM

---

## 9. Feature flags & rollout

| Flag | Default |
|---|---|
| `auto_eval_slices_v1` | off |
| `auto_curator_max_agents_per_org` | 20 |
| `auto_curator_samples_per_agent` | 1000 |

---

## 10. Test plan

- 1k fixture traces → 8–20 clusters (reasonable range)
- Medoids visually distinct on manual review sample
- Dedupe prevents near-duplicate cases
- Nightly run completes <30min for 20 agents (mocked embed)
- CI selects N01 cases before slice medoids

---

## 11. Acceptance criteria

- [ ] Nightly slice refresh for active agents
- [ ] CI webhook triggers eval on prompt file change
- [ ] Cluster quality: cases represent distinct behaviors (manual review sample)
- [ ] N01 cases prioritized over auto slices in CI
- [ ] Portal shows last refreshed + cluster labels
- [ ] Manual refresh enqueues job with cost estimate

---

## 12. Performance & cost optimization

### Nightly job cost

| Step | Cost (per agent) |
|---|---|
| Embed 1k summaries | ~$0.10 |
| K-means CPU | $0 |
| Optional cluster labels | ~$0.01 |
| **20 agents/org** | **~$2.20/night** |

Cap 20 agents/org/night by traffic rank — skip long tail.

### CI cost savings

- Linked slice only (≤30 medoids) vs full 1k — **~97% CI cost reduction**
- N01 regression cases take priority — critical fixes always tested

### Latency budgets

| Operation | p50 | p95 |
|---|---|---|
| Nightly job (20 agents) | 10min | 30min |
| List slices API | 40ms | 200ms |
| Manual refresh enqueue | 50ms | 200ms |

### Degradation modes

- Embed API down → skip agent, retry next night
- <100 traces/day agent → skip with status `insufficient_traffic`
- Cluster collapse (k=1) → treat as single slice

### Monitoring

```
eden_auto_curator_duration_seconds
eden_auto_curator_cost_usd_total
eden_auto_curator_cases_upserted_total
eden_auto_curator_agents_skipped_total{reason}
```

---

## 13. Dependencies

| Spec | Relationship |
|---|---|
| N01 | Issue regression priority in CI |
| N04 | Combined impact preview eval |
| F28 | Stumble-enriched sampling |
| N16 | Retention affects sample pool |
| Cat 3 | Dataset storage |

---

*Pairs with N01 for full eval coverage — exploratory + regression maintenance.*
