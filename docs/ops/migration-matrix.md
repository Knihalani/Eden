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
| 075 | uniqueness_constraints | yes | forever | none | medium | B-18 dedup CTEs | v2.7 |
| 076 | account_lockout | yes | forever | none | low | auth | Phase 4 |
| 077 | password_reset_tokens | yes | forever | none | low | auth | Phase 4 |
| 078 | two_factor_recovery_codes | yes | forever | none | low | auth (2FA) | Phase 4 |
| 079 | org_pii_policies.mode | yes | forever | none | medium | D.11 PII tri-state | v3.0 |
| 080 | pr_discipline_layer | yes | forever | none | medium | Cat 23 PR-discipline (v1.7+silencing) | v3.0 |
| 081 | org_cost_overrides | yes | forever | none | medium | §6.1 per-tenant contract rates (D.4+) | v3.0 |
| 082 | org_cost_overrides (cache read/write cols) | yes | forever | none | low | §6.1 cache-discount contract rates | v3.0 |
| 083 | fix_pr_rejection_memory_index | yes | forever | none | low | Drop invalid partial index using NOW() on pr_rejection_memory | v3.0 |
| 084 | agent_stumbles + agent_issues | yes | forever | none | low | F28/F29 closed-loop issues layer | Autopilot |
| 085 | issue_state_transitions | yes | forever | none | low | F46 closed-loop audit trail | Autopilot |
| 086 | autonomy_policies + autonomy_audit_log | yes | forever | none | low | N22 autonomy safety envelope | Autopilot |
| 087 | issue_verifications | yes | forever | none | low | F46 verify loop | Autopilot |
| 088 | org_members.last_writer_source | yes | forever | none | medium | Port migrations/039 last_writer_source | Autopilot |
| 089 | trace_sampling_summaries + span_content_blobs | yes | forever | none | low | N16/N09 cost platform | Autopilot |
| 090 | nl_signals | yes | forever | none | low | F35 plain-English signals (created_by matches users.id type) | Autopilot |
| 092 | market_ready_consolidated (WS1–WS4) | yes | forever | none | high | prod readiness (detect, learn, fix, enterprise) | Phase prod |
| 093 | redteam_findings (org-scoped) | yes | forever | none | low | red-team findings persistence | Phase prod |
| 094 | strategy_store_org_id | yes | forever | none | low | Cat 23 strategy store tenant scoping | GA hardening |
| 095 | agent_activity_events | yes | forever | none | low | Cat 23 Gate 4a activity feed table | GA hardening |
| 096 | compliance_jobs + dsar_tickets + do_not_sell_requests | yes | forever | none | medium | GDPR/CCPA compliance persistence | GA hardening |
| 096b | debugger_llm_cache | yes | forever | none | low | F03 prefix cache table (renumbered from a duplicate `096` — see note below) | GA hardening |
| 097a | cat23_rls | yes | forever | none | medium | Cat 23 tenant RLS on migration-027 tables (renumbered from a duplicate `097`) | GA hardening |
| 097b | signal_definitions_f35_bridge | yes | forever | none | low | F35 default-library → `signal_definitions` bridge columns (renumbered from a duplicate `097`) | GA hardening |
| 098a | cat23_deferred_tables | yes | forever | none | medium | Cat 23 Gate 4b deferred tables + RLS (renumbered from a duplicate `098`) | GA hardening |
| 098b | nl_alert_rules_f81 | yes | forever | none | medium | F81 NL alert rules, alert events triage, feedback (renumbered from a duplicate `098`) | GA hardening |
| 099a | improvement_agent_n23 | yes | forever | none | medium | N23 `improvement_runs` + `improvement_plans` (renumbered from a duplicate `099`) | GA hardening |
| 099 | intel_metric_runs_alert_firings | yes | forever | none | low | Cat 18/19/21 runtime tables — `custom_metric_runs.id` widen + `eql_alert_firings` | GA hardening |
| 100_artifacts_ledger | artifacts_ledger | yes | forever | none | medium | F39/F40 `agent_ledgers` + `ledger_entries` + `evolution_ops_spend` | GA Wave (Artifacts/Ledger) |
| 101_eval_loop | eval_loop | yes | forever | none | medium | Eval loop: datasets hub, offline experiments, regression runs, labeling queues | GA Wave (Eval loop) |
| 102_wave6_online_quality | wave6_online_quality | yes | forever | none | medium | Online scoring, dashboards, prompt deploy, automations | GA Wave (Online quality) |
| 103_wave7_debugger_browser | wave7_debugger_browser | yes | forever | none | low | Debug sessions, browser recording | GA Wave (Debugger) |
| 104_wave8_signals | wave8_signals | yes | forever | none | medium | Signal clusters, backfill jobs, topics, N10 jobs | GA Wave (Signals) |
| 105_wave14_self_obs | wave14_self_obs | yes | forever | none | low | F84 `eden_synthetic_runs` for dogfood probes | GA Wave (F82-F85) |
| 106_filterbar_indexes | filterbar_indexes | yes | forever | none | low | F83 composite indexes on `telemetry_events(tenant_id, agent_id/outcome, timestamp)` for FilterBar query paths | GA Wave (F83 optimization) |
| 107_customer_cost_events | customer_cost_events | yes | forever | none | low | SOTA W7/W8 CostEvent ledger + FinOps thresholds | SOTA W7/W8 |
| 108_f84_heartbeats | eden_component_heartbeats | yes | forever | none | low | F84 component heartbeats (SOTA W9) | SOTA W9 |
| 109_w18_playgrounds | playgrounds + prompt templates | yes | forever | none | medium | Wave 18 U03/F49 persisted playgrounds | Portal UX |
| 110_w26_drop_issue_fix_sessions | drop issue_fix_sessions | no | instant | hard | medium | Wave 26 DELETE F22 `issue_fix_sessions` | Portal UX |
| 111_w27_live_labels | live labels + calibrators | yes | forever | none | medium | Wave 27 F21 calibrators + N11 live session metadata | Portal UX |
| 112_w28_f64_f34_mcp | classifier + investigator flag | yes | forever | none | medium | Wave 28 F34 predictions + `investigator_disabled` | Portal UX |
| 113_a7_search_trgm_indexes | search trgm indexes | yes | forever | none | low | A7 pg_trgm indexes for search | Search |
| 114_org_api_keys_soft_revoke | org_api_keys soft revoke | yes | forever | none | medium | `org_api_keys.active` / `revoked_at` | Auth |
| 115_api_keys_prefix | org_api_keys prefix + created_by | yes | forever | none | low | API key prefix display + `created_by` | Auth |
| 116_saved_searches_phase_n | saved_searches schema fix | yes | forever | soft | medium | Fix saved_searches collision (portal ViewsMenu) | Portal UX |
| 117_portal_schema_drift | portal hub schema drift | yes | forever | none | medium | Invites / domains / annotate / prefs drift close | Portal UX |
| 118_improvement_plans_closed_status | improvement_plans 'closed' status | yes | forever | none | low | Phase 2b PR-close sync (plan status CHECK widened) | Improve |
| 119_repo_connections_agent_id | repo_connections.agent_id | yes | forever | none | low | One linked GitHub repo per agent | Improve |
| 120_guardrail_policies_direction | guardrail_policies.direction | yes | forever | none | low | Cat 15 guardrail direction-scoped enforcement | Cat 15 |
| 121_leader_leases | eden_leader_leases | yes | forever | none | low | Postgres leader-election fallback (Redis quota outage 2026-07-29) | Reliability |
| 122_judge_watermark_composite | judge_scores_processed | yes | forever | none | low | Composite (scored_at, judge_run_id) cursor — the UUID-only watermark silently skipped judge scores | Correctness |
| 123_usage_events_rls_restore | usage_events | yes | forever | none | low | Restore tenant RLS dropped by 042 for the Timescale conversion (billing table had no row-level boundary) | Security |
| 124_missing_columns_both_sides_assume | eden_component_heartbeats, users, jobs, lineage_runs, retrieval_logs, org_pii_patterns | yes | forever | none | low | Add four columns the writers and readers both already name: heartbeats.checked_at (writes always failed), users.email_verified (signup 503s), jobs.current_stage + archivist_summary (job progress and inserts both failed), org_id on lineage_runs + retrieval_logs (untenanted tables), and org_pii_patterns so per-tenant PII regex overrides have storage at last | Correctness |
| 125_clickhouse_fallback_drain | clickhouse_fallback | yes | forever | none | low | Add dead_at (a terminal state distinct from resolved_at) and a partial index on failed_at for the oldest-first drain query, so the rows migration 008 has been accumulating ever since can finally be replayed into ClickHouse instead of stored forever and read by nothing | Reliability |
| 126_ai_conversations | ai_conversations, ai_messages | yes | forever | soft | medium | Assistant threads + messages (org-scoped); UUID/TEXT alignment for user_id FKs must match users.id | Assistant |
| 127_sidebar_prefs_user_id_type | sidebar_prefs | yes | forever | soft | low | Align sidebar_prefs.user_id type with users.id (TEXT) to stop UUID cast crash-loops on prefs write | Portal UX |
| 128_onboarding_state_v2_columns | onboarding_state | yes | forever | soft | low | Add D.14 v2 columns + milestones GIN index onto wizard onboarding_state (056 CREATE IF NOT EXISTS no-op) | Onboarding v2 |
| 129_dataset_columns | dataset_columns | yes | forever | none | low | Idempotent CREATE for spreadsheet metadata table previously only in migrations/037 outside Alembic | Portal UX |
| 130_portal_rpm_floor | rate_limit_snapshots | yes | forever | soft | low | Raise free-tier portal RPM floor 60 → 300 so hub React Query fan-out does not 429 | Reliability |
| 131_slack_integration | org_slack_installs, agent_slack_channels | yes | forever | soft | medium | Soft Autonomy Slack bot installs + per-agent channel routing | Integrations |
| 132_plan_parent | improvement_plans | yes | forever | soft | low | Soft Autonomy parent_plan_id for post-merge regression follow-ups | Improve |
| 133_email_verification_tokens | email_verification_tokens | yes | forever | soft | low | Signup email verification (hash-only tokens, mirrors password_reset_tokens) | Auth |
| 134_budget_enforcement_default_true | budgets | yes | forever | soft | low | Free-tier budgets default to enforcement_enabled=TRUE; flips legacy free-tier rows (Wave 4 cost controls) | Cost |
| 135_loop_events_outbox | loop_events_outbox | yes | 7d drained / forever undrained | soft | low | Durable Redis-down fallback for closed-loop events; drained back onto the stream by idle chore (M2, D4) | Improve |
| 136_issue_status_escalated | agent_issues | yes | forever | soft | low | Widen issues status CHECK with 'escalated' so human escalation writes a real status (M4, D17) | Improve |
| 137_guardian_followup_advisory | improvement_plans | yes | forever | soft | low | Widen plan_kind CHECK with 'advisory' + unique draft-follow-up-per-parent partial index race-proofing the guardian (M5, D9) | Improve |


