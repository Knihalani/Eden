# KB Audit Procedure

> **Owner:** AI · **Cadence:** quarterly · **Driven by:**
> `scripts/kb_audit.py` · **Closes:** §9.4.1 of the roadmap.

## Goal

Verify that the Eden Knowledge Base is healthy: coverage, accuracy,
and retrieval quality. The audit produces a JSON report that the
team reviews in the quarterly KB meeting.

## Audit dimensions

### 1. Coverage

The KB should contain a minimum set of entity types. Missing
entity types indicate a knowledge gap.

| Entity type | Expected min count | Why |
|-------------|--------------------|-----|
| `framework` | 30 | Major agent frameworks (LangChain, CrewAI, AutoGen, etc.) |
| `failure_mode` | 50 | Common agent failure modes with mitigation |
| `environment_class` | 12 | The 12+ environment classes Eden supports |
| `tool` | 100 | The tools referenced in the pipeline |
| `pattern` | 40 | Recurring code patterns observed in generated envs |

`scripts/kb_audit.py` runs these counts and reports any below the
threshold.

### 2. Accuracy

For a sample of N=20 KB entries, a human reviewer (or a strong
LLM with a confidence threshold) checks each entry against the
ground truth. The audit reports:

- `accuracy_pct` = correct / 20
- `flagged_entries` = the 20-row sample with reviewer verdicts

If accuracy < 80%, the Distiller batch is rerun with a stricter
AUDN threshold and the audit re-run in 30 days.

### 3. Retrieval quality

A fixed set of 20 canonical queries is run against the KB. For
each query, the top-5 hits are checked for relevance.

- `top5_hit_rate` = queries where ≥1 top-5 hit is relevant / 20
- `mrr` (mean reciprocal rank) = mean of 1/rank-of-first-relevant

A top-5 hit rate < 70% triggers a RetrievalTuner recalibration.

## Running the audit

```bash
python scripts/kb_audit.py --out reports/kb-audit-$(date +%Y%m%d).json
```

## Report shape

```json
{
  "audit_date": "2026-09-30",
  "coverage": {
    "framework": 35,
    "failure_mode": 62,
    "...": "..."
  },
  "accuracy": {
    "sample_size": 20,
    "correct": 17,
    "accuracy_pct": 0.85,
    "flagged_entries": [...]
  },
  "retrieval": {
    "queries_run": 20,
    "top5_hit_rate": 0.75,
    "mrr": 0.62
  },
  "verdict": "PASS" | "PARTIAL" | "FAIL"
}
```

## Verdict thresholds

| Verdict | Criteria |
|---------|----------|
| PASS | All 5 entity types above minimum, accuracy ≥ 80%, top-5 ≥ 70% |
| PARTIAL | 1 dimension below threshold; rerun in 30 days |
| FAIL | 2+ dimensions below threshold; rerun in 7 days with stricter Distiller settings |
