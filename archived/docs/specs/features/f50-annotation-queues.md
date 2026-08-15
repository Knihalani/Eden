# F50: Annotation Queues (SME Product)

| Field | Value |
|---|---|
| **Feature ID** | F50 |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | PARTIAL — `/labeling` read-only; Phase D backend docs exist |
| **Competitive source** | Weave annotation queues; LangSmith; Laminar labeling queues; HoneyHive; Galileo |
| **UI spec** | [U06](../ui/u06-annotation-queue.md) |
| **Dependencies** | F53, F21, U01 bulk add, F73 (optional redaction) |

---

## 1. Summary

Production spans become review work: reserved queue items, schema rubrics, approve/discard, pairwise A/B, export to datasets. F21 tool labels are a subset — this is the full SME product.

---

## 2. Eden current state

| Component | Path | Status |
|---|---|---|
| `/labeling` DataTable | `clients/portal/.../labeling` | List only — no approve/skip |
| Phase D labeling docs | `docs/docs/observability/36-labeling-queue.md` | Backend intent |
| F21 tool call labels | spec | Narrow subset |
| Multi-select → queue from traces | — | MISSING |

---

## 3. Target behavior

1. Create queue with JSON schema (categorical, continuous, free-text fields).
2. Seed from traces multi-select, SQL export (F76), or dataset.
3. SME opens workstation: Data (read-only render) | Target (editable).
4. Reserve item (15m lease); approve/discard with hotkeys.
5. Pairwise mode: blind A/B, pick winner + margin → preference pairs.
6. Push approved → dataset; optional F77 finetune export.
7. IAA stats for multi-reviewer queues (Cohen's κ stretch).

---

## 4. Architecture

```
clients/portal/.../labeling/queues/[id]/page.tsx   # U06 workstation
src/eden/labeling/
  queues.py           # CRUD + seed
  reservations.py     # lease/heartbeat
  pairwise.py         # preference pairs
src/eden/api/routes/labeling.py
```
Render path: default transcript snippet OR F59 custom template.

---

## 5. Data model

```sql
CREATE TABLE labeling_queues (
  id UUID PRIMARY KEY, org_id UUID NOT NULL, name TEXT NOT NULL,
  schema JSONB NOT NULL, queue_type TEXT DEFAULT 'standard',
  render_template_id UUID, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE labeling_queue_items (
  id UUID PRIMARY KEY, queue_id UUID REFERENCES labeling_queues(id),
  trace_id UUID, span_id TEXT, data JSONB NOT NULL, target JSONB,
  status TEXT NOT NULL DEFAULT 'new',
  reserved_by TEXT, reserved_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE labeling_pairwise_results (
  id UUID PRIMARY KEY, queue_id UUID, item_a UUID, item_b UUID,
  winner TEXT, margin NUMERIC, reviewer TEXT, created_at TIMESTAMPTZ DEFAULT now());
```

---

## 6. API specification

```
GET/POST /orgs/{org}/labeling-queues
GET/POST /orgs/{org}/labeling-queues/{id}/items
POST     .../items/{id}/reserve|heartbeat|approve|discard
POST     .../seed-from-traces
POST     .../push-to-dataset
POST     .../pairwise/submit
```

---

## 7. Implementation plan

1. Tables + API CRUD/reserve/approve
2. Replace `/labeling` list with queue list + workstation (U06)
3. Seed from U01 bulk action
4. Pairwise mode
5. Push to F53 dataset

---

## 8. SDK / MCP / Portal

- Portal: see UI spec
- MCP: expose read tools where useful (F04)
- SDK: optional helpers

---

## 9. Feature flags & rollout

`features.f50_annotation_queues` — beta → GA

---

## 10. Test plan

- Unit: lease expiry, schema validation
- Integration: seed 50 traces → approve 10 → dataset appears in dataset
- E2E: hotkey approve path
- Pairwise: winner persisted

---

## 11. Acceptance criteria

- [ ] Workstation replace read-only table
- [ ] Hotkeys ⌘⏎ / ⌘⌫ / 1–9 work
- [ ] Reservations prevent double-edit
- [ ] Pairwise writes winner/loser
- [ ] Push to dataset + seed from traces
- [ ] Progress navigator matches Laminar segments

---

## 12. Performance & cost optimization

| Op | p50 | p95 |
|---|---|---|
| Item fetch | <100ms | <300ms |
| Approve | <80ms | <200ms |
| Seed 100 traces | <2s | <5s |
No LLM on critical path. Lease TTL 15m + heartbeat. Metrics: `eden_labeling_items_approved_total`.

### Degradation modes

- Flag off → portal empty state with docs link
- Dependency down → fail loud (no silent drop)

### Monitoring

```
eden_f50_duration_seconds
eden_f50_cost_usd_total
```

---

## 13. Dependencies

F53, F21, U01 bulk add, F73 (optional redaction)

Sequencing: [EDEN-MASTER-ROADMAP.md](../EDEN-MASTER-ROADMAP.md).
