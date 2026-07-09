# F42: Behavioral Drift Pinpoint Reports

| Field | Value |
|---|---|
| **Feature ID** | F42 |
| **Slug** | `behavioral-drift-pinpoint` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **PARTIAL** |
| **Competitive source** | BentoLabs |
| **Closes gap** | 4.4 |
| **Dependencies** | Cat 13 PSI, N03, N05 |

---

## 1. Summary

Weekly report: what shifted in agent behavior — tool mix, routing, prompt version, model, cost, latency. PSI (Population Stability Index) per dimension with plain-English "what changed."

---

## 2. Target behavior

```
Weekly DriftWorker:
    → Baseline: 30d rolling vs Last 24h
    → Dimensions: tool_distribution, model_mix, prompt_version, avg_steps, cost, stumble_rate
    → PSI >0.2 → flag dimension in report
    → Portal + Slack digest (F47)
```

---

## 3. Data model

```sql
CREATE TABLE drift_baselines (
    org_id UUID NOT NULL,
    agent_id TEXT NOT NULL,
    dimension TEXT NOT NULL,
    baseline_histogram JSONB NOT NULL,
    computed_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (org_id, agent_id, dimension)
);
```

---

## 4. API

| Method | Path |
|---|---|
| `GET` | `/orgs/{org_id}/agents/{agent_id}/drift` |
| `GET` | `/orgs/{org_id}/agents/{agent_id}/drift/report/latest` |

---

## 5. Performance & cost optimization

- **$0 LLM** — SQL histograms + PSI math
- Pre-compute nightly; API serves cached report p95 <500ms
- Top 3 dimensions only in Slack digest (reduce noise)
- Skip agents with <100 traces/week

---

## 6. Acceptance criteria

- [ ] Model swap detected within 24h
- [ ] Report shows top 3 drift dimensions
- [ ] PSI matches manual calculation on fixture

---

*Extends Cat 13; feeds N05 fleet dashboard.*
