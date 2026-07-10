# N07: Environment-from-Production-Failures (v2 — Codebase-Accurate)

| Field | Value |
|---|---|
| **Feature ID** | N07 |
| **Slug** | `environment-from-production-failures` |
| **Priority** | P0 |
| **Effort** | XL |
| **Eden status** | **PARTIAL** — fragments shipped; LangGraph runner **RETIRED** |
| **Market hypothesis** | Reproducible test worlds from prod failures — **category-defining** if wired |
| **Dependencies** | F29, F28, N14, `multi_agent/`, `patterns.py`, marketplace |

---

## 1. Problem

Production agent failures are hard to reproduce locally. Eden's **Part VIII** env-gen vision is documented across PRDs, but the **executable LangGraph pipeline was retired** (`pyproject.toml`, `enable_eval_pipeline=false`). Specs must not assume `/v1/jobs` env-gen works out of the box.

**What actually exists today:**

| Asset | Path | Status |
|---|---|---|
| Multi-agent planning lib | `src/eden/multi_agent/` | **SHIPPED** |
| Part VIII prompt seeds | `src/eden/kb/prompt_versions/seed.py` | **SHIPPED** |
| Pattern → job insert | `src/eden/api/routes/patterns.py:126–175` | **STUB** — inserts `jobs` row, **no worker** |
| Marketplace publish | `src/eden/marketplace/` | **SHIPPED**, gated |
| Evaluation / CI shells | `src/eden/evaluation/` | **SHIPPED**, gated |
| Procedural skills | `src/eden/kb/procedural/client.py` | **SHIPPED** |
| Issue → env wiring | — | **MISSING** |

N07 v2: **Reactivate env-gen as issue-driven orchestrator** using existing libs — not resurrect full LangGraph monolith in v1.

---

## 2. Target behavior (phased)

### Phase 1 — Failure bundle + fixture env (MVP)

```
F29 Issue + example traces
    → FailureBundleExtractor (tool results, API mocks, state JSON — PII redacted)
    → EnvSpecGenerator (LLM + multi_agent planning modules)
    → Output: docker-compose + mock server stubs + seed data YAML
    → generated_environments table
    → Developer: eden env up {env_id}
    → Verify: F28 stumble reproduces in local run
```

### Phase 2 — Marketplace + procedural skill

```
Successful env → publish to marketplace (existing routes)
    → ProceduralClient.insert skill template from env spec
    → N17 cockpit: "Repro environment ready"
```

### Phase 3 — Full Part VIII agent chain

Re-enable planner/critic/refiner chain behind `enable_eval_pipeline` flag when worker exists — **optional**, not blocking Phase 1.

---

## 3. Architecture (Phase 1)

```
┌──────────────┐     failure bundle      ┌─────────────────────────┐
│ F29 Issue    │ ───────────────────────►│ FailureBundleExtractor   │
│ + traces     │                         │ (trace_quality + spans)  │
└──────────────┘                         └───────────┬─────────────┘
                                                     │
                         ┌───────────────────────────┼───────────────────────────┐
                         ▼                           ▼                           ▼
                 multi_agent/planning          mock OpenAPI from          seed JSON from
                 (ReAct planner)               tool result attrs          tool results
                         │                           │                           │
                         └───────────────────────────┴───────────────────────────┘
                                                     │
                                                     ▼
                              EnvironmentSpec YAML + docker-compose
                                                     │
                    ┌────────────────────────────────┼────────────────────────────────┐
                    ▼                                ▼                                ▼
            generated_environments          patterns.generate-env job          F04 MCP
            (new table)                     (wire worker to process)           spawn_environment
```

**New modules:**
- `src/eden/environment/failure_bundle.py`
- `src/eden/environment/spec_generator.py`
- `src/eden/environment/worker.py` — processes `jobs` kind=`env_from_issue` | `env_from_pattern`

**Wire existing:** `patterns.py:126` job insert pattern; add worker consumer.

---

## 4. Data model

```sql
CREATE TABLE generated_environments (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    source_issue_id UUID,  -- FK when F29 shipped
    source_pattern_id TEXT,
    source_trace_ids UUID[] NOT NULL,
    spec_yaml TEXT NOT NULL,
    docker_compose TEXT,
    status TEXT CHECK (status IN ('generating','ready','failed','archived')),
    repro_verified BOOLEAN,
    repro_success_rate FLOAT,
    marketplace_listing_id UUID,
    skill_id UUID,  -- procedural KB link
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Extend jobs.payload for kind='env_from_issue'
```

---

## 5. Failure bundle schema (PII-safe)

```json
{
  "issue_fingerprint": "...",
  "agent_id": "checkout-v2",
  "tool_calls": [
    {"name": "stripe_charge", "args_redacted": {}, "result_summary": "currency mismatch"}
  ],
  "state_hints": {"cart_items": 2, "currencies": ["USD", "EUR"]},
  "api_mocks": [{"path": "/v1/charges", "method": "POST", "response_fixture": "..."}],
  "span_ids": ["..."]
}
```

Extract via `compliance/redact` + Cat 10 RTBF rules — **never** raw user PII.

---

## 6. Performance & cost optimization

| Phase | Cost | Time |
|---|---|---|
| Bundle extract | $0 SQL | p95 <5s |
| Spec generation (LLM) | ~$0.10–0.50/issue | p95 <3min async |
| Local `eden env up` | Customer infra | — |
| Worker queue | Bounded 5 concurrent/org | Backpressure |

**Do not run env-gen on every stumble** — trigger on:
- P0/P1 issue with ≥3 stumbles
- Manual "Generate repro env" button
- MCP `generate_environment(issue_id)`

**Storage:** Spec YAML ~10–50KB; docker-compose ~5KB. TTL archive 90d.

**Combined cost stack:** N16 sampling reduces traces; N07 runs only on high-value issues.

### Monitoring

```
eden_envgen_jobs_total{status}
eden_envgen_duration_seconds
eden_envgen_repro_success_rate
eden_envgen_cost_usd_total
```

---

## 7. MCP tools (F04)

| Tool | Purpose |
|---|---|
| `generate_environment` | Enqueue from issue_id |
| `get_environment_spec` | Download YAML + run instructions |
| `verify_reproduction` | Run agent stub, check stumble kind |

---

## 8. Acceptance criteria

- [ ] Phase 1: Issue → docker-compose env without LangGraph runner
- [ ] Worker processes `env_from_pattern` jobs (fixes patterns.py stub)
- [ ] ≥70% repro success on fixture issue set
- [ ] PII scan passes on all bundles
- [ ] MCP generate returns run command
- [ ] Phase 2: optional marketplace listing

---

## 9. Stand-out narrative

> "Turn production failures into **runnable test worlds** — Eden is the only observability platform that generates reproduction environments from live agent failures."

Competitors stop at trace replay; Eden adds **world synthesis** using existing multi-agent + KB infrastructure.

---

*See [`CODEBASE-GROUND-TRUTH.md`](../CODEBASE-GROUND-TRUTH.md) §2 KB/env gen. Do not reference retired LangGraph CLI.*
