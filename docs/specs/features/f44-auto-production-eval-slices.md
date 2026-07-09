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
| **Dependencies** | Cat 3 evals, N01, F28 |

---

## 1. Summary

Nightly job clusters production traces into eval dataset slices by agent + behavior cluster. Complements N01 (issue-driven cases) with exploratory coverage.

---

## 2. Target behavior

```
AutoCurator (nightly):
    → Sample 1k traces/agent/day (stratified)
    → Embed + cluster
    → Pick medoid trace per cluster as eval case
    → Upsert production_eval_slices dataset
    → Portal Datasets tab + CI webhook
```

---

## 3. Data model

```sql
CREATE TABLE production_eval_slices (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    agent_id TEXT NOT NULL,
    dataset_id UUID NOT NULL,
    cluster_id INT NOT NULL,
    case_count INT NOT NULL,
    refreshed_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (org_id, agent_id, cluster_id)
);
```

---

## 4. API

| Method | Path |
|---|---|
| `GET` | `/orgs/{org_id}/production-datasets` |
| `POST` | `/orgs/{org_id}/production-datasets/refresh` |

---

## 5. Performance & cost optimization

### Nightly job cost

- Embed 1k traces: ~$0.10/agent (small model)
- Clustering: CPU only
- Cap 20 agents/org/night by traffic rank

### CI integration

- Webhook on prompt change runs **linked slice only** (not full 1k)
- N01 regression cases take priority over auto slices

### Latency

- Refresh job async; portal shows last refreshed timestamp
- Eval run uses cached dataset — no live cluster at CI time

---

## 6. Acceptance criteria

- [ ] Nightly slice refresh for active agents
- [ ] CI webhook triggers eval on prompt file change
- [ ] Cluster quality: cases represent distinct behaviors (manual review sample)

---

*Pairs with N01 for full eval coverage.*