### Migration chain repair (2026-07-17, GA hardening)

Migrations `096`–`099` were each authored **twice** on parallel branches
with duplicate revision ids (`096` × 2, `097` × 2, `098` × 2, `099` × 2),
all sharing the same `down_revision`. This produced two branch heads at
every level and made `alembic history` / `alembic upgrade head` fail
outright with `Requested revision 097 overlaps with other requested
revisions 096`. Fixed by renumbering the second file in each pair to a
`b`/`a`-suffixed id (`096b`, `097a`/`097b`, `098a`/`098b`, `099a`) and
re-threading `down_revision` so the chain is linear:
`095 → 096 → 096b → 097a → 097b → 098a → 098b → 099a → 099 → 100`.
No table/column definitions changed — only revision ids and
`down_revision` pointers. `alembic heads` now reports a single head
(`105_wave14_self_obs`) and `tests/docs/test_migration_matrix.py`
passes. See `git log -- src/eden/db_migrations/versions/09[6-9]*.py`
for the exact diffs.

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

The `migrations/` folder is **frozen/inert**: no runner (alembic or otherwise) executes it — `alembic.ini`'s `script_location = src/eden/db_migrations` and its own revision/down_revision DAG (not filename order) is the only thing ever applied. The numbering gap at `025`-`027` is intentional, not missing history: those three numbers were used exclusively by alembic-only migrations (`025_closed_loop_actions.py`, `026_apm_depth_rollups.py`, `027_autonomous_code_modification.py`) that were never mirrored into this legacy folder. Any remaining duplicate-numbered files under `migrations/` (e.g. two files sharing prefix `002`, `015`, or `022`) reflect historical authoring artifacts, not an active or ordered migration sequence — do not infer execution order from the numeric prefix.

