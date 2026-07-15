# F82: Portal Performance Budgets & Runtime Enforcement

| Field | Value |
|---|---|
| **Feature ID** | F82 |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | MISSING |
| **Competitive source** | Laminar virtualization; PERFORMANCE-COST-STANDARDS |
| **UI spec** | U18 / U19 consumers |
| **Dependencies** | U00 InfiniteDataTable, F12, N09, CI |
| **Roadmap** | [EDEN-MASTER-ROADMAP.md](../EDEN-MASTER-ROADMAP.md) Wave 14 |

---

## 1. Summary

Enforce portal SLAs: virtualized lists, progressive trace load, bundle budgets, Web Vitals CI gates, and runtime performance marks on core routes.

---

## 2. Eden current state

| Piece | Status |
|---|---|
| PERFORMANCE-COST-STANDARDS | Documented SLAs |
| DataTable | Not consistently virtualized |
| Web Vitals CI | MISSING |
| Perf marks | Ad hoc |

---

## 3. Target behavior

1. Virtualize Traces, Issues, Datasets, Experiments tables.
2. Trace panel progressive load; lazy tool payloads.
3. Route-split all Advanced pages out of core bundle.
4. CI fails on LCP/INP regression beyond budget on Home + Traces.
5. Marks: `eden:page`, `eden:table_query`, `eden:panel_open`.
6. Optional dev overlay for slow queries.

---

## 4. Architecture

```
clients/portal/
  lib/perf/budgets.ts
  lib/perf/marks.ts
  components/portal-os/InfiniteDataTable.tsx  # virtualized
.github/workflows/web-vitals.yml
```

---

## 5. Data model

No new business tables. Optional `portal_perf_samples` for RUM if sampled.

---

## 6. API specification

```
POST /orgs/{org}/rum/vitals   # optional sampled RUM
GET  /internal/perf/budgets   # staff
```

---

## 7. Implementation plan

1. Virtualize core tables
2. Code-split Advanced routes
3. Add marks + RUM optional
4. CI Web Vitals gate
5. Document budgets in PERFORMANCE-COST-STANDARDS

---

## 8. SDK / MCP / Portal

Portal instrumentation and CI gates are first-class. MCP health tools where noted. No customer-facing marketing surface required.

---

## 9. Feature flags & rollout

`features.f82` — enable per env; kill switch for probes/enforcement that could page falsely.

---

## 10. Test plan

- Unit tests for budget math / probe logic
- Staging soak with synthetic load
- CI gate self-test (fail then fix)
- Cross-org isolation for any status APIs

---

## 11. Acceptance criteria

- [ ] Virtualization on all core list pages
- [ ] CI Web Vitals gate on Traces + Home
- [ ] Perf marks queryable in dogfood
- [ ] Advanced pages not on core critical path
- [ ] No SLA regression after U18 shell

---

## 12. Performance & cost optimization

| Surface | p50 | p95 |
|---|---|---|
| Core page interactive | <300ms | <800ms |
| Trace panel open | <200ms | <600ms |
| Table filter apply | <100ms | <400ms |
$0 LLM. Metrics: `eden_portal_web_vital`, `eden_portal_table_query_seconds`.

### Monitoring

```
eden_f82_duration_seconds
eden_f82_errors_total
```

---

## 13. Dependencies

U00 InfiniteDataTable, F12, N09, CI
