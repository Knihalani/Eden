---
id: environment-variables
title: Environment variables
sidebar_label: Environment variables
sidebar_position: 3
---

# Environment variables

The complete alphabetical reference. Every variable Eden reads is
documented here, including the platform services, the SDKs, and the
CLI.

## A–C

| Env var | Default | Used by | Notes |
|---------|---------|---------|-------|
| `ANTHROPIC_API_KEY` | unset | API | Anthropic provider |
| `APP_BASE_URL` | `http://localhost:8000` | API | Public URL (emails, OAuth) |
| `CLICKHOUSE_DATABASE` | `eden` | API | |
| `CLICKHOUSE_PASSWORD` | unset | API | |
| `CLICKHOUSE_URL` | `http://localhost:8123` | API | |
| `CLICKHOUSE_USER` | `default` | API | |
| `CLERK_SECRET_KEY` | unset | API, Portal | |
| `CLERK_WEBHOOK_SIGNING_SECRET` | unset | API | From Clerk → Webhooks |
| `CORS_ORIGINS` | `http://localhost:3000` | API | Comma-separated |
| `CONSOLE_LOG_FORMAT` | `text` | CLI | `text` or `json` |

## D–E

| Env var | Default | Used by | Notes |
|---------|---------|---------|-------|
| `EDEN_API_KEY` | unset | SDKs | Org API key |
| `EDEN_APP_INGEST_PER_TENANT_RPM` | 5000 | API | App events rate limit |
| `EDEN_AUDIT_LOG_RETENTION_DAYS` | 2555 | API | 7 years |
| `EDEN_AUTO_PR_ENABLED` | `false` | API | Cat 23 second-stage opt-in |
| `EDEN_AUTO_REVERT_ENABLED` | `false` | API | Cat 23 second-stage opt-in |
| `EDEN_BASE_URL` | `http://localhost:8000` | SDKs | |
| `EDEN_CODE_CHANGE_ENABLED` | `false` | API | Cat 23 master switch |
| `EDEN_DEBUG` | `false` | Python SDK | Verbose logging |
| `EDEN_ENV` | `default` | SDKs | Realm label |
| `EDEN_LLM_AS_JUDGE_DEFAULT_MODEL` | `gpt-4o-mini` | API | |
| `EDEN_LLM_AS_JUDGE_OPT_IN` | `false` | API | Off by default |
| `EDEN_LLM_AS_JUDGE_PER_ORG_RPM` | 60 | API | |
| `EDEN_ORG_ID` | unset | SDKs | |
| `EDEN_OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4317` | API | |
| `EDEN_OTEL_SAMPLE_RATE` | `1.0` | API | Documented legacy name — **not** bound to `Settings` today; OTel SDK sample rate if set by ops tooling |
| `EDEN_PAYWALL_MODE` | `quota` | API | `quota` or `hard_block` |
| `EDEN_PROBABILISTIC_SAMPLE_RATE` | `1.0` | API | N16 — when `<1.0`, overrides profile fallback keep rate. `1.0` = use `EDEN_SAMPLING_PROFILE` rate |
| `EDEN_SAMPLING_ENABLED` | `true` | API | N16 master switch; `false` keeps 100% |
| `EDEN_SAMPLING_PROFILE` | `balanced` | API | N16 `full` \| `balanced` (~15%) \| `aggressive` (~5%) |
| `EDEN_CONTENT_DEDUPE_ENABLED` | `true` | API | N09 — gates message_store upserts + BlobStore intern |
| `EDEN_PROMPT_TRUNCATION_TOKENS` | 8192 | API | |
| `EDEN_RESPONSE_TRUNCATION_TOKENS` | 8192 | API | |
| `EDEN_SENTRY_DSN` | unset | API | |
| `EDEN_TAIL_SAMPLING_BUFFER` | 15000 | API | Documented; Cat 22 buffer default is code-side (15k), not Settings-bound |
| `EDEN_TELEMETRY_INGEST_PER_TENANT_RPM` | 1500 | API | |
| `ENCRYPTION_KEY` | unset | API | Fernet key |

