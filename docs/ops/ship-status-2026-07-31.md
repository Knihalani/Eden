# Eden ship status — 2026-07-31 (pre-ship pass shipped)

Single current status for free-beta production quality. Supersedes stale
claims in `docs/prod-ready-checklist.md` (Jul 3). Detail lives in
`docs/ops/known-issues.md` and `docs/ops/remediation-measured-corrections.md`.

## Live surfaces (verified 2026-07-31 ~23:52 UTC)

| Surface | Status |
|---|---|
| API `api.edenobservability.com` | `/live.commit` = **`c591185d6865cc72aa914248c8ad2ba9d2c718ae`**; `/ready` ready; `/health` **healthy** |
| Background fleet | Leader `acquired(via=postgres)`; quality worker + webhook/eql/maintenance/self-obs loops alive |
| Portal `edenobservability.com` | Vercel prod READY (`dpl_92SLEG9KpKeotWtAqEB4979Pq7zc`) |
| Docs `docs.edenobservability.com` | 200 |
| Redis | Upstash 500k cap → `quota_exhausted`; Postgres leader leases |
| Typesense product path | still `TYPESENSE_ENABLED=false`; F12 remains BLOCKED |

## Shipped in commit `c591185d`

### SDKs
- TS offline queue: atomic rewrite + O(1) append cache; durability suite 17/17
- Python fork/offline-drain hardening; 413/worker guards already in tree
- **PyPI `eden-sdk` 0.4.0 published** — https://pypi.org/project/eden-sdk/0.4.0/
- **npm `@eden-ai/sdk` still 0.3.4** — `~/.npmrc` token returns 401; needs a fresh npm publish token then `scripts/publish_sdk.sh publish` (or `cd sdk/ts-ai && npm publish --access public`)

### API / workers / data
- Gateway telemetry off response path (`_emit_gateway_telemetry_bg`); PII `amask` + literal prefilter
- Strong-ref `bounded_create_task` + `drain_background_tasks`
- Clusterer LIMIT 500 + bounded fan-out; archive S3 client reuse; MCP executemany; event-driven quality drain
- CH obsolete-row helper; Tinybird datasources regenerated (`DateTime64(3)`, …) — **Tinybird cloud redeploy of datasources still operator follow-up** if TB CLI/token available

### Portal
- Mobile bottom nav; local-draft honesty banner; reactive catalog agents; unavailable layout

## Proof matrix

| Gate | Result |
|---|---|
| git push `main` | `dd4724c8..c591185d` |
| Northflank build | SUCCESS → deployment COMPLETED |
| `/live` / `/ready` / `/health` | alive / ready / healthy on `c591185d` |
| PyPI 0.4.0 | published |
| npm 0.4.0 | **blocked — expired npm auth** |
| Portal Vercel prod | READY, aliased to edenobservability.com |
| GitHub Actions | still BILLING BLOCKED |
| F12 / FORCE RLS / disabled features | deferred as designed |

## Deploy rule

Never `northflank patch service combined` with a partial `runtimeEnvironment`.
Use `scripts/build_nf_env_payload.py` + `update service runtime-environment` and
`update service build-arguments` for `EDEN_GIT_SHA` (done for this ship).

## Operator follow-ups (remaining)

1. **npm login / new token** → publish `@eden-ai/sdk@0.4.0`
2. Restore GitHub Actions billing (F85 CI-green)
3. `tb deploy` Tinybird datasource type fixes when ready
4. Provision Typesense before closing F12
