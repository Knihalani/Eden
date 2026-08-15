---
title: "32 — Read-only SQL query surface (Phase M)"
status: IMPLEMENTED v1
last_updated: 2026-06-17
version: 1.0
---

# 32 — Read-only SQL query surface (Phase M)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-17).
> Closes the Logfire / RagaAI "ask a SQL question" gap.
> Single SELECT against an allowlist of 15 analytics tables,
> tenant-injected `org_id` filter, row cap + statement timeout.
> Marketing wedge: "AI assistants excel at SQL." The unified
> AI agent (Phase C) writes the query; this surface runs it.
> ~480 LOC backend + 57 unit tests.

## Goal & motivation

Every modern observability tool ships a SQL surface. The user's
question is never "can I write SQL?" — it's "what tables can I
query, and will you keep me from blowing up prod?". This
phase ships the answer to both.

The unified AI agent (Phase C) was the trigger: the agent can
already write SQL, but the only way to run it was to give the
user a copy of the query and tell them to paste it into a
client. That's a UX dead end. Phase M gives the agent a
server-side `run_sql()` tool so the loop closes:

  User asks: "what was the p99 latency for claude-opus-4 last
  Tuesday?"
    → Agent writes: `SELECT date_trunc('hour', created_at),
      percentile_disc(0.99) WITHIN GROUP (ORDER BY
      duration_ms) FROM telemetry_events WHERE agent_id =
      'claude-opus-4' AND created_at > now() - interval '7
      days' GROUP BY 1 ORDER BY 1;`
    → Executor: validates → injects `AND org_id = '...'` →
      wraps in row-cap CTE → runs → returns 168 rows.
    → Agent: renders as a line chart (Phase C).

## What's in Eden

### The executor

`SqlExecutor.execute(sql, org_id=..., params=...)` returns a
`SqlResult(columns, rows, row_count, truncated, execution_ms,
cap_hit)`. Seven guards in order:

1. **Empty/comment-only check** — `""` and `"-- foo"` rejected
   with `SqlForbiddenStatementError`.
2. **Single-statement check** — anything with `;` followed by
   more content rejected with `SqlMultiStatementError`. A
   trailing `;` is allowed.
3. **Statement guard** — leading keyword must be `SELECT` or
   `WITH`. INSERT / UPDATE / DELETE / MERGE / TRUNCATE / DROP
   / ALTER / CREATE / GRANT / REVOKE / COPY / VACUUM /
   REINDEX / CLUSTER / LOCK / CALL / DO / SET / RESET /
   DISCARD / LISTEN / NOTIFY / REFRESH / EXPLAIN / SHOW all
   rejected with `SqlForbiddenStatementError`.
4. **Table allowlist** — only the 15 tables in
   `ALLOWED_TABLES` (below) may appear in FROM / JOIN. Other
   tables → `SqlUnknownTableError`.
5. **Schema qualifier** — only `public.<table>` allowed; any
   other schema → `SqlUnknownTableError`.
6. **Tenant injection** — every tenant-scoped table reference
   is auto-rewritten to filter on `org_id = '<org_id>'`. The
   rewriter appends a WHERE if missing, ANDs into an existing
   WHERE if present. The org_id is single-quote-escaped.
7. **Row + time caps** — query is wrapped in
   `WITH _user_query AS (...) SELECT * FROM _user_query LIMIT
   N+1` and runs with `SET LOCAL statement_timeout = M`.

### Allowed tables (15)