## J–O

| Env var | Default | Used by | Notes |
|---------|---------|---------|-------|
| `JWT_SECRET` | unset | API | HMAC for service tokens |
| `LOG_FORMAT` | `json` | API | `json` or `text` |
| `LOG_LEVEL` | `INFO` | API | `DEBUG`, `INFO`, `WARNING`, `ERROR` |
| `MINIMAX_API_KEY` | unset | API | MiniMax provider (placeholder) |
| `NEXT_PUBLIC_API_URL` | `/api/proxy` | Portal | Catch-all proxy |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | unset | Portal | |
| `OPENAI_API_KEY` | unset | API | OpenAI provider |
| `OPENROUTER_API_KEY` | unset | API | OpenRouter provider |

## P–R

| Env var | Default | Used by | Notes |
|---------|---------|---------|-------|
| `POSTGRES_DB` | `eden` | API | |
| `POSTGRES_HOST` | `localhost` | API | |
| `POSTGRES_PASSWORD` | unset | API | 32+ chars in prod |
| `POSTGRES_POOL_MAX_SIZE` | 30 | API | asyncpg max |
| `POSTGRES_POOL_MIN_SIZE` | 5 | API | asyncpg min |
| `POSTGRES_PORT` | 5432 | API | |
| `POSTGRES_SSL_MODE` | `require` | API | `disable`, `require`, `verify-full` |
| `POSTGRES_STATEMENT_TIMEOUT_MS` | 30000 | API | |
| `POSTGRES_USER` | `eden` | API | |
| `QDRANT_API_KEY` | unset | API | |
| `QDRANT_COLLECTION` | `eden_vectors` | API | |
| `QDRANT_URL` | `http://localhost:6333` | API | |
| `REDIS_MAX_CONNECTIONS` | 50 | API | |
| `REDIS_URL` | `redis://localhost:6379/0` | API | |

## S–Z

| Env var | Default | Used by | Notes |
|---------|---------|---------|-------|
| `SENTRY_DSN` | unset | API | |
| `STRIPE_SECRET_KEY` | unset | API | Billing |
| `STRIPE_WEBHOOK_SECRET` | unset | API | |

## SDK-specific

### Python (`eden-sdk`)

| Env var | Default | Maps to |
|---------|---------|---------|
| `EDEN_API_KEY` | unset | `EdenConfig.api_key` |
| `EDEN_ORG_ID` | unset | `EdenConfig.org_id` |
| `EDEN_BASE_URL` | `http://localhost:8000` | `EdenConfig.base_url` |
| `EDEN_ENV` | `default` | `EdenConfig.environment` |
| `EDEN_DEBUG` | `false` | `EdenConfig.debug` |

### TypeScript (`@eden-ai/sdk`)

| Env var | Default | Maps to |
|---------|---------|---------|
| `EDEN_API_KEY` | unset | `configure({ apiKey })` |
| `EDEN_ORG_ID` | unset | `configure({ orgId })` |
| `EDEN_BASE_URL` | unset | `configure({ baseUrl })` |
| `EDEN_DEBUG` | `false` | `configure({ debug })` |

## Precedence

1. CLI flags (e.g. `--api-key`) — highest
2. Environment variables
3. Config file (`~/.eden/config.yaml`)
4. SDK default — lowest

The same precedence applies to the server-side env vars, except
those don't have a config file fallback — the API refuses to start
if a required variable is missing.

## Validation

Run `eden doctor` (or `eden config show` for the SDK side) to
verify the configuration end-to-end:

```bash
eden doctor
# ✓ Auth: OK (org_id=org_abc, key_prefix=sk_eden_AbCdEf)
# ✓ API URL: reachable
# ✓ Postgres: connected
# ✓ Redis: connected
# ✓ Qdrant: connected
# ✓ ClickHouse: connected
# All checks passed.
```