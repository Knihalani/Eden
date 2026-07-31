# Eden ship status — 2026-07-31

Single current status for free-beta production quality. Supersedes stale
claims in `docs/prod-ready-checklist.md` (Jul 3). Detail lives in
`docs/ops/known-issues.md` and `docs/ops/ship-baseline-2026-07-31.md`.

## Live surfaces (verified)

| Surface | Status |
|---|---|
| API `api.edenobservability.com` | `/ready` ready, `/live.commit` = real SHA (was `unknown`) |
| Portal `edenobservability.com` | 200; `/status` 200; `/health` → 307 `/status` (intentional) |
| Docs `docs.edenobservability.com` | 200 |
| Northflank `eden-api` | 1 instance; background fleet in-process; quality worker up |
| Redis | At Upstash 500k cap — **ignored this pass**; Postgres leader leases |

## Closed today

- `/live` commit SHA via Northflank runtime env + build-arguments (never partial `patch combined` env)
- Honest Redis health vocabulary (`quota_exhausted` / `not_configured` / `connected`)
- Clerk `force_organization_selection=false` on prod + dev
- Stale `users` rows deleted (empty email + clerk_id ghost)
- D.14 onboarding-v2 gated 503 (already in tree)
- Silver ETL per-event quality gate (fail-closed)
- CH fallback queue empty (`resolved=82`, `open=0`)
- Migration matrix rows for `126` / `127`
- DR drill **PASS** locally (seeded backup + fixed golden-dataset API)
- Portal quality gates (`polish:check`) wired in `portal-ci.yml`
- Portal typecheck + 109 vitest tests green locally

## Still open / deferred

| Item | Why |
|---|---|
| **GitHub Actions** | Billing: "payments have failed or spending limit needs to be increased" — every workflow dies in ~3s with no runner. **Blocks F85 CI-green.** Fix in GitHub Billing & plans. |
| **F12 10M Typesense** | `TYPESENSE_ENABLED=false` in prod; leave BLOCKED — do not invent numbers. |
| **RLS FORCE** | App-level `tenant_id` predicates remain SoT; no launch-day FORCE RLS. |
| **Large dirty tree** | ~1.1k paths of WIP still to land in thematic commits after this ship pass. |

## Deploy rule

Never `northflank patch service combined` with a partial `runtimeEnvironment` —
that route **sets** the whole map and wipes omitted vars. Use
`update service runtime-environment` with a full merged payload
(`scripts/build_nf_env_payload.py`) and `update service build-arguments`
for `EDEN_GIT_SHA`.