| Table | Source | Notes |
|---|---|---|
| `telemetry_events` | Phase 7.0 | The main LLM span stream |
| `trace_messages` | Phase A | Content-addressed message dedup |
| `judge_scores` | Cat 3 | LLM-as-judge eval results |
| `usage_events` | Cat 8 | Token + cost usage |
| `outcomes` | Cat 11 | Per-department outcome attribution |
| `incidents` | Cat 2 | Incident clusters |
| `drift_alerts` | Cat 13 | PSI drift alerts |
| `datasets` / `dataset_items` | Cat 3 / Cat 12 | Eval datasets |
| `experiments` / `experiment_assignments` | Cat 12 | A/B test infra |
| `predictions` | Cat 13 | Multi-day forecasts |
| `saved_searches` | Phase N | So users can JOIN against them |
| `org_members` | Cat 10 | Read-only ABAC roster |
| `agent_registrations` | Cat 6 | Agent identity + lifecycle |

Tables explicitly NOT in the allowlist:

- `users` (PII — emails, password hashes)
- `secrets` (API keys, OAuth tokens)
- `api_keys` (org API keys)
- `pg_*` (system catalogs)
- `information_schema.*` (introspection is in the schema route, not the executor)

### Caps

| Cap | Default | Hard max | Override |
|---|---|---|---|
| Row limit | 1000 | 10000 | `max_rows` per request, or `Settings.sql_max_rows` per org |
| Time limit | 30s | 120s | `max_seconds` per request, or `Settings.sql_max_seconds` per org |

A truncated result sets `truncated=true` and
`cap_hit="row_limit"`. A timed-out query raises
`SqlTimeoutError` (HTTP 408).

### Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/orgs/{org}/sql/execute` | yes | Run a query |
| `GET` | `/orgs/{org}/sql/schema` | yes | List allowed tables + columns |
| `GET` | `/orgs/{org}/sql/limits` | yes | Current row + time caps |

## Example session

```bash
# Get the schema.
curl -H "Authorization: Bearer $JWT" \
     https://app.eden.example/orgs/myorg/sql/schema
# {
#   "tables": [
#     {"table": "telemetry_events", "columns": [
#       {"name": "id", "type": "uuid"},
#       {"name": "org_id", "type": "uuid"},
#       {"name": "event_type", "type": "text"},
#       ...
#     ]},
#     ...
#   ]
# }

# Run a query.
curl -X POST -H "Authorization: Bearer $JWT" \
     -H "Content-Type: application/json" \
     -d '{
       "sql": "SELECT date_trunc('\''hour'\'', created_at) AS bucket, count(*) AS n FROM telemetry_events WHERE event_type = :etype GROUP BY 1 ORDER BY 1 DESC LIMIT 24",
       "params": {"etype": "llm.completion"}
     }' \
     https://app.eden.example/orgs/myorg/sql/execute
# {
#   "columns": ["bucket", "n"],
#   "rows": [["2026-06-17T11:00:00Z", 4321], ...],
#   "row_count": 24,
#   "truncated": false,
#   "execution_ms": 23.4,
#   "cap_hit": null
# }
```

The executor rewrote the user's query to:

```sql
WITH _user_query AS (
  SELECT date_trunc('hour', created_at) AS bucket,
         count(*) AS n
  FROM telemetry_events
  WHERE event_type = $1
    AND org_id = 'org-42'
  GROUP BY 1
  ORDER BY 1 DESC
  LIMIT 24
)
SELECT * FROM _user_query LIMIT 1001
```

— and ran it inside a transaction with
`SET LOCAL statement_timeout = 30000`.

## What's NOT in this phase (deferred)

- **Federated queries** — only Postgres. ClickHouse / Qdrant
  joins come later. Cat 18 already has the columnar engine for
  hot data, but the SQL surface is Postgres-only for now.
- **Custom functions** — the user can't define or call UDFs.
  Anything they want they have to express in pure SQL.
- **CTE write** — the user can't `INSERT INTO ... SELECT` to
  build a derived table. They can save the result to
  `saved_searches` (Phase N) and reference it later, but
  they can't materialise it as a table.
- **Visual query builder** — the user writes SQL. A visual
  builder is a Phase E (UI polish) item.
- **Query history + cost tracking** — every query's
  `execution_ms` is captured in the response; a separate
  route to fetch "all queries I've run" + "total time spent"
  is a future cat.

