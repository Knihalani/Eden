# Migration compatibility matrix

> **Single source of truth for the forward-compat + reverse-compat window + downgrade risk + blast radius of every shipable schema change.** Generated 2026-06-24 from `src/eden/db_migrations/versions/` + `migrations/`. The matrix covers the **alembic chain (001 → 062 + 2 merges)**; the legacy SQL files in `migrations/` (001 → 041) are pre-alembic and were collapsed into alembic migration **001_initial_schema.py** at adoption time — they have no separate compat concern.
>
> See `tests/docs/test_migration_matrix.py` for the doc-test that asserts every alembic revision is listed + every cross-reference resolves.

## Schema

| Column | Meaning |
|---|---|
| **#** | Alembic revision id (`001` ... `062`, plus the 2 merge files). |
| **Surface** | The cat / D-section / feature that owns this migration (e.g. `D.10` = cost guardrails, `Cat 22` = APM depth). |
| **Forward-compat** | Can old app code run against the new schema? `yes` = old reads still work; `read-only` = old code reads but can't write; `no` = old code crashes. |
| **Reverse window** | How long can you safely downgrade the app after this migration runs? `forever` = pure additive (column add with default); `bounded` = until first write triggers the new code path; `instant` = must downgrade DB immediately. |
| **Downgrade risk** | Data-loss potential when running `op.downgrade()`: `none` (additive), `soft` (writes to old schema are still possible), `hard` (rows in new shape can't be recovered). |
| **Blast radius** | Which tables are touched. `low` = new table; `medium` = new column on existing table; `high` = ALTER TABLE ... TYPE or DROP; `critical` = destructive on a hot path. |
| **Linked surface** | The cat / D-section / Phase 4 op-debt item that owns this row. |
| **Owner** | The team responsible for this migration (per the docstring's `Author` / `Owner` line, or the Phase that shipped it). |

## Conventions

* **Phase 0** (D.1-D.7) ships the initial platform schema + D.1-D.7 cuts (June 2026).
* **Phase 1** (D.8-D.13 spine) adds the cost / streaming / prompt / webhook surfaces.
* **Phase 2** (D.12.1-6 + D.14) adds the 6 D.12 sub-protocol tables + onboarding state.
* **Cat 23** ships migration `027` (19 tables, all STUB-mode routes 501) — kept under STUB until the 8-week gated Phase H ships.
* **Multi-region** (D.12) was REMOVED from scope 2026-06-24 per user; migration 015 (`regions_and_rls`) stays as historical schema only.
* **RTBF cross-store** (D.11) was REMOVED from scope 2026-06-24 per user; migration 033 (`rtbf_requests.sql`) covers the Postgres-only path and is the canonical RTBF surface.

## Matrix

| # | Surface | Forward-compat | Reverse window | Downgrade risk | Blast radius | Linked surface | Owner |
|---|---|---|---|---|---|---|---|
| 001 | initial schema | no | forever | none | critical | platform | Phase 0 |
| 002 | data layer + RLS | read-only | forever | soft | medium | platform + RLS | Phase 0 |
| 003 | users.password_reset_* | yes | forever | none | low | platform | Phase 0 |
| 004 | exploit library v1 seed | yes | forever | none | low | security | Phase 0 |
| 005 | users.password_changed_at | yes | forever | none | low | platform | Phase 0 |
| 006 | webhooks + idempotency | yes | forever | none | medium | D.13 | Phase 0 |
| 007 | billing_enhancements | read-only | forever | soft | medium | billing (disabled) | Phase 0 |
| 008 | data platform (silver/quality/lineage) | read-only | forever | none | medium | data platform | Phase 0 |
| 009 | telemetry_events | no | forever | none | critical | Cat 1 + ingestion | Phase 0 |
| 010 | judge_scores | no | forever | none | critical | Cat 3 + eval | Phase 0 |
| 011 | capture_full_payloads | yes | forever | none | medium | Cat 1 + replay | Phase 0 |
| 012 | prompt_canary (A/B) | yes | forever | none | low | D.9 | Phase 0 |
| 013 | org_pii_policies | yes | forever | none | low | Cat 10 governance | Phase 0 |
| 014 | org_retention_policies | yes | forever | none | low | Cat 10 governance | Phase 0 |
| 015 | regions_and_rls | read-only | forever | soft | medium | D.12 multi-region (REMOVED) | Phase 0 |
| 016 | trace_patterns (Datadog-style) | yes | forever | none | medium | Cat 1 patterns | Phase 0 |
| 017 | org_gateway_models | yes | forever | none | low | AI gateway | Phase 0 |
| 018 | judge_scores_processed watermark | yes | forever | none | low | Cat 3 insights | Phase 0 |
| 019 | export_destinations | yes | forever | none | low | exports | Phase 0 |
| 020 | intelligence_gap_tables (20+ cats) | yes | forever | none | high | Cat 1-22 | Phase 0 |
| 021 | custom_metric_studio (Cat 21) | yes | forever | none | medium | Cat 21 (STUB gated on SLM) | Phase 0 |
| 022 | columnar_engine (Cat 18) | yes | forever | none | high | Cat 18 + ClickHouse | Phase 0 |
| 023 | dsl_time_travel (Cat 19+20) | yes | forever | none | medium | Cat 19+20 | Phase 0 |
| 024 | user_intel_sessions (Cat 9) | yes | forever | none | medium | Cat 9 | Phase 0 |
| 025 | closed_loop_actions (Cat 17) | yes | forever | none | medium | Cat 17 + HookBus | Phase 0 |
| 026 | apm_depth_rollups (Cat 22) | yes | forever | none | medium | Cat 22 APM | Phase 0 |
| 027 | autonomous_code_modification (Cat 23, 19 tables) | yes | forever | none | high | Cat 23 STUB | Phase 0 |
| 028 | users.deleted_at (soft delete) | yes | forever | none | low | account deletion | Phase 0 |
| 029 | replay_sessions | yes | forever | none | medium | Cat 1 + portal | Phase 0 |
| 030 | brin_timeseries | yes | forever | none | low | perf | Phase 0 |
| 031 | lz4_toast | yes | forever | none | low | perf | Phase 0 |
| 032 | zstd_payload_columns | yes | forever | none | medium | perf | Phase 0 |
| 033 | drop_original_payload_columns | no | instant | hard | high | perf | Phase 0 |
| 034 | timescale_telemetry | no | bounded | soft | high | perf + ingestion | Phase 0 |
| 035 | timescale_judge_scores | no | bounded | soft | high | perf + eval | Phase 0 |
| 036 | app_layer_signals | yes | forever | none | medium | telemetry | Phase 0 |
| 037 | telemetry_events.session_id | yes | forever | none | low | telemetry | Phase 0 |
| 038 | zstd_extended_payloads | yes | forever | none | medium | perf | Phase 0 |
| 039 | zstd_extended_drop | no | instant | hard | high | perf | Phase 0 |
| 040 | trace_archive_index (cold storage) | yes | forever | none | low | archive | Phase 0 |
| 041 | trace_messages (dedup) | yes | forever | none | medium | dedup | Phase 0 |
| 042 | usage_events_partitions (TimescaleDB) | no | bounded | soft | high | Cat 8 cost | Phase 0 |
| 043 | neon_cost_indexes | yes | forever | none | low | perf | Phase 0 |
| 044 | neon_cost_indexes_2 | yes | forever | none | low | perf | Phase 0 |
| 045 | pr_patterns (Cat 23 v2) | yes | forever | none | medium | Cat 23 STUB | Phase 0 |
| 046 | free_only_default_plan | yes | forever | none | low | billing (disabled) | Phase 0 |
| 047 | clerk_user_provisioning | no | bounded | soft | medium | auth (Clerk cutover) | Phase 0 |
| 048 | users.avatar_url | yes | forever | none | low | portal | Phase 0 |
| 049 | merge (047/048 with Cat 23) | yes | forever | none | low | chain fix | Phase 0 |
| 050 | pr_rejection_memory | yes | forever | none | low | Cat 23 not-now memory | Phase 0 |
| 051 | hook_events (§E.5) | yes | forever | none | medium | HookBus + §E.1 | Phase 1 |
| 052 | budgets (D.10, 3 tables) | yes | forever | none | high | D.10 cost guardrails | Phase 1 |
| 053 | webhook_dlq (D.13) | yes | forever | none | medium | D.13 webhook reliability | Phase 1 |
| 054 | streaming_tokens (D.8) | yes | forever | none | medium | D.8 streaming | Phase 1 |
| 055 | prompt_versioning (D.9) | yes | forever | none | medium | D.9 prompt versioning | Phase 1 |
| 056 | onboarding_state (D.14) | yes | forever | none | low | D.14 cold-start UX | Phase 2 |
| 057 | mcp_traces (D.12.1) | yes | forever | none | medium | D.12.1 MCP | Phase 2 |
| 058 | a2a_links (D.12.2) | yes | forever | none | medium | D.12.2 A2A | Phase 2 |
| 059 | computer_use (D.12.3) | yes | forever | none | medium | D.12.3 Computer Use | Phase 2 |
| 060 | voice_sessions (D.12.4) | yes | forever | none | medium | D.12.4 Voice | Phase 2 |
| 061 | fine_tune_lineage (D.12.5, 3 tables) | yes | forever | none | medium | D.12.5 Fine-tune | Phase 2 |
| 062 | provider_routing (D.12.6) | yes | forever | none | medium | D.12.6 Provider routing | Phase 2 |
| 0f45068e1e8e | merge (018 into main chain) | yes | forever | none | low | chain fix | Phase 0 |
| 5c782c65faa3 | merge (Cat 23 pr_patterns + June) | yes | forever | none | low | chain fix | Phase 0 |
| 063 | sidebar_prefs | yes | forever | none | low | portal | Phase 2 |
| 064 | org_clerk_org_id | yes | forever | none | low | auth (Clerk cutover) | Phase 2 |
| 065 | judge_cost | yes | forever | none | low | Cat 3 eval cost | Phase 2 |
| 066 | session21_indexes (P-15, 11 partial + full indexes) | yes | forever | none | medium | perf + dashboard | Phase 2 |
| 067 | trace_quality_otel_columns | yes | forever | none | medium | Cat 22 APM | v2.6 |
| 068 | trace_efficiency_reports | yes | forever | none | low | Cat 8 cost | v2.6 |
| 069 | trace_loop_reports | yes | forever | none | low | Cat 22 loop detector | v2.6 |
| 070 | trace_quality_reports | yes | forever | none | medium | Cat 22 quality | v2.6 |
| 071 | trace_reasoning_reports | yes | forever | none | low | Cat 22 reasoning | v2.6 |
| 072 | trace_guardrail_actions | yes | forever | none | medium | Cat 15 + Cat 22 guardrail | v2.7 |
| 073 | tenant_guardrail_action_config | yes | forever | none | medium | v2.7 kill switch | v2.7 |
| 074_hook_repetition_closed_loop | hook_repetition_closed_loop | yes | forever | none | low | Cat 15 B-15 | v2.7 |
| 075_uniqueness_constraints | uniqueness_constraints | yes | forever | none | medium | B-18 dedup CTEs | v2.7 |
| 076 | account_lockout | yes | forever | none | low | auth | Phase 4 |
| 077 | password_reset_tokens | yes | forever | none | low | auth | Phase 4 |
| 078 | two_factor_recovery_codes | yes | forever | none | low | auth (2FA) | Phase 4 |
| 079 | org_pii_policies.mode | yes | forever | none | medium | D.11 PII tri-state | v3.0 |
| 080 | pr_discipline_layer | yes | forever | none | medium | Cat 23 PR-discipline (v1.7+silencing) | v3.0 |
| 081 | org_cost_overrides | yes | forever | none | medium | §6.1 per-tenant contract rates (D.4+) | v3.0 |
| 082 | org_cost_overrides (cache read/write cols) | yes | forever | none | low | §6.1 cache-discount contract rates | v3.0 |
| 083 | fix_pr_rejection_memory_index | yes | forever | none | low | Drop invalid partial index using NOW() on pr_rejection_memory | v3.0 |

## Critical-path migrations (downgrade risk = `hard`)

These three migrations drop or alter a hot-path column. Downgrading the app after they run requires running `op.downgrade()` immediately AND accepting the read-side impact until the old code is back in service.

* **033 — drop_original_payload_columns**: drops the original JSONB payload columns after zstd compression completes. Old reads against the dropped columns will error. Mitigation: keep the app reading from the new zstd columns before downgrade.
* **034 — timescale_telemetry**: converts `telemetry_events` to a TimescaleDB hypertable. Old writes to the non-hyper table will fail the unique constraint. Mitigation: only downgrade when no writes are in flight (use the read-replica route).
* **035 — timescale_judge_scores**: same shape as 034, on `judge_scores`.
* **039 — zstd_extended_drop**: drops the original 6 JSONB columns after extended zstd burn-in. Same mitigation as 033.
* **042 — usage_events_partitions**: converts `usage_events` to a TimescaleDB hypertable. The Cat 8 cost-intel service reads from this table; downgrading breaks the dashboard.

## Cat 23 (STUB)

Migration **027** ships 19 tables for the Cat 23 STUB surface (per `upgradespec-v2.md` §23 + `docs/docs/observability/23-autonomous-code-modification.md`). The destructive routes (`POST /patches`, `POST /patches/{id}/pr`, `POST /prs/{id}/revert`) are all gated by `code_change_enabled` (default `false`) via `_check_two_stage_optin` in `src/eden/code_change/_common.py:173`. The Cat 23 real-ship work (Phase H of the 14-phase plan) does **not** add new migrations in the v1 surface — only migration **063** is expected for the knowledge-graph signature column.

## Deferred / removed

* **D.11 RTBF cross-store** (was scheduled) — REMOVED 2026-06-24 per user. The Postgres-only `migrations/033_rtbf_requests.sql` is the canonical RTBF surface; no cross-store expansion.
* **D.12 multi-region** (was scheduled) — REMOVED 2026-06-24 per user. Migration `015_regions_and_rls` stays as historical schema but no new region-aware code is added.
* **Cat 23 real end-to-end** — gated on SLM Initiative + 4 hard gates (read-only → attribution → sandbox → end-to-end) over 8 weeks per the design doc.

## SQL / alembic split (legacy)

The pre-alembic SQL migrations in `migrations/` (001-041) are **collapsed into alembic migration `001_initial_schema.py`**. Any new schema change goes into `src/eden/db_migrations/versions/` only — no new files in `migrations/`. The doc-test (`tests/docs/test_migration_matrix.py`) verifies that every alembic revision is listed in this matrix.

## Verification

```bash
pytest tests/docs/test_migration_matrix.py -v  # doc-test: every alembic revision listed
pytest tests/ -q                                  # 0 regressions
alembic upgrade head                              # clean apply on fresh DB
alembic downgrade -1 && alembic upgrade head      # round-trip works
```

The doc-test assertion: for every `revision` id in the alembic chain, a row exists in this matrix whose `#` column matches. The test fails loudly if a migration is added without updating this matrix.