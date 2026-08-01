# Eden ship status — 2026-07-31 (pre-ship pass shipped)

Single current status for free-beta production quality. Supersedes stale

## Prod audit pass — 2026-08-01

Portal Vercel prod redeployed (`dpl_DgkT13nQTuhCa4GDsz2BfAvd8Quv`) with:
- `/compare` null-safe A/B metrics (no crash on partial arms)
- `/alerts` soft-land → `/signals` (Detectors)
- Marketing CTAs client-session detect (no server `auth()` on public pages)
- Lean edge `/api/health` (skip Clerk matcher + fat proxy)
- Daily warm cron for `/api/health` (Hobby plan)

API follow-up (this commit): DatasetHub no longer queries missing `dataset_columns`
(fixes `/portal/evals/datasets` 503). Migration `129_dataset_columns` added for later spreadsheet features.

## Portal clarity / craft / feel — 2026-08-01

Portal Vercel prod (`dpl_8scS3dYGY378DRP3gVPFPFcng7Vi`, commit `e5a590df`):
- Clear: Detectors/Inbox vocabulary; teaching empties; feature-gate errors
- Worked: LocalDraftBanner on draft mutations; Improve Approve/Reject; `/audit`→settings
- Looked/felt: Home Status→Action; ⌘K palette; mobile list→full-bleed; Gateway/Cost diet
- Fast: Home query priority; Traces/Gateway lazy heavy panels
- Live UX smoke: 9/9 (Home CTAs, Inbox, ⌘K, Improve, Detectors, mobile traces)

claims in `docs/prod-ready-checklist.md` (Jul 3). Detail lives in
`docs/ops/known-issues.md` and `docs/ops/remediation-measured-corrections.md`.

## Live surfaces (verified 2026-08-01 ~03:18 UTC)

| Surface | Status |
|---|---|
| API `api.edenobservability.com` | `/live` commit = **`f934dc09`** (prod audit fixes); `/ready` ready |
| Portal `edenobservability.com` | Vercel prod READY (`dpl_DgkT13nQTuhCa4GDsz2BfAvd8Quv`) aliased |
| Background fleet | Leader `acquired(via=postgres)`; quality worker + webhook/eql/maintenance/self-obs loops alive |
| Docs `docs.edenobservability.com` | 200 |
| Redis | Upstash 500k cap → `quota_exhausted`; Postgres leader leases |
| Typesense product path | still `TYPESENSE_ENABLED=false`; F12 remains BLOCKED (needs provisioned cluster + secrets — not a code flip) |
| Eden MCP server (F04) | soft-retired for free beta — docs/nav/keys hidden; `mcp_http_transport_v1=False`; code kept for internal/dev |
| RTBF (`rtbf_fanout_v1`) | stays False — wrong content-table columns; would certify unerased data |

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
3. ~~Tinybird datasource type fixes~~ — **Deployment #3 live** 2026-08-01 (DateTime64(3), UUID, Float64, LowCardinality + FORWARD_QUERY)
4. Provision Typesense (+ `TYPESENSE_HOST`/`API_KEY`) before closing F12 — PG ILIKE fallback is fine for free beta
5. RTBF: remap `gdpr.py` content-table columns before any enable
6. Eden MCP: remains soft-retired until F04 is explicitly productized again
