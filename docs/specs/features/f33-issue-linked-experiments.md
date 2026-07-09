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
| **Dependencies** | F29, Cat 12 experiments, F41 |

---

## 1. Summary

Link Cat 12 A/B experiments to F29 issues — verify fix reduced stumble rate before F41 promotion. Raindrop "did the fix work?" loop.

---

## 2. Target behavior

```
Issue resolved with fix deployed
    → Wizard: "Run A/B on prompt v2 vs v1"
    → experiment_id linked on issue
    → 7d run: measure stumble_rate by variant
    → Bayesian report → F41 EvidenceGate input
```

---

## 3. Data model

```sql
ALTER TABLE agent_issues ADD COLUMN experiment_id UUID;
ALTER TABLE agent_issues ADD COLUMN experiment_result JSONB;

-- experiment_result: {control_stumble_rate, treatment_stumble_rate, prob_treatment_better, n}
```

---

## 4. API

| Method | Path |
|---|---|
| `POST` | `/orgs/{org_id}/agent-issues/{id}/experiments` |
| `GET` | `/orgs/{org_id}/agent-issues/{id}/experiments/{exp_id}/report` |

Extends `intelligence_experiments.py` with issue context.

---

## 5. Performance & cost optimization

- **Metrics from F28 stumbles** — no extra LLM
- Pre-aggregate hourly stumble rates by variant (MV)
- Report generation p95 <3s (cached)
- Min sample: 100 traces/variant before showing conclusion

---

## 6. Acceptance criteria

- [ ] Experiment shows stumble delta on issue page
- [ ] F41 reads experiment_result for PR promotion
- [ ] Bayesian "95% confident treatment better" display

---

*See F41, Raindrop experiments parity.*
