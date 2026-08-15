# Free Beta Cutover — Phase 5 post-deploy smoke

**Status:** Cutover **RAN** (2026-07-21)  
**Mode:** Free beta (paid off)  
**Redeploy:** Not performed (smoke did not require a fix)

## Live URLs

| Surface | URL |
|---------|-----|
| API | https://api.edenobservability.com |
| Portal | https://edenobservability.com |
| Docs | https://docs.edenobservability.com |
| PyPI | `eden-sdk` |
| npm | `@eden-ai/sdk` |

## Smoke evidence (Phase 5)

### 1. API `/health` — PASS

```json
{"status":"healthy","version":"0.1.0","postgres":"connected","qdrant":"connected","quality_worker_running":false,"statgate_installed":true,"evolution_loop_running":false}
```

HTTP 200. Also `/live` and `/ready` 200 (`ready` checks: postgres/redis/qdrant/typesense/openrouter ok).

**Note:** `quality_worker_running: false` (and `evolution_loop_running: false`) at smoke time — API healthy; worker flags not green.

### 2. Portal public routes — PASS

| Path | Result |
|------|--------|
| `/` | 200 |
| `/pricing` | 200 |
| `/status` | 200 |
| `/sign-in` | 200 (Clerk `signed-out`) |
| `/login` | 307 → `/sign-in` |

### 3. Portal proxy — PASS (public) / expected auth for private

Unauthed:

| Path | HTTP | Notes |
|------|------|-------|
| `/api/proxy/health` | 200 | Same healthy payload as API |
| `/api/health` | 200 | Healthy |
| `/api/proxy/live` | 200 | alive |
| `/api/proxy/ready` | 200 | ready + dependency checks |
| `/api/proxy/openapi.json` | 200 | OpenAPI 3.1 |
| `/api/proxy/v1/orgs` | 401 | `Authentication required` — session/JWT needed for private API |

### 4. Docs — PASS

| Path | HTTP |
|------|------|
| `/` (home) | 200 |
| `/quickstart` | 200 |

### 5. SDKs

| Package | Expected | Observed | Verdict |
|---------|----------|----------|---------|
| PyPI `eden-sdk` | 0.3.2 | **0.3.2** | PASS |
| npm `@eden-ai/sdk` | 0.3.2 blocked | **0.3.1** latest | **PARTIAL** (OTP blocked — do not republish from this smoke) |

### 6. Staging probes (`scripts/w9_staging_probes.sh`) — PASS

```text
EDEN_STAGING_API_URL=https://api.edenobservability.com
EDEN_STAGING_PORTAL_URL=https://edenobservability.com
=== summary: pass=16 fail=0 skip=1 ===
```

Skip: Typesense NF secrets unset in shell env (expected PARTIAL for this operator session). Live `/live`, `/ready`, `/health`, portal root all PASS.

### 7. Optional light ingest — SKIP

No org/project ingest API keys in local `.env` / portal env (only storage/OpenRouter/Typesense-style keys). Did not invent keys or create orgs.

## Known PARTIALs / non-blockers for free-beta ship

1. **npm OTP** — `@eden-ai/sdk` remains **0.3.1**; publish 0.3.2 requires human OTP.
2. **Legal draft** — still draft (not blocking free beta cutover per plan).
3. **Paid off** — free beta mode; billing/paid paths not in scope for this smoke.
4. **`quality_worker_running: false`** — observed on live `/health`; confirm NF worker/cron separately if product expects it true.
5. **Typesense probe secrets** — unset in probe shell; `/ready` still reported typesense ok via API.

## Operator follow-ups

- [ ] Complete npm publish with OTP → `@eden-ai/sdk@0.3.2`
- [ ] Confirm quality worker / evolution loop should be running in free-beta prod
- [ ] Legal finalize when ready
- [ ] Optional: dogfood ingest with a real org API key

---

*Written by Phase 5 post-deploy smoke. File left uncommitted unless an operator commits intentionally.*
