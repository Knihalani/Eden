# Eden on Northflank — Free-Tier Cutover Guide

**Audience:** the engineer migrating the FastAPI backend + workers from Fly.io to the Northflank Developer Sandbox, and wiring the Vercel portal to it.

**Status:** Day 1 deploy. Free-tier allocations are tight; this doc shows what fits and what's left for paid-tier upgrades.

**Related:** `docs/deploy/cutover-checklist.md`, `docs/docs/operations/oncall.md`, `docs/docs/operations/disaster-recovery-drill.md`, `docs/docs/operations/clerk-eden-org-sync.md`.

> Note (2026-06-24): the prior runbooks at `docs/runbooks/` were retired in the 2026-06-23 cleanup. The 4 procedure docs above (postgres-restore + ClickHouse-failover + migration-rollback + secrets-management) are tracked for re-creation under Phase D2 of the 14-phase plan.

---

## 1. What fits in the Developer Sandbox

| Slot | Resource | What it runs | Why |
|---|---|---|---|
| Service 1 | `eden-api` | FastAPI + uvicorn on port 8000 | Public ingress; serves the API + SSE |
| Service 2 | _(unused on day 1 — keeps headroom for a debug sidecar)_ | — | Hold for the GPU service when the SLM judge ships |
| Job 1 | `eden-worker` | Long-running background worker (judges, sim, drift, RCA, GH webhook handler) | Per-second billing, easy to scale up to nf-compute-100-2 |
| Job 2 | `eden-cron` | `*/5 * * * *` tick that fires Eden's internal scheduler | Avoids needing a 3rd service slot for cron |
| Addon 1 | `eden-postgres` | Managed Postgres 16 (1 GB) | The only addon; Northflank auto-links the password into the service env as `eden-postgres.eden.PGPASSWORD` |

**Out of sandbox (use external free tiers):**

