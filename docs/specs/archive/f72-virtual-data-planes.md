# F72: Virtual / Customer Data Planes

| Field | Value |
|---|---|
| **Feature ID** | F72 |
| **Priority** | P2 |
| **Effort** | XL |
| **Eden status** | MISSING |
| **Competitive source** | HoneyHive virtual data planes; Raindrop 2.0 VPC |
| **UI spec** | — |
| **Dependencies** | N06, enterprise |

---

## 1. Summary

Payload isolation, CMK, VPC for enterprise beyond audit trails.

---

## 2. Eden current state

N06 is audit not data-plane isolation.

Treat this document as the product definition to finish; stubs may exist.

---

## 3. Target behavior

1. Deliver §1 at competitive parity with the cited source (core 80%).
2. Wire portal per UI spec when listed.
3. Gate production mutations with EvidenceGate / StatGate / N22.
4. Emit N06 audit events for promote/deploy/override.
5. Empty states teach the closed loop (Bento Gap 4.8).

### Primary operator flow

Discover → configure → enable/run → inspect → act (dataset / issue / artifact / alert).

### Non-goals

- Cloning competitor visual skins (keep Eden tokens)
- Silent production writes without policy

---

## 4. Architecture

```
Portal (UI spec)
  → src/eden/api/routes/  (org-scoped REST)
  → src/eden/<domain>/    (service)
  → workers (Redis streams / cron)
  → Postgres + trace/score stores
```

Extend gateway filters, judges, datasets, and `learn_wiring` rather than parallel stacks.

---

## 5. Data model

Add migration in `src/eden/db_migrations/versions/`:

- Org-scoped primary entity table
- Run/event/outcome table for auditability
- Indexes on `(org_id, created_at)` + FKs to traces/issues/datasets as needed

Finalize exact DDL in the implementing PR.

---

## 6. API specification

```
CRUD  /orgs/{org}/<resource>
POST  /orgs/{org}/<resource>/{id}/<action>
GET   /orgs/{org}/<resource>/{id}/events
```

AuthZ: Clerk org membership; admins for promote/deploy.

---

## 7. Implementation plan

1. Migration + domain models
2. API + async workers
3. Portal UI (linked UI spec)
4. Feature flag + Prometheus metrics
5. Tests + docs + empty states
6. Dogfood → beta → GA

---

## 8. SDK / MCP / Portal

| Surface | Requirement |
|---|---|
| Portal | Required unless explicitly backend-only |
| MCP (F04) | Read tools when coding-agent-relevant |
| SDKs | Optional convenience helpers |

---

## 9. Feature flags & rollout

`features.f72` — internal → design-partner beta → GA.  
Kill switch disables workers within 60s.

---

## 10. Test plan

- Unit: pure logic
- Integration: fixture org/traces
- Portal E2E: primary happy path
- Cost budget test if LLM-backed
- Cross-org isolation security test

---

## 11. Acceptance criteria

- [ ] End-to-end happy path works
- [ ] Competitive parity (core 80% of cited source)
- [ ] §12 latency budgets met on staging
- [ ] Flag + metrics live
- [ ] Docs + empty-state copy
- [ ] No cross-org leakage

---

## 12. Performance & cost optimization

| Operation | p50 | p95 |
|---|---|---|
| Primary read | <100ms | <400ms |
| Primary write | <150ms | <600ms |
| Async job start | <500ms | <2s |

### Cost model

Prefer deterministic → SLM (F62) → full LLM. Document $/1k ops in implementation PR. Hook org budgets when LLM used.

### Caching

Redis 30–60s on hot reads; invalidate on write.

### Degradation

Flag off → empty state. LLM down → retry queue + visible error.

### Monitoring

```
eden_f72_duration_seconds
eden_f72_cost_usd_total
eden_f72_errors_total
```

---

## 13. Dependencies

N06, enterprise

Sequencing: [EDEN-MASTER-ROADMAP.md](../EDEN-MASTER-ROADMAP.md) · Research: [COMPETITOR-UI-RESEARCH.md](../COMPETITOR-UI-RESEARCH.md).
