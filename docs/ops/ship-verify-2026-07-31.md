# Ship verification — 2026-07-31

## Production health (post-recovery)

| Check | Result |
|---|---|
| `/live` | `alive`, `commit=52726caabda3afa57f8c4e00f5ef1f241ad5bcbb` |
| `/ready` | `ready` (postgres ok; redis reports Upstash max-requests — ignored this pass) |
| `/health` | `healthy`, `quality_worker_running=true`, qdrant connected |
| Portal | `https://edenobservability.com` 200 |
| `/status` | 200 |
| Docs | `https://docs.edenobservability.com` 200 |
| Northflank instances | 1 |
| Health checks | restored (2 probes) |

## What landed and stuck

### Durable ops (still true after revert)
- **Clerk** `organization_settings.force_organization_selection=false` on prod + dev (stops org remint loop)
- **Stale users** deleted (empty-email + clerk_id ghost); remaining 0
- **CH fallback** queue settled (`resolved=82`, `open=0`)
- **`/live.commit`** now reports real SHA via Northflank runtime env (was `unknown`)
- **Portal** Vercel prod redeployed earlier (`dpl_8vKmWrbNR1TgPvLc9RFKFU9Ef9WL`)
- **DR drill** fixed locally to PASS (golden-dataset API) — script changes were in the reverted commit; re-land carefully
- **NEVER** use `northflank patch service combined` with a partial `runtimeEnvironment` (wipes all env — learned live)

### Code deploy incident
1. Ship commit `e645aa35` built successfully on Northflank but pods never bound `:8000` (connection refused / empty reply) → prolonged `no healthy upstream`.
2. Scale/restart loops did not recover the new image.
3. **Reverted** with `52726caa` and redeployed → API recovered.
4. Root cause of boot failure on `e645aa35` **not yet isolated** (Dockerfile `.eden-git-sha` RUN, app.py health changes, or lifespan import). Re-land in thin slices with port-forward smoke before promoting.

## Still blocked
- **GitHub Actions**: billing — payments failed / spending limit (run `30657530124`). Blocks F85 CI-green.
- **F12 Typesense 10M**: `TYPESENSE_ENABLED=false`; leave BLOCKED.
- Large dirty WIP tree remains (stashed partially as `wip-during-api-outage` / `wip-rest`).

## Operator follow-ups
1. Fix GitHub Billing & plans so Actions run again.
2. Cherry-pick ship fixes in thin PRs: (a) Redis honesty + `/live` helper only, (b) onboarding 503 gate, (c) silver ETL, (d) docs/ops, (e) DR drill — each with local/port-forward boot smoke.
3. Keep `scripts/build_nf_env_payload.py` + `update service runtime-environment` as the only env mutation path.