| Component | Host | Free tier | Env var to set on Northflank |
|---|---|---|---|
| Qdrant vector DB | Qdrant Cloud (https://cloud.qdrant.io) | 1 GB cluster, free forever | `QDRANT_HOST`, `QDRANT_PORT`, `QDRANT_API_KEY` |
| Redis | Upstash (https://upstash.com) | 10k commands/day, 256 MB | `REDIS_URL` (use the `rediss://` TLS variant) |
| ClickHouse / Tinybird | Tinybird (already in use) | 10 GB storage, 1k req/day | `CLICKHOUSE_*`, `TINYBIRD_*` |
| Object storage (S3) | Cloudflare R2 | 10 GB / 1M writes / 10M reads | `BRONZE_S3_BUCKET` + AWS env block |

This keeps Northflank within the sandbox allotment while keeping the data path production-shaped.

---

## 2. Pre-flight checklist

- [ ] Northflank account created + card on file (required even for the free sandbox).
- [ ] `northflank` CLI installed (`npm i -g @northflank/cli`) and `northflank login` succeeded.
- [ ] Qdrant Cloud free cluster created + API key copied.
- [ ] Upstash Redis database created + `REDIS_URL` (rediss://) copied.
- [ ] GitHub App values copied from the local `.env` (`GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`).
- [ ] Tinybird admin token + branch token copied from https://cloud.tinybird.co.
- [ ] OpenRouter API key copied.
- [ ] Sentry DSN copied (optional but recommended).
- [ ] All 11 secrets created in the Northflank project as a `secretGroup` named `eden-required` (see step 4).

---

## 3. Env-var blueprint (what goes where)

### 3a. Northflank — `eden-api`, `eden-worker`, `eden-cron`

The manifest (`northflank.yml`) lists every non-secret env var. Below is the *checklist* of secrets that must exist in the `eden-required` secret group before applying the manifest.

| Secret | Source | Notes |
|---|---|---|
| `JWT_SECRET` | `python scripts/secrets_generate.py` | 64 hex chars; never commit |
| `ENCRYPTION_KEY` | same script | Fernet key (base64 32-byte) |
| `SESSION_SECRET` | same script | 32+ random chars |
| `OPENROUTER_API_KEY` | https://openrouter.ai/keys | `sk-or-v1-…` |
| `TINYBIRD_ADMIN_TOKEN` | Tinybird workspace → Tokens | `p.eyJ1Ijog…` |
| `TINYBIRD_BRANCH_TOKEN` | Tinybird dev branch | Per-branch token |
| `SENTRY_DSN` | https://sentry.io/settings/eden/dsn/ | Optional; safe to leave empty |
| `GITHUB_APP_ID` | GitHub App settings | Numeric string |
| `GITHUB_APP_CLIENT_ID` | GitHub App settings | `Iv23li…` (OAuth client id — NOT the install URL slug) |
| `GITHUB_APP_CLIENT_SECRET` | GitHub App settings | Generated secret |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App → Private key | Full PEM block, newlines preserved |
| `GITHUB_APP_WEBHOOK_SECRET` | GitHub App → Webhook secret | 32+ hex |
| `GITHUB_APP_SLUG` | GitHub App public page URL | Human slug, e.g. `eden-observability` (`github.com/apps/<slug>`) — never `Iv23…` |
| `GITHUB_APP_CALLBACK_URL` | Portal callback after install | `https://edenobservability.com/onboarding/connect` |

**Placeholders you MUST replace in `northflank.yml` before applying:**

| Var | Find in | Replace with |
|---|---|---|
| `CORS_ORIGINS_RAW` (under `eden-api`) | Vercel dashboard → portal project → "Domains" | `https://<your-portal>.vercel.app` (or custom domain) |
| `QDRANT_HOST` | Qdrant Cloud dashboard | Hostname only: `<cluster-id>.us-east4-0.gcp.cloud.qdrant.io` (drop `https://`) |
| `QDRANT_HTTPS` | (plain env, not secret) | Must be `true` for Qdrant Cloud — missing/false used to cause Errno 99 |
| `QDRANT_PORT` | (plain env) | `6333` (Cloud REST/TLS port) |
| `QDRANT_API_KEY` | Secret group `eden-required` | The cluster API key (key name must be exactly `QDRANT_API_KEY`) |
| `REDIS_URL` | Upstash dashboard | `rediss://default:<token>@<host>.upstash.io:6379` |

For Postgres, the addon name `eden-postgres` is referenced in the env vars of `eden-api`, `eden-worker`, and `eden-cron`. The password is auto-injected by Northflank as `eden-postgres.eden.PGPASSWORD` into the linked service — but Eden's code reads `POSTGRES_PASSWORD`, not `PGPASSWORD`. **Add this override under `eden-api` env (and the others) before applying:**

```yaml
- name: POSTGRES_PASSWORD
  valueFrom:
    addonRef:
      name: eden-postgres
      user: eden
      property: password
```

(I omitted this from the manifest file because Northflank's exact addon-ref property names vary by version; the safe move is to set `POSTGRES_PASSWORD` as a separate secret and update it manually, or set it as a service-link env var via the dashboard after the addon is created.)

### 3b. Vercel — `clients/portal`

Set these in **Vercel Dashboard → eden-portal project → Settings → Environment Variables**. Apply to **Production** (and **Preview** if you want preview envs that hit the staging backend).

| Var | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `https://eden-api--<id>.northflank.app` | The public URL of `eden-api` after first deploy |
| `NEXT_PUBLIC_APP_NAME` | `Eden` | Optional, used by the dark terminal header |
| `NEXT_PUBLIC_SENTRY_DSN` | _(your Sentry browser DSN)_ | Optional; only needed if you wire Sentry into the portal |

**Vercel does not need any of the backend secrets.** The portal talks to the API through `lib/proxy.ts`, which forwards cookies + 401s. No secrets cross the Vercel boundary.

> **Cookie gotcha (the one that bit you in May):** the FastAPI session cookie is set with `Secure`. Once the API is on HTTPS (Northflank issues Let's Encrypt automatically) and the portal is on HTTPS (Vercel default), cookies will flow. If you ever hit a "login succeeds but every request is 401" bug, check that `proxy.ts` is forwarding `Set-Cookie` correctly — it already does, via `response.headers.getSetCookie()`.

---

## 4. Apply the manifest

```bash
# 1. Create the project
northflank create project --name eden-staging

# 2. Create the secret group (or use the dashboard → Secrets tab)
#    For each secret above, run:
northflank create secret --project eden-staging --group eden-required --key JWT_SECRET --value "<64 hex>"
# ... repeat for all 12 secrets

# 3. Apply the manifest
northflank combine --project eden-staging --path ./northflank.yml

# 4. Watch the API service build
northflank logs --project eden-staging --service eden-api --follow
```

When `eden-api` first boots, `bin/serve.sh` will:
1. Validate all required secrets are set (otherwise exit 1 — see `src/eden/config.py:validate_settings_or_exit`)
2. Run `alembic upgrade head` against the new `eden-postgres` addon
3. Start uvicorn on port 8000

The first deploy usually takes 3-5 minutes (image build + migration run + uvicorn start).

---

## 5. Wire Vercel

```bash
cd clients/portal
vercel link --yes                    # link the portal to the Vercel project
vercel env add NEXT_PUBLIC_API_URL production
# paste: https://eden-api--<id>.northflank.app
vercel env add NEXT_PUBLIC_API_URL preview
# same value, or a different one if you want preview envs to hit a separate Northflank project
vercel deploy --prod                  # force a rebuild with the new env
```

After this, the portal's `lib/proxy.ts` and `lib/api.ts` will both pick up the new `NEXT_PUBLIC_API_URL` and proxy traffic to Northflank.

---

## 6. Smoke test the cutover

```bash
# Health
curl -fsS https://eden-api--<id>.northflank.app/health | jq

# CORS preflight from the portal origin
curl -i -X OPTIONS https://eden-api--<id>.northflank.app/v1/auth/login \
  -H "Origin: https://<your-portal>.vercel.app" \
  -H "Access-Control-Request-Method: POST"

# Log in (should set the session cookie)
curl -i -X POST https://eden-api--<id>.northflank.app/v1/auth/login \
  -H "Content-Type: application/json" \
  -H "Origin: https://<your-portal>.vercel.app" \
  -d '{"email":"<your-test-user>","password":"<password>"}'
```

In the browser, open the Vercel portal URL and:
1. Sign in.
2. Land on the workspace dashboard — confirms the cookie + CORS round-trip works.
3. Trigger an agent run (any prompt) — confirms the worker is reachable on the same Postgres.
4. Open the SSE "live tail" page — confirms streaming is wired.
5. Open `/agents/<id>` and upload a file — confirms the GitHub onboarding flow is intact.

---

## 7. Cutover + rollback

1. **Point DNS (only if you have a custom domain).** For now, the Vercel portal URL and the Northflank-provided API URL are the canonical hosts. No DNS to flip.
2. **Leave Fly.io running for 3-5 days as a rollback target.** The Fly.io backend is untouched.
3. **Watch Northflank logs + Sentry for 24h.** Look for: 5xx spike, Postgres connection errors, alembic migration errors.
4. **If green, decommission Fly.io:**
   ```bash
   fly apps destroy eden-staging --yes
   fly volumes destroy --app eden-staging --yes   # stops the volume-snapshot billing
   ```
5. **Update `docs/DEPLOYMENT.md` and `docs/deploy/northflank-free-tier.md`** to point at Northflank as the canonical PaaS, with Fly.io as legacy.

---

## 8. Known free-tier gotchas

| Gotcha | Symptom | Fix |
|---|---|---|
| `eden-api` restarts on every deploy, drops the in-memory rate limiter | Brief 429s | Acceptable; the Redis-backed limiter takes over as soon as the worker is up |
| Qdrant Cloud free cluster is 1 GB | Out of disk if `QDRANT_COLLECTION_PREFIX` is wide | The collection prefix is `eden_`; if you outgrow 1 GB, swap to Qdrant Cloud Pay-as-you-go (~$0.014/hr) |
| Upstash free = 10k commands/day | Rate-limit 503s after 10k Redis calls | Either upgrade Upstash to fixed $1/mo for 100k/day, or set a per-day cap in the app and fail open |
| Postgres addon is 1 GB | Migration fails on large inserts (Cat 18 columnar) | Bump to 5 GB plan; the addon is the one free slot so this is the first thing to upgrade |
| 512 MB container cap on the free sandbox | OOM kills during alembic on a heavy migration | Run the migration once via `northflank exec` with a bigger container, then scale back |
| Northflank `*.northflank.app` URLs are not stable across project recreate | Docs/cron references break | Add a custom domain `api.eden.ai` once you're off the free tier |
| Vercel Hobby plan bans commercial use | T&Cs violation once Eden has paying customers | Upgrade Vercel → Pro ($20/seat) before charging |
| No automatic Postgres backups on free tier | Data loss if the addon dies | Manually snapshot weekly: `northflank exec --service eden-api -- pg_dump -U eden eden > backup.sql` |

---

## 9. When to upgrade (out of free tier)

The first three things that will break the free tier as Eden grows, in order:

1. **Postgres storage** — at ~3 GB of telemetry data, bump the addon to 5 GB ($7/mo).
2. **Upstash Redis** — at >10k cmds/day, upgrade to Upstash fixed ($1/mo for 100k) OR move Redis onto Northflank as an addon (replace Postgres temporarily, run Redis on the service slot).
3. **API instance size** — at >50 concurrent users, bump `eden-api` to `nf-compute-100-2` (1 vCPU / 2 GB, $24/mo). At >200 concurrent, the second service slot is now free for a second API replica.