## Failure modes

| Failure | Behaviour |
|---|---|
| Empty / comment-only SQL | `SqlForbiddenStatementError` → 400 |
| Multi-statement (e.g. `SELECT 1; DROP TABLE x`) | `SqlMultiStatementError` → 400 |
| Non-SELECT (INSERT, UPDATE, DELETE, DDL, EXPLAIN, ...) | `SqlForbiddenStatementError` → 400 |
| FROM references a non-allowlisted table | `SqlUnknownTableError` → 400 |
| Schema-qualified `private.users` | `SqlUnknownTableError` → 400 |
| Query with no tenant-scoped table | `SqlUnknownTableError` → 400 (no point serving unscoped data) |
| `statement_timeout` hit | `SqlTimeoutError` → 408 |
| Postgres permission error (e.g. SELECT from `users`) | Bubbles as 500 (the table isn't in the allowlist, so we shouldn't hit this — but if we do, surface it loudly) |

## Telemetry

- `sql.executed` event (counter) — fires on every successful
  execute. Payload: `{org_id, row_count, execution_ms, truncated}`.
- `sql.rejected` event (counter) — fires on every guard
  failure. Payload: `{kind: forbidden_statement | multi_statement | ...}`.
- `sql.timeout` event (counter) — fires on every timeout.

These flow into the same pipeline as LLM spans; the AI agent
can search "all SQL queries that hit the time cap last week".

## Why now

The SQL surface is the "natural-language-to-SQL" wedge. With
Phase C (unified agent) shipped, the agent can write SQL but
can't run it. With Phase M shipped, the loop closes — and
Eden gets a *meaningfully better* demo than Laminar on the
"ask in plain English, get a chart" axis.

## Tests

57 unit tests in `tests/unit/observability/test_sql_executor.py`:

- `TestStatementGuard` (24) — SELECT / WITH pass; INSERT /
  UPDATE / DELETE / DROP / ALTER / CREATE / TRUNCATE / MERGE /
  GRANT / REVOKE / COPY / VACUUM / REINDEX / CLUSTER /
  EXPLAIN / SHOW / SET / RESET all rejected; empty +
  comment-only rejected; multi-statement rejected; trailing
  `;` and `-- foo;` comments OK.
- `TestTableAllowlist` (12) — known tables pass; `users` /
  `secrets` / `api_keys` / `pg_*` / `information_schema.*`
  rejected; `private.telemetry_events` rejected; allowlist
  sanity check.
- `TestTenantInjection` (5) — appends WHERE when missing;
  ANDs into existing WHERE; escapes single quotes in org_id;
  no-tenant-table rejected; no-FROM allowed.
- `TestParamBinding` (3) — `:name` → `$1`; unbound params
  left intact; multiple params.
- `TestRowCap` (5) — truncation flag set; no truncation under
  cap; max_rows clamped to hard cap; default cap; columns
  preserved.
- `TestTimeoutDetection` (3) — `QueryCanceledError` detected
  by class name; by SQLSTATE 57014; unrelated errors
  rejected.
- `TestTimeoutExecution` (1) — full execute with timeout
  raises `SqlTimeoutError`.
- `TestSchemaSummary` (2) — known tables present; columns
  populated.
- `TestSqlResult` (1) — defaults.

All 57 pass; 0 regressions in the existing 350-test
`tests/unit/observability/` suite.

## Cross-references

- [Cat 18 — Query Performance](18-query-performance.md) —
  the columnar engine + Postgres-fdw this surface reuses.
- [Cat 19 — Trace Query DSL](19-trace-query-dsl.md) — the
  EQL parser is the sibling surface; this is the SQL sibling.
- [Phase C — unified AI agent](14-autonomous-intelligence.md)
  — the agent uses this surface as one of its tools.
- [Phase N — saved searches](31-public-traces-saved-searches.md)
  — saved SQL queries are persisted in `saved_searches`; the
  portal re-runs them through this surface.
