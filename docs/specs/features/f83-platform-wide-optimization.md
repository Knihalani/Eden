# F83: Platform-Wide Optimization Pass

| Field | Value |
|---|---|
| **Feature ID** | F83 |
| **Priority** | P0 |
| **Effort** | XL |
| **Eden status** | MISSING as coordinated program |
| **Competitive source** | Laminar search/CH; N09/N16; Galileo Luna cost path |
| **UI spec** | — |
| **Dependencies** | N09, N16, F62, F82, PERFORMANCE-COST-STANDARDS |
| **Roadmap** | [EDEN-MASTER-ROADMAP.md](../EDEN-MASTER-ROADMAP.md) Wave 14 |

---

## 1. Summary

Cross-cutting optimization of ingest, storage, query, workers, LLM spend, and gateway — make shipped features fast and cheap for fleets.

---

## 2. Eden current state

N09/N16 exist as SHIPPED core/v0; LLM judges often expensive; slow-query discipline uneven; no single optimization program owner.

---

## 3. Target behavior

1. Ingest hot path <5ms p99 overhead.
2. N09 dedupe + zstd lifecycle verified on.
3. N16 sampling keeps all failures; cost cut documented.
4. Indexed FilterBar fields; materialized Home/Drift/Experiment aggregates.
5. Worker backpressure + DLQ in Settings.
6. LLM cascade deterministic → SLM (F62) → full LLM; org budgets.
7. Gateway nudge/prompt cache TTLs validated.

---

## 4. Architecture

```
Workstreams owned as checklist in docs/specs/optimization-pass.md (generated during execution)
src/eden/observability/slow_query.py
Settings → DLQ UI (existing webhooks-dlq extend)
```

---

## 5. Data model

Reuse existing; add `slow_query_events` if not present.

---

## 6. API specification

```
GET /orgs/{org}/admin/slow-queries
GET /orgs/{org}/admin/sampling-stats
```

---

## 7. Implementation plan

1. Baseline metrics capture
2. Storage/ingest pass
3. Query/index pass
4. Worker/DLQ pass
5. LLM cascade + F62 default online
6. Publish before/after report

---

## 8. SDK / MCP / Portal

Portal instrumentation and CI gates are first-class. MCP health tools where noted. No customer-facing marketing surface required.

---

## 9. Feature flags & rollout

`features.f83` — enable per env; kill switch for probes/enforcement that could page falsely.

---

## 10. Test plan

- Unit tests for budget math / probe logic
- Staging soak with synthetic load
- CI gate self-test (fail then fix)
- Cross-org isolation for any status APIs

---

## 11. Acceptance criteria

- [ ] Before/after report per workstream
- [ ] No F82 portal SLA regression
- [ ] LLM $/1k traces ≤50% of baseline on dogfood (or documented floor)
- [ ] No >2s core list queries in staging soak
- [ ] N09/N16 on by default for new orgs

---

## 12. Performance & cost optimization

Meta-program. Track checklist score. Follow PERFORMANCE-COST-STANDARDS.

### Monitoring

```
eden_f83_duration_seconds
eden_f83_errors_total
```

---

## 13. Dependencies

N09, N16, F62, F82, PERFORMANCE-COST-STANDARDS
