# N07: Environment-from-Production-Failures

| Field | Value |
|---|---|
| **Feature ID** | N07 |
| **Slug** | `environment-from-production-failures` |
| **Priority** | P0 |
| **Effort** | XL |
| **Eden status** | **PARTIAL** (environment generation PRD exists; not wired to issues) |
| **Market hypothesis** | Synthetic test envs from real failures — **unique Eden capability** no competitor has |
| **Dependencies** | PRD Part VIII env gen, F29, F28, F01, N01 |

---

## 1. Problem

When production agents fail on edge cases (weird user input, API timeout, race condition), teams cannot reproduce locally because **environment state** differs. Eden's environment generation pipeline (Part VIII) can synthesize test worlds — but it is **not connected** to the issue/fix loop.

This is Eden's potential **category-defining** feature: production failure → synthetic environment → local repro → fix → verify.

---

## 2. Target behavior

```
Issue #2847 (checkout agent fails on dual-currency cart)
    → Triage extracts: tools called, API responses, user context (redacted)
    → EnvGen pipeline ingests failure bundle
    → Generates EnvironmentSpec:
        - Mock Stripe with dual-currency fixture
        - Cart state JSON from trace tool results
        - User session seed
    → Developer runs: eden env run env-2847 --agent checkout
    → Agent reproduces failure locally
    → Fix + F01 rerun in env → N01 regression case
```

---

## 3. Architecture

```
┌─────────────┐    failure bundle     ┌──────────────────┐
│ F29 Issue   │ ────────────────────► │ EnvGen Orchestrator│
│ + traces    │                       │ (Part VIII)        │
└─────────────┘                       └─────────┬──────────┘
                                                │
                    ┌───────────────────────────┼───────────────────────────┐
                    ▼                           ▼                           ▼
            Mock API specs              State fixtures              Tool mocks
            (from span attrs)           (from tool results)         (from recordings)
                    │                           │                           │
                    └───────────────────────────┴───────────────────────────┘
                                                │
                                                ▼
                                    EnvironmentSpec YAML + docker-compose
                                                │
                                                ▼
                                    F04 MCP: `spawn_environment(issue_id)`
```

---

## 4. Data model

```sql
CREATE TABLE generated_environments (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    source_issue_id UUID REFERENCES agent_issues(id),
    source_trace_ids UUID[] NOT NULL,
    spec_yaml TEXT NOT NULL,
    status TEXT CHECK (status IN ('generating','ready','failed','archived')),
    repro_success_rate FLOAT,  -- did local run reproduce stumble?
    created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 5. Safety & PII

- EnvGen **never** copies raw PII — use redacted span exports (Cat 10)
- Synthetic user IDs only
- Org policy: `env_gen_enabled` default false for HIPAA until reviewed
- Human approval queue for env specs touching external API mocks

---

## 6. MCP tools (F04)

| Tool | Purpose |
|---|---|
| `generate_environment` | Trigger env gen from issue_id |
| `get_environment_spec` | Download YAML + run instructions |
| `verify_reproduction` | Run agent in env, check stumble reproduces |

---

## 7. GTM positioning

**Headline:** "Turn production failures into reproducible test environments — automatically."

No competitor (Laminar, Sentrial, Raindrop, Bento) ships this. Eden PRD Part VIII is the foundation; N07 is the **product wiring**.

---

## 8. Acceptance criteria

- [ ] Issue with tool-error stumble triggers env gen job
- [ ] Generated docker-compose runs locally with `eden env up`
- [ ] ≥70% of generated envs reproduce original stumble kind (measured)
- [ ] MCP `generate_environment` returns spec + run command
- [ ] PII scan passes on all exported fixtures

---

*See [MARKET-HYPOTHESES.md](../MARKET-HYPOTHESES.md) §3.7 — Eden moat feature.*
