---
id: configuration
title: Configuration
sidebar_label: Configuration
sidebar_position: 2
---

# Configuration

The Eden API and portal are configured via environment variables.
Defaults are sensible for local dev; production requires explicit
values for `JWT_SECRET`, `ENCRYPTION_KEY`, and the database
connection.

## Required

| Env var | Purpose |
|---------|---------|
| `POSTGRES_HOST` | Postgres host |
| `POSTGRES_PORT` | Postgres port (default 5432) |
| `POSTGRES_DB` | Database name (default `eden`) |
| `POSTGRES_USER` | Database user |
| `POSTGRES_PASSWORD` | Database password (32+ chars in prod) |
| `JWT_SECRET` | HMAC secret for service-to-service tokens (32+ chars) |
| `ENCRYPTION_KEY` | Fernet key for at-rest encryption |
| `APP_BASE_URL` | Public URL (used in emails, OAuth callbacks) |
| `CORS_ORIGINS` | Comma-separated allowed origins |

## LLM providers

Pick at least one:

| Env var | Provider |
|---------|----------|
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic |
| `OPENROUTER_API_KEY` | OpenRouter (routes to 100+ providers) |
| `MINIMAX_API_KEY` | MiniMax direct (placeholder) |

The platform ships a v1.7 internal model "Minimax" — configure
`MINIMAX_API_KEY` (or your model provider's key) and the gateway
routes through it. MiniMax is currently a placeholder for a future
open-weights model. See the AI gateway documentation for details.

## Optional — features

| Env var | Default | Effect |
|---------|---------|--------|
| `EDEN_TELEMETRY_INGEST_PER_TENANT_RPM` | 1500 | Per-tenant ingest rate limit |
| `EDEN_APP_INGEST_PER_TENANT_RPM` | 5000 | Per-tenant app event rate limit |
| `EDEN_AUDIT_LOG_RETENTION_DAYS` | 2555 | 7 years |
| `EDEN_PROMPT_TRUNCATION_TOKENS` | 8192 | Truncate prompts longer than this |
| `EDEN_RESPONSE_TRUNCATION_TOKENS` | 8192 | Truncate responses longer than this |
| `EDEN_PAYWALL_MODE` | `quota` | `quota` (default) or `hard_block` |

## Code change (Cat 23)

Cat 23's two-stage opt-in:

| Env var | Default | Effect |
|---------|---------|--------|
| `EDEN_CODE_CHANGE_ENABLED` | `false` | Master switch — without this, no patch proposals |
| `EDEN_AUTO_PR_ENABLED` | `false` | Allow the SelfHealer to open PRs without manual approval |
| `EDEN_AUTO_REVERT_ENABLED` | `false` | Allow auto-revert on regression detection |

Two-stage is enforced at `_check_two_stage_optin()` — both
`code_change_enabled` AND `auto_pr_enabled` must be true for any
side-effect to fire.

## Observability

| Env var | Default | Effect |
|---------|---------|--------|
| `EDEN_OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4317` | Where to send OTel traces |
| `EDEN_OTEL_SAMPLE_RATE` | `1.0` | 0.0–1.0 |
| `EDEN_SENTRY_DSN` | unset | Sentry error reporting |

## Sampling

| Env var | Default | Effect |
|---------|---------|--------|
| `EDEN_TAIL_SAMPLING_BUFFER` | `15000` | Slots in the tail sampling buffer |
| `EDEN_PROBABILISTIC_SAMPLE_RATE` | `1.0` | Fallback keep rate after keep rules |

## LLM-as-judge (Cat 3)

| Env var | Default | Effect |
|---------|---------|--------|
| `EDEN_LLM_AS_JUDGE_DEFAULT_MODEL` | `gpt-4o-mini` | Default judge model |
| `EDEN_LLM_AS_JUDGE_PER_ORG_RPM` | 60 | Per-org judge quota |
| `EDEN_LLM_AS_JUDGE_OPT_IN` | `false` | Off by default — turn on per org via Settings → Eval |

## Database

| Env var | Default | Effect |
|---------|---------|--------|
| `POSTGRES_POOL_MIN_SIZE` | 5 | asyncpg pool min |
| `POSTGRES_POOL_MAX_SIZE` | 30 | asyncpg pool max |
| `POSTGRES_STATEMENT_TIMEOUT_MS` | 30000 | Query timeout |
| `POSTGRES_SSL_MODE` | `require` | `disable`, `require`, `verify-full` |

## Redis

| Env var | Default |
|---------|---------|
| `REDIS_URL` | `redis://localhost:6379/0` |
| `REDIS_MAX_CONNECTIONS` | 50 |

## Qdrant

| Env var | Default |
|---------|---------|
| `QDRANT_URL` | `http://localhost:6333` |
| `QDRANT_API_KEY` | unset |
| `QDRANT_COLLECTION` | `eden_vectors` |

## ClickHouse

| Env var | Default |
|---------|---------|
| `CLICKHOUSE_URL` | `http://localhost:8123` |
| `CLICKHOUSE_USER` | `default` |
| `CLICKHOUSE_PASSWORD` | unset |
| `CLICKHOUSE_DATABASE` | `eden` |

## Logging

| Env var | Default |
|---------|---------|
| `LOG_LEVEL` | `INFO` |
| `LOG_FORMAT` | `json` (`text` for dev) |

## Production checklist

The minimum set for a production deploy:

```bash
POSTGRES_HOST=...
POSTGRES_PASSWORD=<32+ chars>
JWT_SECRET=<32+ chars>
ENCRYPTION_KEY=<Fernet key>
APP_BASE_URL=https://your-domain.com
CORS_ORIGINS=https://your-domain.com,https://portal.your-domain.com
LOG_LEVEL=INFO
LOG_FORMAT=json
POSTGRES_SSL_MODE=verify-full
```

See [How-to → Deploy](/how-to/deploy) for the full deploy walk-through.