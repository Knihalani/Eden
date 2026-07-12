# Eden Northflank → Vercel Cutover Checklist

**Goal:** stand the FastAPI backend up on the Northflank Developer Sandbox, point the Vercel portal at it through a local Next.js proxy, and keep Fly.io running as a rollback target for 5 days.

**Estimated time:** 3-5 hours of hands-on work, spread over 2-3 days (so the DNS / smoke test windows have time to bake).

**Reference docs:**
- `docs/deploy/northflank-free-tier.md` — the full Northflank + Vercel setup walkthrough
- `docs/deploy/cutover-checklist.md` — the production cutover checklist
- `docs/docs/operations/oncall.md` — the on-call paging protocol
- `docs/docs/operations/disaster-recovery-drill.md` — the quarterly DR drill (postgres-restore + ClickHouse-failover + migration-rollback procedures live here)
- `docs/docs/operations/clerk-eden-org-sync.md` — the Clerk ↔ Eden org-sync ops guide

---

## What's already done (in this branch)

- [x] `northflank.yml` written (api service + worker job + cron job + postgres addon)
- [x] Catch-all proxy added at `clients/portal/src/app/api/proxy/[...path]/route.ts`
- [x] `forwardToBackend` extended with `extraHeaders`
- [x] Auth route handlers fixed: `/api/auth/{login,signup,logout,me,signup-from-invite,verify-invite-token,2fa/{setup,verify,disable,status}}` all now use `forwardToBackend` (they were silently dropping the session cookie before)
- [x] `use-auth.tsx` redirected to the local route handlers (was calling `api.login()` cross-origin, which blocked Set-Cookie under SameSite=Lax)
- [x] `lib/api.ts` and `lib/proxy.ts` updated so the production API base is `/api/proxy` (with localhost:8000 in dev)
- [x] `docs/deploy/northflank-free-tier.md` written with the full env-var blueprint
- [x] `Portal typecheck passes (bun run typecheck)` ✓

## Pre-deploy (do these before touching either platform)

