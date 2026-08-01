# Eden ship status — 2026-07-31 (pre-ship pass shipped)

Single current status for free-beta production quality. Supersedes stale

## Live audit + rate-limit / clarity pass — 2026-08-01

Authenticated prod audit (`edenobservability.com`) after headed Chrome sign-in:

| Probe | Result |
|---|---|
| Sequential journey clarity (`journey-clarity-1785560582386.json`) | **29/29 OK** — soft-lands honest (`/alerts`→Detectors, `/artifacts`→Improve queue, `/labeling`→unavailable, `/billing`→settings) |
| Mobile rapid-nav (`mobile-rapid-*.json`) | **14/14** — 0×429 after cooldown, no overflow, no pageErrors |
| Parallel portal-audit + deep-audit | Inflated fails from **429** when two runners hammered the shared org bucket |

Root cause: free-tier **60 rpm** + portal hub fan-out (8–15 GETs/page) → `ApiError: Too many requests` pageErrors during normal multi-page use.

Fixes this pass:
- **Live API:** `org_resource_limits` free/org_free → **300 rpm**; Northflank env `RATE_LIMIT_DEFAULT_PER_WINDOW=300` + `RATE_LIMIT_PORTAL_PER_WINDOW=300`; API restarted
- **Code (needs commit + NF image):** portal JWT floor via `rate_limit_portal_per_window`; plan_tiers 300; alembic `130_portal_rpm_floor`
- **Portal:** CatalogSync after HydrationBoundary; Home dehydrate budget 800ms; 429 soft UX; teaching empties (Cost drivers, Improve plan, Evals); coarse-pointer `.ds-tab` ≥44px
- **Portal Vercel prod:** `dpl_5UhZg6vprFSJgktEKFkT29GoZjeR` aliased to edenobservability.com (working-tree deploy)
- **Follow-up polish:** Inbox `softAuth` (no false session-expired); Settings honesty (no dead Disable/Export CTAs); Home fleet a11y; Improve/Inbox dual-empty gated; redeploy `dpl_3JSAT4U16t4VztHv548qcoDLEP4x`

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

## Portal clarity / usability / functionality — 2026-08-01 (later)

Portal Vercel prod (`dpl_F7cgsHeEW8dz652ekuopRF9t629h`, working tree — commit pending):
- Soft-lands use live `mode=` (Improve queue/plan, Cost spend/drivers, Evals datasets/playground/compare)
- Unshipped Evaluate leaves (`/labeling`, `/studio`, `/synthetic`) → `/unavailable` (not silent Results dump)
- Cross-links / citations / Home next-action / ⌘K playground use canonical query grammar
- Improve Start/Mark verify labeled local draft; Approve/Reject stay real API
- Settings Disable/Re-verify/Export disabled (“Not available yet”); workspace toasts await API
- Guardrails empty → Review traces; Cost no-agents → API keys
- Prod redirect spot-check: `/artifacts`→`/improve?mode=queue`, `/labeling`→`/unavailable`, `/datasets`→`/evals?mode=datasets`

## Portal deep-link honesty — 2026-08-01 (follow-up)

Follow-up after audit of remaining Observe/Evals/Inbox URL mismatches (redeploy after this section):
- Sessions soft-land + helpers use `session=` (Traces reader); aliases accept `sessionId`/`traceId`/`spanId`/`issueId`
- `traceHref`/`issueHref`/`citationHref` emit live `id`/`span`/`session` grammar
- Promote helpers use `from=`; playground does not steal Datasets handoff
- Inbox Resolve/Reopen labeled draft; Mute disabled; Audit empty Export disabled
- Facet/inspector/debugger/incidents soft-lands no longer emit ignored query keys
- Home / next-action zero-data → API keys (not Connect repo)

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
