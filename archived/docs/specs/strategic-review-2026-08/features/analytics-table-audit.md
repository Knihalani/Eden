# FEAT-161 — Analytics table-reference audit

**Date:** 2026-08-06  
**Feature:** FEAT-161  
**Scope:** Every SQL / table reference under `src/eden/analytics/`.  
**Canonical schema (relevant):** `session_summaries` (Postgres rollup), `outcomes`, `outcome_department_rollups`, `usage_events`. ClickHouse production tables: `telemetry_events_ch`, `home_kpi_hourly`, `agent_performance` — **not** `user_activity` / `user_events`.

## Summary

| Module | Tables touched | Verdict |
|--------|----------------|---------|
| `cohorts.py` | PG: `session_summaries`; CH attempt: `user_activity` | **ok** (PG fixed in FEAT-52); CH soft-fail hardened 2026-08-06 |
| `funnels.py` | PG: `session_summaries`; CH attempt: `user_events` | **ok** (PG fixed in FEAT-53); CH soft-fail hardened 2026-08-06 |
| `outcomes/tracker.py` | `outcomes`, `usage_events`, `outcome_department_rollups` | **ok** — clean, no legacy/wrong-table refs |
| `__init__.py` / `outcomes/__init__.py` | (re-exports only) | **ok** |

No remaining Postgres wrong-table pattern (`jobs`, `audit_log`, `org_audit_log` as funnel/cohort source). Package is tiny (5 files); audit is exhaustive.

---

## Module detail

### 1. `src/eden/analytics/cohorts.py` — **ok** (PG) / CH soft-fail

| Path | Table | Columns / predicates | Verdict |
|------|-------|----------------------|---------|
| `_cohorts_postgres` | `session_summaries` | `session_start`, `user_id`, `org_id` | **ok** — FEAT-52 |
| `cohort_retention` bulk activity | `session_summaries` | `session_start`, `user_id`, `org_id` | **ok** — FEAT-52 |
| `_cohorts_clickhouse` | `user_activity` | `first_seen_at`, `user_id`, `org_id` | **not canonical CH** — table does not exist in Eden CH schema. Query now wrapped in try/except so failures fall through to Postgres (previously only `get_engine()` was guarded). |

### 2. `src/eden/analytics/funnels.py` — **ok** (PG) / CH soft-fail

| Path | Table | Notes | Verdict |
|------|-------|-------|---------|
| `funnel` Postgres fallback | `session_summaries` | Canonical step predicates (`session_started` / `engaged` / `stumbled` / `completed` / `failed`) | **ok** — FEAT-53 |
| `_funnel_clickhouse` | `user_events` | Free-form `event_name` funnel | **not canonical CH** — same soft-fail hardening as cohorts |

### 3. `src/eden/analytics/outcomes/tracker.py` — **ok** (explicitly clean)

| Helper / surface | Table | Verdict |
|------------------|-------|---------|
| `_fetch_outcomes_by_department` | `outcomes` | **ok** |
| `_fetch_cost_by_department` | `usage_events` | **ok** — cost substrate (Cat 8) |
| `_fetch_rollup_history` | `outcome_department_rollups` | **ok** |
| `_insert_outcome` | `outcomes` | **ok** |
| `_delete_then_insert_rollup` | `outcome_department_rollups` | **ok** |

No references to `jobs`, `audit_log`, `org_audit_log`, `user_activity`, `user_events`, or other legacy analytics tables. Outcomes tracker was already aligned with the Cat 11 schema.

### 4. Package init modules — **ok**

Re-exports only; no SQL.

---

## Changes made this pass (2026-08-06)

1. Hardened `_cohorts_clickhouse` / `_funnel_clickhouse` so a missing CH table cannot raise into the route — fall back to `session_summaries`.
2. Documented that CH preferred paths reference non-shipped tables; live numbers come from Postgres `session_summaries` / outcomes tables.

## Out of scope

- Creating real ClickHouse `user_activity` / `user_events` datasources (would be a separate ingest feature).
- `export_audit_log` / bare `audit_log` in `api/routes/audit.py` (called out in FEAT-54 / session-analytics review; not under `src/eden/analytics/`).