- [ ] Read `docs/deploy/northflank-free-tier.md` §2 and §3 in full
- [ ] Sign in to https://app.northflank.com and create a project named `eden-staging`
- [ ] Create a Qdrant Cloud free cluster (https://cloud.qdrant.io) and copy `QDRANT_HOST` + `QDRANT_API_KEY`
- [ ] Create an Upstash Redis database (https://console.upstash.com) and copy the `REDIS_URL` (use the `rediss://` TLS variant)
- [ ] Generate Eden secrets: `python scripts/secrets_generate.py` — copy `JWT_SECRET`, `ENCRYPTION_KEY`, `SESSION_SECRET`
- [ ] Copy from your `.env`: `OPENROUTER_API_KEY`, `TINYBIRD_ADMIN_TOKEN`, `TINYBIRD_BRANCH_TOKEN`, `SENTRY_DSN`, the five `GITHUB_APP_*` values

## Deploy to Northflank (60-90 min)

1. **Install the Northflank CLI** (one-time):
   ```bash
   npm i -g @northflank/cli
   northflank login
   ```

2. **Create the secret group** (`eden-required`) — either via dashboard or:
   ```bash
   for key in JWT_SECRET ENCRYPTION_KEY SESSION_SECRET OPENROUTER_API_KEY \
              TINYBIRD_ADMIN_TOKEN TINYBIRD_BRANCH_TOKEN SENTRY_DSN \
              GITHUB_APP_ID GITHUB_APP_CLIENT_ID GITHUB_APP_CLIENT_SECRET \
              GITHUB_APP_PRIVATE_KEY GITHUB_APP_WEBHOOK_SECRET GITHUB_APP_CALLBACK_URL; do
     northflank create secret --project eden-staging --group eden-required \
       --key "$key" --value "$(grep ^${key}= .env | cut -d= -f2-)"
   done
   ```

3. **Edit `northflank.yml` placeholders** (search for `PLACEHOLDER_`):
   - `CORS_ORIGINS_RAW` under `eden-api` → your Vercel portal URL (you can use the auto-assigned `*.vercel.app` URL for staging, update later)
   - `QDRANT_HOST` / `QDRANT_API_KEY` → from Qdrant Cloud
   - `REDIS_URL` → from Upstash (use `rediss://` TLS URL)

4. **Apply the manifest:**
   ```bash
   northflank combine --project eden-staging --path ./northflank.yml
   ```

5. **Watch the build:**
   ```bash
   northflank logs --project eden-staging --service eden-api --follow
   ```
   First boot should take 3-5 min (image build + alembic migration + uvicorn start). Look for "Application startup complete" in the logs.

6. **Copy the public URL** of `eden-api` from the Northflank dashboard (looks like `https://eden-api--abc123.northflank.app`).

7. **Smoke test the API directly:**
   ```bash
   curl -fsS https://eden-api--<id>.northflank.app/health | jq
   # → {"status":"ok",...}
   ```

## Wire Vercel to Northflank (30-45 min)

1. **Set Vercel env vars** (Dashboard → `eden-portal` → Settings → Environment Variables, applied to **Production**):

   | Var | Value |
   |---|---|
   | `NEXT_PUBLIC_API_URL` | `/api/proxy` |
   | `API_INTERNAL_URL` | `https://eden-api--<id>.northflank.app` |
   | `NEXT_PUBLIC_SENTRY_DSN` | _(your Sentry browser DSN, optional)_ |

   Why this split: `NEXT_PUBLIC_API_URL` is the path the *client* uses to reach the API. Pointing it at `/api/proxy` makes every call go through the local Next.js proxy (cookies work). `API_INTERNAL_URL` is the *server-side* Northflank URL the proxy forwards to — it's never sent to the browser.

2. **Trigger a production rebuild:**
   ```bash
   cd clients/portal
   vercel link --yes
   vercel env pull .env.production.local   # sanity check
   vercel deploy --prod
   ```

3. **Open the Vercel URL and sign in** — the auth flow should now work end-to-end because the session cookie is set on the Vercel domain by `/api/auth/login` and the proxy forwards it to Northflank.

## Smoke test the cutover (15 min)

| Check | How |
|---|---|
| Health endpoint | `curl https://eden-api--<id>.northflank.app/health` → 200 |
| CORS preflight | `curl -i -X OPTIONS .../v1/auth/login -H "Origin: https://<portal>.vercel.app" -H "Access-Control-Request-Method: POST"` → `Access-Control-Allow-Origin` echoes the Vercel origin |
| Login | Open portal in browser, sign in with a real user → land on workspace dashboard |
| Logout | Click logout → redirected to /login, refresh shows unauthenticated |
| Worker reach | Trigger an agent run from the UI → it should complete (worker reads from same Postgres) |
| SSE live tail | Open `/observability` (or wherever the live-tail page is) → events stream without 401s |
| 2FA | If you have 2FA enabled: setup flow should work, then prompt on next login |
| Invite signup | Use a fresh email + invite link → account created, session set |
| File upload | `/agents/<id>` → upload a small file → 200 + metadata in response |
| GitHub OAuth | Settings → "Connect GitHub" → OAuth round-trip succeeds |

If any of these fail, see the rollback section.

## 5-day parallel run

Leave both Fly.io and Northflank running in parallel for **at least 5 days**. Watch:

- Northflank: Sentry error rate, alembic migration time on first deploy, Postgres connection count
- Vercel: Vercel function invocation count for `/api/proxy/*` (should be ~100% of your traffic after cutover)
- Fly.io: should be silent (no traffic)

If the Sentry error rate is even 0.1% higher on Northflank than Fly.io, roll back per the runbook.

## Decommission Fly.io (only after the 5-day window is clean)

```bash
fly apps destroy eden-staging --yes
fly volumes destroy --app eden-staging --yes    # stops the volume-snapshot billing (new in Jan 2026)
fly postgres detach --app eden-staging          # if using managed Fly Postgres
```

Then update:
- `docs/DEPLOYMENT.md` — point at Northflank as the canonical PaaS
- `docs/deploy/northflank-free-tier.md` — same
- `CLAUDE.md` / project memory — note the new platform

## Rollback (if anything goes wrong)

The rollback is just "point DNS back at Fly.io" — but since we're not on a custom domain yet, the rollback is even simpler:

1. In Vercel → Environment Variables, change `NEXT_PUBLIC_API_URL` from `/api/proxy` back to the Fly.io URL (e.g. `https://eden-staging.fly.dev`).
2. Remove `API_INTERNAL_URL` (or leave it; it's unused when client code goes direct).
3. Redeploy: `vercel deploy --prod`.
4. All traffic flows back to Fly.io. Northflank stays running but is unused.

Total rollback time: ~2 minutes. The DB is separate (Fly Postgres vs Northflank-managed Postgres), so you don't lose data on either side. If you need to roll back data too, `pg_dump` from Northflank → `pg_restore` to Fly.

## What I didn't change (out of scope for the cutover)

- SSE/streaming endpoints — these use EventSource which behaves differently with the proxy. May need a dedicated streaming proxy. Test in step 4 above; if it breaks, the existing direct cross-origin SSE in the components needs a follow-up patch.
- The 10 page-level files that use `NEXT_PUBLIC_API_URL` directly (`tools/page.tsx`, `observability/*`, etc.) — they keep working because `NEXT_PUBLIC_API_URL` is set to `/api/proxy` in Vercel. No code change needed, but each one does its own cross-origin fetch and the session cookie flows correctly through the proxy.
- The 3 services still on Fly.io: `eden-staging` app, Postgres, persistent volume. Decommission only after the 5-day parallel run.
- The Northflank `nf-compute-20` (0.2 vCPU, 512 MB) is tight for a FastAPI app with 14 tables of observability data. Watch for OOMs in the first 24h; bump to `nf-compute-50` if you see any.
