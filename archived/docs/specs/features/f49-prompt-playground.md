# F49: Production Prompt Playground

| Field | Value |
|---|---|
| **Feature ID** | F49 |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | SHIPPED v0 — `/orgs/{org_id}/playgrounds` API (`api/routes/playgrounds.py`: CRUD, from-span, run, run/stream, promote-experiment), `src/eden/playground/` engine, portal `/playgrounds` page (`clients/portal/src/app/(portal)/playgrounds/`) |
| **Competitive source** | Braintrust Playgrounds; Arize Prompt Playground; LangSmith; Laminar playgrounds; Weave |
| **UI spec** | [U03](../ui/u03-playground.md) |
| **Dependencies** | F53 datasets, F51 experiments, provider API keys, U01 open-from-span |

---

## 1. Summary

Side-by-side prompt/model/tool iteration on production spans and dataset rows. Mutable runs (re-run overwrites). Exit ramps: save prompt version, promote to immutable experiment.

---

## 2. Eden current state

| Component | Status |
|---|---|
| `/prompts` version list | PARTIAL |
| `/debugger` checkpoint rerun | Different product (F01) |
| `/studio` metric rubrics | Not a playground |
| Cat 41 prompt backend | Stub / partial |
| Span → playground | MISSING |

---

## 3. Target behavior

1. Create playground with 1–N tasks (prompt configs).
2. Optionally bind dataset; map `{{input}}` / `{{expected}}` / metadata.
3. Run matrix (⌘⏎); stream outputs + scores.
4. Diff outputs; comparison grades (improvement/regression/tradeoff/tie).
5. Save as prompt version or create F51 experiment.
6. Open from LLM span: inherit messages, model, tools, images.

---

## 4. Architecture

```
clients/portal/.../playgrounds/
src/eden/playground/
  service.py          # CRUD + run orchestration
  runner.py           # concurrent task execution via AIGateway
  diff.py             # output diff + grades
src/eden/api/routes/playgrounds.py
```

Runs use org provider keys; cost attributed to `playground_runs`.

---

## 5. Data model

```sql
CREATE TABLE playgrounds (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL,
  name TEXT NOT NULL,
  config JSONB NOT NULL,  -- tasks, scorers, dataset_id, params
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE playground_runs (
  id UUID PRIMARY KEY,
  playground_id UUID REFERENCES playgrounds(id),
  org_id UUID NOT NULL,
  status TEXT NOT NULL,
  results JSONB,
  cost_usd NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 6. API

```
GET/POST   /orgs/{org}/playgrounds
GET/PATCH  /orgs/{org}/playgrounds/{id}
POST       /orgs/{org}/playgrounds/{id}/run
POST       /orgs/{org}/playgrounds/{id}/promote-experiment
POST       /orgs/{org}/playgrounds/from-span   { trace_id, span_id }
```

SSE: `/playgrounds/{id}/run/{run_id}/events`

---

## 7. Implementation plan

1. API + tables
2. Portal list/detail (U03)
3. from-span wiring in U01
4. Scorer attachment + diff grades
5. Promote to F51 + save prompt

---

## 8. Feature flags

`portal.playgrounds` — default off → beta orgs → on.

---

## 9. Test plan

- Unit: diff grades; template var expansion
- Integration: run 5-row dataset × 2 tasks
- E2E: span → playground → experiment

---

## 10. Acceptance criteria

- [ ] Side-by-side ≥2 tasks with scores
- [ ] from-span prefills correctly
- [ ] Promote experiment + save prompt
- [ ] Shared URL loads config for org member
- [ ] Cost meter visible; stop cancels in-flight

---

## 11. Performance & cost optimization

| Operation | p50 | p95 |
|---|---|---|
| Create playground | <100ms | <300ms |
| Run overhead (excl provider) | <200ms | <1s |
| Stream first token relay | <100ms | <400ms |

- Concurrency cap default 5; org budget soft-cap $/day
- Optional cache key `(prompt_hash, model, input_hash)` TTL 1h
- Degradation: provider down → cell error, other cells continue
- Metrics: `eden_playground_run_seconds`, `eden_playground_cost_usd_total`

---

## 12. Dependencies

F53, F51, F68 (optional save→env), U03, provider keys settings.
