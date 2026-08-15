---
id: data-model
title: Data model
sidebar_label: Data model
sidebar_position: 2
---

# Data model

The Postgres schema is the source of truth for everything Eden
stores. This page walks the major tables and how they relate.

## Core tables

### `telemetry_events`

Every event from every SDK lands here. One row per event.

| Column | Type | Notes |
|--------|------|-------|
| `event_id` | `text` | `evt_<sha256[:16]>` — content-derived |
| `org_id` | `uuid` | RLS-scoped |
| `trace_id` | `text` | `trc_<sha256[:16]>` |
| `span_id` | `text` | `spn_<sha256[:16]>` |
| `parent_span_id` | `text` | nullable |
| `source_format` | `text` | `openai`, `anthropic`, `langchain`, `custom`, etc. |
| `name` | `text` | e.g. `openai.chat.completions`, `checkout` |
| `model` | `text` | nullable |
| `outcome` | `text` | `success`, `error`, `timeout` |
| `started_at` | `timestamptz` | |
| `ended_at` | `timestamptz` | |
| `duration_ms` | `integer` | |
| `input_tokens` | `integer` | nullable |
| `output_tokens` | `integer` | nullable |
| `cost_usd` | `numeric(12,8)` | nullable |
| `prompt` | `text` | PII-redacted |
| `response` | `text` | PII-redacted |
| `attributes` | `jsonb` | free-form |
| `tags` | `text[]` | |
| `created_at` | `timestamptz` | defaults to `now()` |

Indexes: `(org_id, started_at DESC)`, `(org_id, trace_id)`,
`(org_id, agent_id, started_at DESC)`,
`(org_id, model, started_at DESC)`.

### `judge_scores`

One row per judge scoring, joined to `telemetry_events` on
`trace_id`.

| Column | Type |
|--------|------|
| `score_id` | `text` (`sc_<sha256[:16]>`) |
| `org_id` | `uuid` |
| `judge_id` | `text` |
| `trace_id` | `text` |
| `span_id` | `text` | nullable |
| `score` | `numeric(5,2)` |
| `passed` | `boolean` |
| `rubric` | `jsonb` | per-criterion breakdown |
| `reasoning` | `text` | nullable |
| `created_at` | `timestamptz` |

### `usage_events`

Token and cost rollups — the source for cost intelligence.

| Column | Type |
|--------|------|
| `usage_id` | `text` (`usg_<sha256[:16]>`) |
| `org_id` | `uuid` |
| `agent_id` | `text` | nullable |
| `model` | `text` |
| `event_type` | `text` | `llm_call`, `embedding_call`, etc. |
| `quantity` | `integer` | tokens, seconds, etc. |
| `cost_usd` | `numeric(12,8)` |
| `attributes` | `jsonb` |
| `created_at` | `timestamptz` |

### `agents`

Agent registry — one row per registered agent.

| Column | Type |
|--------|------|
| `agent_id` | `text` |
| `org_id` | `uuid` |
| `name` | `text` |
| `framework` | `text` |
| `version` | `text` |
| `repo_url` | `text` |
| `tags` | `text[]` |
| `metadata` | `jsonb` |
| `registered_at` | `timestamptz` |
| `last_seen_at` | `timestamptz` |
| `archived_at` | `timestamptz` | nullable |

### `notifications`

Alerts, in-app notifications, and the alert queue. Same table,
discriminated by `type`.

| Column | Type |
|--------|------|
| `id` | `uuid` |
| `org_id` | `uuid` |
| `user_id` | `uuid` | nullable |
| `type` | `text` | `alert`, `judge_threshold_breach`, `cost_anomaly`, etc. |
| `title` | `text` |
| `body` | `text` |
| `data` | `jsonb` | event-specific payload |
| `read_at` | `timestamptz` | nullable |
| `created_at` | `timestamptz` |

### `org_audit_log`

Append-only audit log.

| Column | Type |
|--------|------|
| `id` | `uuid` |
| `org_id` | `uuid` |
| `user_id` | `uuid` |
| `user_email` | `text` | denormalised for readability |
| `action` | `text` | `api_key.create`, `member.invite`, etc. |
| `target_type` | `text` | nullable |
| `target_id` | `text` | nullable |
| `metadata` | `jsonb` |
| `ip_address` | `inet` |
| `user_agent` | `text` |
| `created_at` | `timestamptz` |

### `pii_redactions`

Compliance evidence pack for SOC 2 / HIPAA / GDPR.

| Column | Type |
|--------|------|
| `redaction_id` | `uuid` |
| `org_id` | `uuid` |
| `event_id` | `text` |
| `kind` | `text` | `email`, `phone`, `custom:account_id`, etc. |
| `field` | `text` | `prompt`, `response`, etc. |
| `created_at` | `timestamptz` |

## Intelligence tables

Each intelligence service has its own table set. The full list:

| Service | Tables |
|---------|--------|
| Trace replay | `trace_replays`, `trace_replay_steps` |
| RCA & incidents | `incident_clusters`, `incident_alerts`, `incident_summaries` |
| Cost intelligence | `cost_summaries_daily`, `cost_anomalies`, `cost_forecasts` |
| Retrieval intelligence | `retrieval_logs`, `retrieval_gaps`, `chunk_attributions` |
| Memory intelligence | `memory_attributions`, `memory_timeline`, `memory_impacts` |
| Agent intelligence | `agent_performance_daily`, `agent_relationships`, `handoff_log` |
| User intelligence | `user_sessions`, `user_behavioural_signals`, `user_satisfaction_corrected` |
| Governance | `compliance_evidence_packs`, `data_lineage`, `pii_policies` |
| Outcome / ROI | `outcomes`, `outcome_rollups` |
| Experimentation | `experiments`, `experiment_splits`, `experiment_assignments`, `experiment_results` |
| Predictive | `predictions`, `drift_alerts` |
| Autonomous | `investigations`, `recommendations`, `self_heal_proposals` |
| APM depth | `apm_sampling_decisions`, `apm_k8s_enrichment_log`, `trace_step_profile_links` |

The full schema is in `src/eden/db_migrations/versions/`. Each
migration is reversible (Alembic with explicit `downgrade()`).

## Content-derived IDs

Almost every ID in Eden is content-derived:

```
event_id = "evt_" + sha256(org_id + trace_id + span_id + source_format + prompt + response + started_at)[:16]
```

This means re-sending the same payload produces the same event_id,
so retries are idempotent at the storage layer. The downside is
that you can't construct an ID independently — you have to hash the
content. The SDKs and API do this for you.

## Cardinality and growth

A mid-size customer (10M LLM calls/month) produces:

- ~10M rows in `telemetry_events` (300 GB / month at full prompt
  and response sizes; ~30 GB after compression and prompt
  truncation)
- ~3M rows in `judge_scores` (sampled)
- ~10M rows in `usage_events`

The retention policy (configurable per org) drops `prompt` and
`response` after 30 days by default, keeping the metadata. This
keeps the table size manageable without losing the ability to
investigate historical regressions (which only need the
`attributes` and `judge_scores`).

## Migrations

Alembic. Every migration has a corresponding `downgrade()`. New
migrations go through:

```bash
alembic revision --autogenerate -m "add foo table"
alembic upgrade head   # test locally
alembic downgrade -1   # verify the downgrade works
alembic upgrade head   # re-apply
```

Migrations run as a one-shot job in the deploy pipeline.