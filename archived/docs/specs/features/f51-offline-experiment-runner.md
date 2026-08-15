# F51: Offline Experiment Runner + Comparison Grid

| Field | Value |
|---|---|
| **Feature ID** | F51 |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | PARTIAL — llmops experiments thin; F33 issue-linked only |
| **Competitive source** | Phoenix experiments; LangSmith; Braintrust grades; Laminar evals UI |
| **UI spec** | [U07](../ui/u07-experiments-compare.md) |
| **Dependencies** | F49, F53, scorers, F33, F54/F62 optional |

---

## 1. Summary

Immutable dataset × task × scorers runs with multi-run compare, progression charts, and improvement/regression grades. General offline eval product beyond F33 issue-linked A/B.

---

## 2. Eden current state

| Component | Status |
|---|---|
| `/llmops` experiments tab | Thin list |
| F33 issue-linked | PARTIAL |
| Playground → experiment | MISSING (needs F49) |
| Compare grades UI | MISSING |

---

## 3. Target behavior

1. Create experiment from UI, SDK, or Playground promote.
2. Snapshot task config + dataset pin + scorer versions (immutable).
3. Run async; stream datapoint completion.
4. Detail: split table|trace; score cards; CSV export; share.
5. Compare `?targetId=` with per-row Δ and grades (Improvement/Regression/Tradeoff/Tie).
6. Progression chart across runs in a group.
7. Set project baseline; F56 CI consumes it.
8. Optional F33 issue banner.

---

## 4. Architecture

```
src/eden/experiments/
  runner.py          # execute task per datapoint via gateway/sandbox
  compare.py         # grades + deltas
  aggregates.py      # progression materialization
src/eden/api/routes/experiments.py
clients/portal/.../experiments/
```

---

## 5. Data model

```sql
CREATE TABLE experiments (
  id UUID PRIMARY KEY, org_id UUID, name TEXT, group_id UUID,
  dataset_id UUID, dataset_snapshot_id UUID, config JSONB NOT NULL,
  is_baseline BOOLEAN DEFAULT false, issue_id UUID,
  status TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE experiment_datapoints (
  id UUID PRIMARY KEY, experiment_id UUID, dataset_item_id UUID,
  input JSONB, output JSONB, expected JSONB, scores JSONB,
  trace_id UUID, error TEXT);
CREATE TABLE experiment_aggregates (
  experiment_id UUID PRIMARY KEY, scores JSONB, metrics JSONB, updated_at TIMESTAMPTZ);
```

---

## 6. API specification

```
GET/POST /orgs/{org}/experiments
GET /orgs/{org}/experiments/{id}
GET /orgs/{org}/experiments/{id}/compare?target_id=
POST /orgs/{org}/experiments/{id}/set-baseline
GET /orgs/{org}/experiments/{id}/export.csv
```

---

## 7. Implementation plan

1. Schema + runner worker
2. Portal list/detail/compare (U07)
3. Playground promote hook
4. Baseline + F56 contract
5. F33 issue link

---

## 8. SDK / MCP / Portal

- Portal: see UI spec
- MCP: expose read tools where useful (F04)
- SDK: optional helpers

---

## 9. Feature flags & rollout

`features.f51_experiments`

---

## 10. Test plan

- Deterministic code scorer experiment on fixture dataset
- Compare grades golden cases
- Immutability: PATCH config rejected after start

---

## 11. Acceptance criteria

- [ ] Immutable runs; compare grades visible
- [ ] Progression chart multi-score
- [ ] Playground → experiment
- [ ] CSV + share link
- [ ] F33 banner when linked
- [ ] Trace panel opens executor span

---

## 12. Performance & cost optimization

First 50 rows <1s; aggregates precomputed; scorer cost tracked per datapoint.
Metrics: `eden_experiment_datapoint_seconds`, `eden_experiment_cost_usd_total`.

### Degradation modes

- Flag off → portal empty state with docs link
- Dependency down → fail loud (no silent drop)

### Monitoring

```
eden_f51_duration_seconds
eden_f51_cost_usd_total
```

---

## 13. Dependencies

F49, F53, scorers, F33, F54/F62 optional

Sequencing: [EDEN-MASTER-ROADMAP.md](../EDEN-MASTER-ROADMAP.md).
