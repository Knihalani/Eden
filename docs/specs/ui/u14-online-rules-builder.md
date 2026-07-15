# U14: Online Scoring Rules Builder

| Field | Value |
|---|---|
| **Spec ID** | U14 |
| **Priority** | P1 |
| **Clone targets** | LangSmith online evaluators; Braintrust Automations |
| **Dependencies** | F52, F61, N03, U08, U18 |
| **Routes** | `/settings/automations`, entry from scorers / playground |
| **Roadmap** | Wave 6; Wave 12 |

---

## 1. List

Name, status, sample %, fires 24h, error rate; enable/disable; last run.

---

## 2. Rule form

| Field | Notes |
|---|---|
| Name | Required |
| Scorers / classifiers | Multi-select; version pin |
| Sample rate | 0–100% |
| Scope | Trace \| Span (F79) |
| Filters | Root/span names + SQL/EQL (U08) |
| Test | Preview on recent logs |
| Rewind | Reprocess window (job progress) |

Automations (F61): on score threshold → dataset / queue / issue / alert.

---

## 3. Acceptance criteria

- [ ] Create/test/enable rule
- [ ] Scores appear on U01 traces
- [ ] Rewind job progress UI
- [ ] Entry from Playground scorer
- [ ] Sample rate respected (±5% over 1k)

---

## 4. Performance

Rule eval async; UI reads cached counts 60s.