**Documented exceptions — files added to `migrations/` after the freeze (2026-06-24), left in place:**

* `042_pr_discipline_layer.sql` (added 2026-07-06) — no alembic revision actually creates `pr_decision_audit`, `pr_dedupe_index`, `circuit_breaker_state`, or the `repo_connections.graph_*` columns. Alembic revision `080_pr_discipline_layer.py` is a deliberate no-op (`upgrade()` is `pass`) whose docstring explicitly defers to this raw SQL file as the schema definition. Deleting this file with no replacement would remove the only definition of that schema, so it stays as a documented exception rather than being pruned.
* `044_users_text_fk.sql` (added 2026-07-09) — only partially overlaps an alembic revision (the `webhook_dlq` section duplicates `053_webhook_dlq.py`). The rest of the file (`org_github_installations`, `onboarding_pr_runs`, `org_scim_config`, `scim_users`, `role_definitions`, `role_permissions`, `role_assignments`, `ai_insights_chat_sessions`, `ai_insights_chat_messages`, all re-created here with `TEXT` FKs to match migration `040`'s widening of `users.id`) has no alembic equivalent at all — those tables were only ever defined in the legacy raw SQL (`014`, `015`, `020`, `029`) and were never ported to an alembic revision. Kept in place until a real alembic revision supersedes it; do not delete without first authoring that revision.

(`043_users_token_version.sql`, added 2026-07-09, was removed as part of this cleanup: alembic revision `076_account_lockout.py`, dated 2026-07-01 — i.e. already merged before `043` was added — adds both `users.token_version` and `users.last_seen_at` with real `ADD COLUMN IF NOT EXISTS` DDL, so `043` was a pure post-freeze duplicate with an actual alembic source of truth.)

## Verification

```bash
pytest tests/docs/test_migration_matrix.py -v  # doc-test: every alembic revision listed
pytest tests/ -q                                  # 0 regressions
alembic upgrade head                              # clean apply on fresh DB
alembic downgrade -1 && alembic upgrade head      # round-trip works
```

The doc-test assertion: for every `revision` id in the alembic chain, a row exists in this matrix whose `#` column matches. The test fails loudly if a migration is added without updating this matrix.