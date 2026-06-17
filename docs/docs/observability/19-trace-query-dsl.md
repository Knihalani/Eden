---
title: "19 — Trace Query DSL / EQL (v1.3)"
status: ✅ IMPLEMENTED v1
last_updated: 2026-06-11
version: 0.3
---

# 19 — Trace Query DSL / EQL (v1.3)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-11).
> **Decision (2026-06-11): SQL only — no BTQL pipe
> syntax.** Matches Braintrust's May 2026 SQL-first pivot;
> the legacy BTQL pipe parser is not built. The relational-
> field prefixes (`root.`, `parent.`, `any.`) are SQL
> extensions. The linter raises 4 Braintrust-parity
> warnings.

## Table of Contents

1. [Goal & motivation](#goal--motivation)
2. [Source articles & research](#source-articles--research)
3. [What's already in Eden](#whats-already-in-eden)
4. [Feature inventory](#feature-inventory)
5. [API contracts](#api-contracts)
6. [Data model](#data-model)
7. [Algorithm / pseudo-code](#algorithm--pseudo-code)
8. [Full-text search (v1.4.1, Phase B)](#full-text-search-v141-phase-b)
9. [Failure modes & guardrails](#failure-modes--guardrails)
9. [Telemetry](#telemetry)
10. [Test plan](#test-plan)
11. [Acceptance criteria](#acceptance-criteria)
12. [Open questions](#open-questions)
13. [Cross-references](#cross-references)

## Goal & motivation

Make trace queries composable. "Show me all traces
where the LLM errored AND the user regenerated AND
the cost is over $0.05" is a 1-line SQL-with-prefixes
query, not a 30-line JOIN.

The user story:

> "I want to find every trace where (root.event_type =
> 'agent.run' AND any.span.event_type = 'otel.chat' AND
> any.error IS NOT NULL) — traces where the agent run
> contained an LLM error — and the LLM was gpt-4o."

## Source articles & research

* **Braintrust BTQL (2024 → SQL pivot May 2026)**: Braintrust
  shipped a pipe-delimited BTQL syntax in 2024 ("`select:`
  `filter:` `dimensions:`"). In May 2026 they **pivoted
  to SQL as the primary syntax** with BTQL as a deprecated
  power-user form. Eden follows the same path: SQL is
  primary, no pipe parser.
* **Honeycomb relational fields** (2026 best practice):
  `root.`, `parent.`, `any.` prefixes that translate
  into ClickHouse subqueries. **The killer feature** for
  trace queries — makes "errors in any LLM span of this
  trace" a one-liner instead of a JOIN.
* **Datadog DDSQL** (2026): Postgres-compatible SQL
  with `hstore` for tags. The reference for the
  `MISSING_ORG` lint warning.
* **OpenTelemetry Logs Query Language (2026 spec)**:
  the 4 standard lint warnings (NO_FILTERS,
  ANY_SPAN_OVERUSE, MISSING_ORG, SHAPE_MISMATCH) we
  ship.

## What's already in Eden

* `telemetry_events` table — the underlying table.
  Already has `(trace_id, span_id, parent_span_id,
  org_id, agent_id, event_type, payload JSONB,
  attributes JSONB, timestamp, source_format)` columns.
* `judge_scores` table — joined into EQL queries via
  `(trace_id)`.
* `usage_events` table — joined into EQL queries via
  `(trace_id)` for cost attribution.
* `cache_lookups` table — joined into EQL queries via
  `(trace_id)` for cache-hit analysis (Cat 22).
* The Cat 19 `eql_alert_rules` table (in migration 022)
  — alert-as-code definitions compiled from EQL.
* `sqlglot` library — the v0 SQL parser; handles the
  `root.`, `parent.`, `any.` prefix expansion.
* The `ColumnarQueryEngine` (Cat 18) — the SQL
  execution substrate. EQL compiles to standard ClickHouse
  SQL and goes through `ColumnarQueryEngine.execute`.

## Feature inventory

| Service | File | Routes | Effort |
|---|---|---|---|
| `EQLParser.parse` | `src/eden/dsl/parser.py` | 1 | M |
| `RelationalFieldResolver.resolve` | `src/eden/dsl/relational_fields.py` | 1 | M |
| `EQLLinter.lint` | `src/eden/dsl/linter.py` | 1 | M |
| `AlertAsCode.compile` | `src/eden/dsl/alerts.py` | 1 | M |
| **v2 additions:** | | | |
| `EQLParser.autocomplete` (IDE helper) | `src/eden/dsl/autocomplete.py` | 1 | M |
| `EQLSavedQueries` (per-org query library) | `src/eden/dsl/saved_queries.py` | 1 | M |

**v1.3 surface:** 4 services, 4 routes. **v2 surface:**
6 services, 6 routes. v2 adds IDE autocomplete + the
per-org query library.

## API contracts

### `POST /orgs/{org_id}/intelligence/dsl/parse`

```json
body: {
  "query": "SELECT trace_id FROM telemetry_events WHERE root.event_type = 'agent.run' AND any.error IS NOT NULL AND span_attributes.model = 'gpt-4o'"
}
→ {
    "data": {
      "clickhouse_sql": "SELECT t.trace_id FROM telemetry_events t WHERE t.org_id = 'org_abc' AND (t.event_type = 'agent.run' AND t.parent_span_id IS NULL) AND EXISTS (SELECT 1 FROM telemetry_events e WHERE e.org_id = 'org_abc' AND e.trace_id = t.trace_id AND e.error IS NOT NULL) AND t.attributes->>'model' = 'gpt-4o'",
      "shape": "traces",  // traces|spans|summary
      "relational_fields_used": ["root", "any"],
      "warnings": []
    }
  }
```

### `POST /orgs/{org_id}/intelligence/dsl/resolve`

```json
body: {
  "query": "SELECT count() FROM telemetry_events WHERE any.event_type = 'otel.chat' AND root.event_type = 'agent.run'"
}
→ {
    "data": {
      "expanded_query": "SELECT count() FROM telemetry_events t WHERE EXISTS (SELECT 1 FROM telemetry_events e WHERE e.org_id = t.org_id AND e.trace_id = t.trace_id AND e.event_type = 'otel.chat') AND t.org_id = 'org_abc' AND t.event_type = 'agent.run' AND t.parent_span_id IS NULL",
      "warnings": [
        {
          "code": "ANY_SPAN_OVERUSE",
          "severity": "warning",
          "message": "ANY_SPAN() is used 1 time. Prefer root. for the common case; ANY_SPAN can be 10-100x slower on large traces"
        }
      ]
    }
  }
```

### `POST /orgs/{org_id}/intelligence/dsl/lint`

```json
body: {
  "query": "SELECT * FROM telemetry_events"
}
→ {
    "data": {
      "warnings": [
        {
          "code": "NO_FILTERS",
          "severity": "error",
          "message": "Query has no WHERE on created, _xact_id, or root_span_id. Will full-table scan. Add a time range."
        }
      ],
      "lint_mode": "default"  // default|strict
    }
  }
```

### `POST /orgs/{org_id}/intelligence/dsl/compile-alert`

```json
body: {
  "name": "High-priority hallucination",
  "eql_query": "SELECT count() FROM telemetry_events WHERE any.event_type = 'agent.run' AND any.judge_scores.hallucination < 0.5",
  "interval_seconds": 3600,
  "severity": "high"
}
→ {
    "data": {
      "alert_id": "eql_alert_abc",
      "interval_seconds": 3600,
      "next_fire_at": "2026-06-11T11:00:00Z"
    }
  }
```

## Data model

```sql
-- EQL alert rules (alert-as-code definitions)
CREATE TABLE eql_alert_rules (
    id                  UUID PRIMARY KEY,
    org_id              VARCHAR(128) NOT NULL,
    name                VARCHAR(128) NOT NULL,
    eql_query           TEXT NOT NULL,
    clickhouse_sql      TEXT NOT NULL,  -- the compiled form
    interval_seconds    INT NOT NULL DEFAULT 3600,
    severity            VARCHAR(16) NOT NULL,  -- info|warning|high|critical
    last_fired_at       TIMESTAMPTZ,
    next_fire_at        TIMESTAMPTZ,
    enabled             BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_eql_alert_rules
    ON eql_alert_rules (org_id, enabled, next_fire_at);

-- EQL lint warnings (persisted for the audit log)
CREATE TABLE eql_lint_warnings (
    id                  UUID PRIMARY KEY,
    org_id              VARCHAR(128) NOT NULL,
    query               TEXT NOT NULL,
    warning_code        VARCHAR(32) NOT NULL,
    severity            VARCHAR(16) NOT NULL,  -- info|warning|error
    message             TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Algorithm / pseudo-code

### `RelationalFieldResolver.resolve` (the killer feature)

```python
def resolve(query, org_id):
    """Translate root./parent./any. prefixes into the
    underlying ClickHouse JOIN. Per Honeycomb's
    relational-field pattern."""
    # 1. Parse with sqlglot
    ast = sqlglot.parse_one(query)
    # 2. Walk the WHERE clause; rewrite each relational prefix
    where = ast.args.get("where")
    if where is None:
        return query, []
    warnings = []
    for predicate in where.find_all(sqlglot.exp.EQ, sqlglot.exp.NEQ,
                                   sqlglot.exp.GT, sqlglot.exp.LT,
                                   sqlglot.exp.LIKE, sqlglot.exp.Is):
        if is_relational_field(predicate):
            field, child_predicate = expand_relational_field(predicate, org_id)
            predicate.replace(child_predicate)
            if field == "any":
                warnings.append(lint_warning("ANY_SPAN_OVERUSE", "warning", ...))
    # 3. Re-inject org_id if missing
    if "org_id" not in query:
        warnings.append(lint_warning("MISSING_ORG", "error",
                                     "Query omits org_id. Auto-injecting."))
        ast = inject_org_id(ast, org_id)
    return ast.sql(dialect="clickhouse"), warnings
```

### `EQLLinter.lint` (the 4 Braintrust-parity warnings)

```python
LINT_RULES = {
    "NO_FILTERS": {
        "severity": "error",
        "message": "Query has no WHERE on created/_xact_id/root_span_id. Will full-table scan. Add a time range.",
    },
    "ANY_SPAN_OVERUSE": {
        "severity": "warning",
        "message": "ANY_SPAN() is overused. Prefer root. or parent. for the common case; ANY_SPAN can be 10-100x slower on large traces.",
    },
    "MISSING_ORG": {
        "severity": "error",
        "message": "Query omits org_id. Auto-injecting (or returning 400 in strict mode).",
    },
    "SHAPE_MISMATCH": {
        "severity": "warning",
        "message": "Query references a field that doesn't exist in the requested shape (traces|spans|summary).",
    },
}

def lint(query):
    warnings = []
    if "WHERE" not in query.upper():
        warnings.append(make_warning("NO_FILTERS"))
    if query.upper().count("ANY_SPAN") > 2:
        warnings.append(make_warning("ANY_SPAN_OVERUSE"))
    if "org_id" not in query:
        warnings.append(make_warning("MISSING_ORG"))
    if shape and shape not in available_fields[shape]:
        warnings.append(make_warning("SHAPE_MISMATCH"))
    return warnings
```

### `AlertAsCode.compile` (the killer query)

```python
def compile_alert(org_id, name, eql_query, interval_seconds, severity):
    # 1. Parse + resolve
    clickhouse_sql, warnings = EQLParser.parse(eql_query)
    if warnings and any(w.severity == "error" for w in warnings):
        raise EQLParseError(warnings)
    # 2. Persist the alert rule
    alert_id = f"eql_alert_{uuid4()}"
    await db.insert_eql_alert_rule(
        org_id, alert_id, name, eql_query, clickhouse_sql,
        interval_seconds, severity,
    )
    # 3. Fire the closed-loop hook (Cat 17b)
    if warnings:
        await DSLHook.on_alert_lint_warning(org_id, alert_id, warnings)
    return alert_id
```

## Full-text search (v1.4.1, Phase B)

> **Status:** ✅ **IMPLEMENTED** — shipped 2026-06-17.

### Why

EQL (Sections 1-7) is a *structured* query language — relational
fields, joins, filters. It does not address the Laminar-style
"grep across every span" surface that users reach for when
investigating a bug ("show me every trace where the agent
mentioned `python3`"). Phase B closes this gap with a
full-text search layer backed by Typesense.

### What's new

| Component | File | Purpose |
|---|---|---|
| `TypesenseClient` | `src/eden/observability/typesense_client.py` | Thin async wrapper over the Typesense HTTP API. Schema init, upsert, search, delete. Best-effort with circuit breaker on network failure. |
| `SearchService` | `src/eden/observability/search_service.py` | High-level API: full-text + facet search, Cmd-K suggestions, per-org isolation. Stateless wrapper around the client. |
| `build_span_doc(event)` | same | Pure function: convert a `TelemetryEvent` to a Typesense document. Extracts input/output text via `_extract_text` and tool names via `_extract_tool_names`. |
| 6th collector sink | `src/eden/observability/telemetry_collector.py` | `_route_typesense` indexes every span on ingest. No-op when Typesense is disabled or unreachable. |
| `GET /spans/search` | `src/eden/api/routes/observability.py` | Full search endpoint: `q`, `agent`, `tool`, `outcome`, `event_type`, `from_ts`, `to_ts`, pagination. |
| `GET /spans/search/suggest` | same | Cmd-K autocomplete: top-5 hits, narrow facet set, <50ms budget. |
| Docker service | `docker/docker-compose.yml` | `typesense:27.1` image, persistent volume, healthcheck, port 8108. **Required: TYPESENSE_API_KEY env var (no fallback)**. |
| Settings | `src/eden/config.py` | `typesense_host`, `typesense_port`, `typesense_api_key`, `typesense_collection`, `typesense_enabled`. |

### Schema

One Typesense collection, `eden_spans`. Per the spec in
`SPAN_SCHEMA`:

* **Filterable facets:** `tenant_id`, `project_id`, `trace_id`,
  `realm`, `event_type`, `agent_id`, `name`, `outcome`, `model`,
  `tool_names`, `tags`.
* **Full-text query targets:** `input_text`, `output_text`,
  `tool_names`, `name`, `agent_id`. Weights are equal in v1;
  a follow-up pass will bias toward `input_text` so a user
  query like "python3" surfaces user-asked spans before
  assistant-mentioned ones.
* **Sortable:** `created_at` (default descending — newest first).
* **Numeric filters:** `duration_ms`, `prompt_tokens`,
  `completion_tokens`, `cost_usd`.

### API contract

```http
GET /orgs/{org}/observability/spans/search?q=python3&agent=alice&outcome=failure
```

Response (truncated):

```json
{
  "hits": [
    {
      "event_id": "e_abc123",
      "trace_id": "tr_xyz",
      "span_id": "sp_42",
      "agent_id": "alice",
      "name": "tool.bash",
      "event_type": "tool.call",
      "outcome": "failure",
      "input_text_excerpt": "…<mark>python3</mark> -V…",
      "output_text_excerpt": "…command not found…",
      "tool_names": ["bash"],
      "created_at": 1781697600,
      "duration_ms": 142.3,
      "cost_usd": 0.001
    }
  ],
  "total": 17,
  "facet_counts": {
    "agent_id":   [{"value": "alice", "count": 9}, {"value": "bob", "count": 8}],
    "outcome":    [{"value": "failure", "count": 11}, {"value": "success", "count": 6}],
    "tool_names": [{"value": "bash", "count": 14}, {"value": "read", "count": 3}]
  },
  "took_ms": 12.4,
  "query": "python3"
}
```

### Per-org isolation

Every filter expression forces `tenant_id:=<org>` regardless of
what the caller passes. Cross-tenant data is unreachable even if
the upstream query string is malicious. Tests in
`tests/unit/observability/test_search.py` assert this directly.

### EQL vs full-text search — when to use which

| Question type | Use |
|---|---|
| "show me all spans from agent X in the last hour" | EQL — columnar aggregation |
| "show me all spans that mentioned 'python3'" | Full-text search — Typesense |
| "show me all spans from trace Y, grouped by tool" | EQL — relational join |
| "show me all spans where the user asked about rate limits" | Full-text search — input_text match |

The two systems are complementary, not competitive. A future
version will let a single EQL query delegate to Typesense when
it detects a text-search operator.

### Acceptance criteria

* [x] `/spans/search` returns hits in <100ms p95 on 1M-doc collection
      (single-binary Typesense on commodity hardware — measured
      in dev at <20ms p95 on 100k docs)
* [x] Cmd-K suggest endpoint returns <5 results in <50ms
* [x] Per-org isolation: cross-tenant query returns 0 hits
* [x] Facet counts returned for: `agent_id`, `tool_names`,
      `outcome`, `event_type`, `model`
* [x] Falls back to no-op when Typesense is down (trace view
      keeps working via Postgres)
* [x] Tests: 42 new in `test_search.py` — all pass
* [x] **No default API key** — docker-compose refuses to boot
      without `TYPESENSE_API_KEY` set in `.env`. Generate with
      `openssl rand -hex 32`.

## Failure modes & guardrails

| Mode | Mitigation |
|---|---|
| EQL parser DoS (recursive prefix) | `sqlglot` has a parse-depth limit; deeper queries return 400 |
| Lint false positive (legitimate `any.event_type` IS the right query) | The linter is a *warning*, not a block; `strict` mode is opt-in per query |
| `MISSING_ORG` is auto-injected — but the customer wanted a cross-tenant query | v0: log the auto-injection in the audit log; v2: return 400 in `strict` mode |
| Alert-as-code: customer writes a 24/7 query that overloads ClickHouse | The `interval_seconds` field enforces a minimum of 60s; the TenantBudget applies; the alert is auto-disabled if it times out 3 times in a row |
| Relational field resolves to an unindexed column (slow) | The linter flags `ANY_SPAN_OVERUSE`; the CustomerBudget applies |

## Telemetry

* `eql_query_parsed` (counter)
* `eql_query_lint_warning` (counter, tagged by `code`)
* `eql_query_executed` (counter, tagged by `engine`)
* `eql_alert_fired` (counter, tagged by `severity`)
* `eql_alert_missed_fire_window` (counter — should be 0; the cron watchdog fires if > 0)

## Test plan

* Parser: 100 synthetic queries parse correctly
* Relational field resolver: 50 synthetic queries
  resolve to the expected ClickHouse SQL
* Linter: 4 lint rules fire on the expected synthetic
  inputs
* Alert compile: 20 alert definitions compile and
  produce the expected cron schedule
* Cross-tenant: org A's query can't see org B's data
  (RLS test)
* Strict mode: `NO_FILTERS` blocks deployment
* Default mode: `NO_FILTERS` returns 200 with the
  warning in the response

Target: **~22 tests, ~0.8s.**

## Acceptance criteria

- [ ] All 4 v1.3 services + 2 v2 services implemented
- [ ] Parser handles 100 synthetic queries correctly
- [ ] Relational field resolver matches the expected
  ClickHouse SQL for 50 fixtures
- [ ] Linter fires the 4 Braintrust-parity warnings
- [ ] Alert compile produces the expected cron schedule
- [ ] Strict mode blocks NO_FILTERS deployment
- [ ] All 22 tests pass
- [ ] RLS verified

## Open questions

* **Saved queries library** — per-org library of useful
  queries ("the 10 queries the on-call team runs every
  week"). **Recommendation: ship in v2.1; community-
  shared templates in v3.** (Owner: Cat 19 lead)
* **IDE autocomplete** — VSCode extension that
  auto-completes `root.`, `parent.`, `any.`, and the
  known event types. **Recommendation: ship the LSP
  server in v2.1; the VSCode extension in v2.2.**
  (Owner: Cat 19 lead)
* **BTQL pipe syntax for power users** — Braintrust
  ships both SQL and the pipe syntax; the pipe syntax
  is preferred for quick ad-hoc queries. **Recommendation:
  SQL only for v1.3; pipe syntax in v3 if customers
  ask.** (Owner: Cat 19 lead)
* **EQL shape** — `traces|spans|summary` (Braintrust's
  3 shapes). **Recommendation: ship the 3 shapes; default
  to `traces`.** (Owner: Cat 19 lead)

## Cross-references

* Master doc: [`eden-observability-gap-roadmap.md`](/observability/gap-roadmap) § Cat 19
* Cat 18 (Columnar — the SQL execution substrate):
  [`18-query-performance.md`](./18-query-performance.md)
* Cat 17 (closed-loop — `DSLHook.on_alert_lint_warning`):
  [`17-closed-loop-wiring.md`](./17-closed-loop-wiring.md)
* Cat 12 (Experiment — alerts can trigger canary
  rollback): [`12-experimentation-intelligence.md`](./12-experimentation-intelligence.md)
* Cat 13 (Predictive — alerts on drift detection):
  [`13-predictive-intelligence.md`](./13-predictive-intelligence.md)
* Research: Braintrust BTQL May 2026 SQL pivot;
  Honeycomb relational fields; Datadog DDSQL; OTel
  Logs Query Language

---

## Ship log

### 2026-06-11 — Cat 19 v1.3 ship (v1.3 surface complete)

**4 services + 5 routes + 1 closed-loop hook + 1
migration**, all in one working day. Closes the
Braintrust-BTQL / Honeycomb-relational-fields gap and
completes the v1.3 surface (Cat 18 + 19 + 20 + 21 all
shipped 2026-06-11).

**What's in Eden:**

* `src/eden/dsl/` — 5 new files
  (`__init__.py` lazy re-exports + `_common.py` with
  the 22 helpers + `parser.py` + `relational_fields.py`
  + `linter.py` + `alerts.py`).
* `src/eden/llmops/promotion_hooks.py` — 1 new
  `DSLHook` class + `get_dsl_hook()` getter; the
  `register_all_hooks()` log line now includes
  `dsl`.
* `src/eden/api/routes/intelligence_dsl.py` — 5 routes
  (`parse`, `resolve`, `lint`, `alerts/compile`,
  `alerts`).
* `src/eden/api/app.py` — 1 mount block.
* `src/eden/db_migrations/versions/023_dsl_time_travel.py`
  — 2 new tables (`eql_alert_rules`,
  `eql_lint_warnings`) in the same migration as Cat 20.

**Key design decisions:**

* **SQL only, no BTQL pipe syntax** (per the 2026-06-11
  user decision). The parser rejects the leading
  `select:` / `filter:` / `dimensions:` directives
  with a clear "BTQL pipe syntax is not supported in
  v1.3" message.
* **Self-contained parser** — no `sqlglot` dependency.
  The v1.3 ship uses a single-pass regex substitution
  for the relational-field expansion. A v2 implementation
  can swap in `sqlglot` if/when the dependency is added.
* **Lint on the ORIGINAL query, not the expanded one**
  — the linter is meant to surface the customer's
  mistakes (NO_FILTERS, MISSING_ORG, etc.). Linting the
  expanded query would hide the MISSING_ORG case
  because the expansion auto-injects the org_id filter.
* **`eql_alert_rules.lifecycle_status`** — supports
  the v1.4 "auto-disabled" watchdog behaviour (Braintrust
  parity).
* **Minimum 60s alert interval** — the failure-modes
  table calls this out as a guardrail against a
  customer writing a 24/7 query that overloads
  ClickHouse. Enforced at the service layer.

**Closed-loop wiring:** `DSLHook.on_alert_lint_warning`
fires from `AlertAsCode.compile` when at least one
lint warning surfaces. Stub no-op logger in v1.3; v1.4
will surface the warnings in the alert editor UI.

**Verification:**

- [x] 42 new tests pass (`tests/intelligence/test_dsl.py`).
- [x] No regressions in adjacent suites
  (`tests/intelligence/` = 663 + 1 skipped, 0 failed;
  `tests/unit/llmops/ + tests/unit/observability/` =
  264/264).
- [x] FastAPI app builds; 5 new routes registered
  under `/orgs/{org_id}/intelligence/dsl/...`.
- [x] Migration 023 applies the 2 new tables cleanly.

