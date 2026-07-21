# Eden Northflank → Vercel Cutover Checklist

**Goal:** stand the FastAPI backend up on Northflank, point the Vercel portal at it through the Next.js `/api/proxy`, and keep production healthy.

**Estimated time:** 3-5 hours of hands-on work, spread over 2-3 days (so the DNS / smoke test windows have time to bake).

**Reference docs:**
- `docs/deploy/northflank-free-tier.md` — the full Northflank + Vercel setup walkthrough
- `docs/deploy/cutover-checklist.md` — this production cutover checklist
- `docs/docs/operations/oncall.md` — the on-call paging protocol
- `docs/docs/operations/disaster-recovery-drill.md` — the quarterly DR drill
- `docs/docs/operations/clerk-eden-org-sync.md` — the Clerk ↔ Eden org-sync ops guide
- `docs/deploy/INGEST-AUTH-DEPLOY-NOTES.md` — Wave 2/3 ingest auth ship (non-UUID 500 → 401)

**Canonical platforms:** Portal = Vercel (`eden`). API + worker + cron = Northflank (`eden-staging-us-central` / `eden-prod`). Fly.io is **removed** — do not redeploy there.

---

## What's already done

- [x] `northflank.yml` written (api service + worker job + cron job + postgres addon)
- [x] Catch-all proxy at `clients/portal/src/app/api/proxy/[...path]/route.ts`
- [x] Auth route handlers use `forwardToBackend` (session cookie on Vercel domain)
- [x] Production API base is `/api/proxy` with `API_INTERNAL_URL` → Northflank
- [x] Portal typecheck / vitest / production build green

## Pre-deploy

- [ ] Read `docs/deploy/northflank-free-tier.md` §2 and §3 in full
- [ ] Sign in to https://app.northflank.com and confirm project `eden-staging-us-central` (or `eden-prod`)
- [ ] Confirm Qdrant Cloud + Upstash Redis credentials in the `eden-required` secret group
- [ ] Confirm Eden secrets: `JWT_SECRET`, `ENCRYPTION_KEY`, `SESSION_SECRET`
- [ ] Confirm `OPENROUTER_API_KEY`, Tinybird tokens, Sentry, GitHub App secrets

## Deploy to Northflank

```bash
northflank combine --project eden-staging-us-central --path ./northflank.yml
# or: scripts/deploy-northflank.sh
```

Git push to `main` also triggers `eden-api` image rebuild when CI/CD is enabled on the service.

Smoke:

```bash
curl -fsS https://api.edenobservability.com/health | jq
curl -fsS https://api.edenobservability.com/live | jq
```

## Wire Vercel to Northflank

| Var | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `/api/proxy` |
| `API_INTERNAL_URL` | `https://api.edenobservability.com` (or the Northflank public URL) |
| Clerk keys | matching instance |

```bash
cd clients/portal && vercel deploy --prod
# or: scripts/deploy-vercel.sh
```

## Smoke after cutover

| Check | Expect |
|---|---|
| Portal home | 200 |
| Sign-in | Clerk round-trip |
| Traces (signed in) | list loads |
| Bad ingest key | **401** on `POST /orgs/{org}/ingest/openai` (not 500) |
| GitHub OAuth | Settings → Connect GitHub |

## Rollback (Northflank-only)

1. Redeploy the previous known-good Northflank image / git SHA for `eden-api`.
2. Or point `API_INTERNAL_URL` at a prior healthy Northflank service URL and `vercel deploy --prod`.
3. Do **not** resurrect Fly.io.

## Out of scope

- SSE streaming edge cases through the proxy (test live tail after cutover).
- Northflank free-tier size limits — watch OOMs and bump compute if needed.
