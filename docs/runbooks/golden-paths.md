# Golden paths (F85)

Eight user journeys that must stay green on `main`. Automated in
`clients/portal/e2e/golden/golden-paths.spec.mjs` with **real Clerk
authentication** via headless `@clerk/testing/playwright`.

## Paths

| # | Journey | Route | Deep assertion |
|---|---------|-------|----------------|
| 1 | Sign-in → Home | `/dashboard` | Authenticated shell visible, `h1` "Telemetry Overview" (or NoOrgState) rendered |
| 2 | Traces → transcript → span → dataset | `/traces?traceId=tr-redacted-001` | Fixture trace ID navigates without crash; body contains trace-related text |
| 3 | Issue → shadow Artifact | `/issues` → `/artifacts` | Issues list renders; if data present, clicks first issue and checks for `/artifacts` cross-link |
| 4 | Artifact → promote / gate fail | `/artifacts` → `/promotions` | Artifacts page renders; if data present, checks EvidenceGate / Promote button |
| 5 | Playground from-span → run → save | `/playgrounds` | Page renders; checks for New/Run affordance (degrades loudly if empty) |
| 6 | Alert NL compile → save → ack | `/alerts` | Alerts page renders; checks for NL compile affordance |
| 7 | Experiment compare | `/experiments` | Experiments page renders; checks for compare panel or content |
| 8 | Debugger session / prefix rerun | `/debugger-sessions` | Debugger sessions page renders; checks for session/replay affordance |

## Required env vars

| Var | Purpose | CI source |
|-----|---------|-----------|
| `CLERK_SECRET_KEY` | Clerk Backend API — required by `seed-auth.mjs` to issue auth ticket | GitHub Actions secret `CLERK_SECRET_KEY` |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key — required by Next.js app | GitHub Actions secret `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` |

**No silent skip**: if `CLERK_SECRET_KEY` or `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is missing,
`seed-auth.mjs` exits non-zero naming both vars. CI sets `CLERK_TEST_KEY_FALLBACK=1`
to allow committed test-mode keys when secrets are absent.

## Run locally

```bash
cd clients/portal

# 1. Install (once)
bun install

# 2. Build
bun run build

# 3. Start portal (runtime Clerk secret required — not only at build time)
CLERK_SECRET_KEY=... NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=... \
  bun run start -- -p 3000 -H localhost &

# 4. Seed auth (writes e2e/.auth-state.json)
BASE_URL=http://localhost:3000 node e2e/golden/seed-auth.mjs

# 5. Run golden paths
BASE_URL=http://localhost:3000 node e2e/golden/golden-paths.spec.mjs

# 6. (Optional) Run authenticated a11y audit
PORT=3000 node scripts/audit-a11y.cjs
```

Expected output:

```
[golden] storageState loaded — running with Clerk session
✓ Sign-in → Home (/dashboard) — "Telemetry Overview"
✓ Traces hub
✓ Issues list
✓ Artifacts
✓ Playground
✓ Alerts
✓ Experiments compare
✓ Debugger sessions
[golden] 8/8 paths PASSED
```

Screenshots land in `e2e/golden/screenshots/` (one PNG per path, plus
`02-traces-with-fixture-id.png` for the fixture trace ID step).

## CI

The `golden-paths` job in `.github/workflows/portal-ci.yml`:

1. Installs dependencies + Playwright Chromium
2. Starts the portal on `:3000`
3. Runs `seed-auth.mjs` (requires `CLERK_SECRET_KEY` + `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
   secrets; falls back to test-mode keys if missing)
4. Runs `golden-paths.spec.mjs` with `GOLDEN_CI=1` — exits 1 on any failure
5. Uploads screenshots as artifact `golden-screenshots-<run_id>`

`continue-on-error` has been **removed** — the job gates CI.

If the `seed-auth` step fails because secrets are misconfigured and the
test-mode fallback also fails, the job fails with a message naming the
required env vars: `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`.

### Backend API

The portal's backend (`localhost:8000`) is **not** started in CI for this
job. Pages will render their empty/no-data states. The spec asserts
the authenticated Clerk shell (nav links visible, not redirected to
`/sign-in`) and page structure; data-dependent cross-links (issue→artifact,
artifact→promotions) emit labelled `SKIPPED (reason)` logs and do not fail
unless the page itself crashes.

## Accessibility audit (U20)

`bun run audit:a11y` runs Playwright + axe-core against the 5 core routes:
`/dashboard`, `/traces`, `/issues`, `/artifacts`, `/playgrounds`.

When `e2e/.auth-state.json` exists (i.e. `seed-auth.mjs` has run), the
audit navigates with the Clerk session so the **real authenticated shell**
is audited — not the `/sign-in` redirect stub.

- Critical violations block CI (`process.exit(1)`)
- Serious violations are reported but non-blocking
- axe reports saved to `report-a11y-auth-*.json`

**Known resolved violations**: `color-contrast` on `NoOrgState` subtitle
(`text-faint` → `text-muted` fix in `src/components/ui/no-org-state.tsx`).

## Flake budget

Target < 2% over 50 runs. Retry once on navigation timeout only.
Navigation timeout is 60 s per path; `waitForTimeout` guards are kept
to 800–1 200 ms to reduce timer-related flake.

## Debug

- Append `?debug=1` on portal routes in dev to surface query keys.
- Screenshots in `e2e/golden/screenshots/` show the exact rendered state
  at each step (including a `*-fail.png` on error).
- `auth/me` status code is logged by `seed-auth.mjs` — a 503 means the
  backend is not running (expected in local/CI without API server); a
  redirect to `/sign-in` means Clerk auth failed.
