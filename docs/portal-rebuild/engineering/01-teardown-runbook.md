# Teardown runbook — Mode A (delete → stub shell)

> **Status:** Executable runbook for Teardown A (D9).  
> **Parent:** [../README.md](../README.md)  
> **Overview:** [00-overview.md](./00-overview.md)  
> **Kill list:** [02-kill-list.md](./02-kill-list.md)  
> **Package:** `clients/portal` only. **Do not** tear down Northflank FastAPI.  
> **Decision date:** 2026-07-21  

This runbook deletes authenticated **product UI** and leaves a stub shell + auth + proxy + rebuild docs. It does **not** delete code by itself — a human/agent executes these steps in a dedicated PR.

---

## 0. Intent (one paragraph)

Signed-in users must stop seeing the current ~75-route, hub-of-hubs portal. After teardown they see a minimal authenticated shell (new IA labels → Coming soon, **or** a single RebuildInProgress page citing `docs/portal-rebuild/README.md`). Marketing, Clerk, `/api/proxy`, i18n infrastructure, and the backend remain.

---

## 1. Preconditions

Execute in order before any delete.

| # | Check | Command / action |
|---|--------|------------------|
| 1.1 | Clean working tree or intentional WIP parked | `git status` on repo root |
| 1.2 | Branch from latest main | `git checkout -b portal/teardown-stub-a` |
| 1.3 | Backup tag (rollback anchor) | `git tag -a portal-pre-teardown-$(date +%Y%m%d) -m "Pre portal teardown A"` |
| 1.4 | Optional remote backup branch | `git push origin HEAD:refs/heads/backup/portal-pre-teardown-$(date +%Y%m%d)` (if policy allows) |
| 1.5 | Confirm specs exist | `docs/portal-rebuild/README.md`, `engineering/00-overview.md`, this file, `02-kill-list.md` |
| 1.6 | CI baseline green on branch tip **before** deletes (or note known failures) | Portal `bun run typecheck`, `bun run test` (or repo CI equivalent) |
| 1.7 | Confirm backend out of scope | No FastAPI / Northflank deploy tickets attached to this PR |
| 1.8 | Read kill list | [02-kill-list.md](./02-kill-list.md) — know what must not come back |

**Stop if:** you are about to delete `src/app/api/proxy`, `src/proxy.ts`, `(marketing)`, or Clerk env — those are not teardown targets.

---

## 2. What to preserve

Do **not** delete these paths (adjust only if stub wiring requires a surgical edit).

### 2.1 Auth & session

| Path | Why |
|------|-----|
| `src/app/sign-in/[[...sign-in]]/` | Clerk sign-in |
| `src/app/sign-up/[[...sign-up]]/` | Clerk sign-up |
| `src/app/(auth)/` | login/signup aliases, invite, forgot/reset password |
| `src/components/auth/` | Auth split layout, Clerk theme, fallbacks |
| `src/proxy.ts` | Clerk middleware + next-intl + public route matchers |
| `src/lib/auth-redirect.ts` | Auth redirect helpers |
| Root `src/app/layout.tsx` ClerkProvider + Geist + next-intl | App shell |

### 2.2 API proxy & health

| Path | Why |
|------|-----|
| `src/app/api/proxy/[...path]/` | Canonical BFF to FastAPI |
| `src/app/api/proxy/**/__tests__/` | Proxy contract tests — keep |
| `src/lib/proxy.ts` | Proxy helpers / circuit breaker |
| `src/app/api/health/` | Public health probe |
| `.env.example` | Env documentation (`NEXT_PUBLIC_API_URL`, `API_INTERNAL_URL`, Clerk) |

**Optional keep (not product UI):** dedicated API routes under `src/app/api/orgs/`, `src/app/api/agents/`, `src/app/api/ai-insights/` if stub or later phases still need them. Prefer keep; do not “clean up” backend-facing routes in the teardown PR unless they block build.

### 2.3 Marketing & docs redirect

| Path | Why |
|------|-----|
| `src/app/(marketing)/` | Public marketing/legal |
| `next.config.ts` `/docs` → `https://docs.edenobservability.com` redirects | Docs site preserved (D8) |
| `src/app/docs-fill/` | Only if still referenced; else leave for follow-up |

### 2.4 i18n infrastructure

| Path | Why |
|------|-----|
| `src/i18n/request.ts`, `routing.ts`, `navigation.ts` | next-intl wiring |
| `src/messages/en.json`, `de.json` | Keep files; **trim** product copy later — do not delete locale pipeline |
| `next-intl` plugin in `next.config.ts` | |

### 2.5 Design tokens / globals / package

| Path | Why |
|------|-----|
| `src/app/globals.css` | Token foundation; redesign via DESIGN-SYSTEM-V2 later |
| `src/components/ui/` primitives (button, input, dialog, …) | Kit for stub + rebuild |
| `package.json` scripts that still make sense | `dev`, `build`, `start`, `lint`, `typecheck`, `test`, `test:watch` |
| `vitest.setup.ts`, Playwright config | Keep runners; shrink suites |
| `README.md` in portal | Update to point at `docs/portal-rebuild/` |

### 2.6 Data-layer libraries (keep code; unused is OK)

| Path | Why |
|------|-----|
| `src/lib/api/**` | `fetchApi` + domain clients |
| `src/hooks/use-api-query.ts` | `useOrgQuery` |
| `src/hooks/use-org.tsx` | Org context |
| `src/lib/query-keys.ts` | |
| `src/app/(portal)/providers.tsx` | Auth/Org/Query providers pattern |

---

## 3. What to delete

Enumerate by category. Prefer `git rm -r` on directories. Globs are relative to `clients/portal/`.

### 3.1 Authenticated product pages (`(portal)` route trees)

Delete **page trees** (keep `(portal)/layout.tsx`, `providers.tsx`, and a new stub page set — §4).

```
src/app/(portal)/agents/
src/app/(portal)/alerts/
src/app/(portal)/analytics/
src/app/(portal)/artifacts/
src/app/(portal)/audit-trail/
src/app/(portal)/dashboard/          # replace with stub dashboard
src/app/(portal)/datasets/
src/app/(portal)/debugger/
src/app/(portal)/debugger-sessions/
src/app/(portal)/evals/
src/app/(portal)/experiments/
src/app/(portal)/fleet/
src/app/(portal)/guardrails/
src/app/(portal)/improve/
src/app/(portal)/incidents/
src/app/(portal)/insights/
src/app/(portal)/inspector/
src/app/(portal)/issues/
src/app/(portal)/labeling/
src/app/(portal)/ledger/
src/app/(portal)/observability/
src/app/(portal)/onboarding/
src/app/(portal)/optimization/
src/app/(portal)/playgrounds/
src/app/(portal)/profile/
src/app/(portal)/promotions/
src/app/(portal)/prompts/
src/app/(portal)/redteam/            # killed in v1 — do not stub as live product
src/app/(portal)/replay/
src/app/(portal)/runs/
src/app/(portal)/sessions/
src/app/(portal)/settings/           # replace with Coming soon stub OR minimal settings later
src/app/(portal)/signals/
src/app/(portal)/studio/
src/app/(portal)/synthetic/
src/app/(portal)/tools/
src/app/(portal)/traces/
src/app/(portal)/users/
```

Also delete:

```
src/app/(portal)/portal-chrome.tsx   # replace with stub chrome
src/app/(portal)/error.tsx           # may replace with minimal error
src/app/(portal)/not-found.tsx       # may replace with minimal not-found
src/app/(portal)/_lib/               # if only used by deleted surfaces
src/app/(portal)/__tests__/          # wave UI freezes — see §6
```

**Inventory note (pre-teardown):** ~75 `page.tsx` files under `(portal)/`. After teardown, expect on the order of **≤5** product pages (dashboard stub + optional per-IA Coming soon catch-alls).

### 3.2 Product components (except ui/auth)

Delete or gut:

```
src/components/portal-chrome/        # SidebarNav, PortalHeader, AiRailHost, …
src/components/portal-os/            # AppShell hubs, dual CommandPalette, ResourcePageShell, …
src/components/layout/embedded-surface.tsx
src/components/layout/page-content.tsx   # if only EmbeddedSurface wrapper
src/components/layout/page-header.tsx    # if hub-of-hubs chrome
src/components/trace-viewer/
src/components/traces/
src/components/transcript-v2/
src/components/ai-insights/
src/components/ai/
src/components/artifacts/
src/components/improve/
src/components/observability/
src/components/sessions/
src/components/prompts/
src/components/billing/              # until Settings rebuild — or leave if stub needs nothing
src/components/onboarding*
src/components/budget-ticker.tsx
src/components/streaming-sparkline.tsx
src/components/integration-*-banner.tsx
```

**Keep:** `src/components/ui/**` (except delete **duplicate** `src/components/ui/command-palette.tsx` if stub uses none — see kill list: only one palette ever returns), `src/components/auth/**`, `src/components/brand/**`, `src/components/cookie-consent.tsx`, `src/components/i18n/**`, `src/components/icons/**` (trim later).

### 3.3 Lib / hooks tied only to old IA

Safe to delete after pages gone (or leave dead and delete in follow-up — prefer delete to avoid resurrection):

```
src/lib/sidebar-config.ts            # REPLACE with stub IA config (do not leave old groups)
src/lib/nav-commands.ts              # ⌘K command lists for old surfaces
src/lib/portal-cross-links.ts
src/lib/portal-hub-redirect.ts       # replace with stub redirect helper if needed
src/lib/page-descriptions.ts
src/lib/product-tour.ts
src/lib/workspace-mode.ts
src/lib/workspace-copy.ts
src/hooks/use-portal-chrome-effects.ts
src/hooks/use-live-trace-stream.ts   # until Observe rebuild
```

Keep `src/lib/portal-routes.ts` but **rewrite** lists to match stub + kill list (expand `REMOVED_PORTAL_PATH_PREFIXES`).

### 3.4 Tests that assert old UI

Glob patterns to remove or move to `clients/portal/_archive/tests-pre-teardown/` (archive preferred if disk policy allows; else delete):

```
src/app/(portal)/**/__tests__/**
src/app/(portal)/__tests__/**
src/components/portal-os/**/__tests__/**
src/components/transcript-v2/**/__tests__/**
src/lib/__tests__/w*-portal*.test.ts
src/lib/__tests__/w*-*.test.ts          # wave freeze tests asserting old DOM/IA
e2e/golden/**                            # quarantine: move to e2e/_archive/golden or skip in CI
```

**Keep tests:**

```
src/app/api/proxy/**/__tests__/**
src/lib/__tests__/proxy-circuit-breaker.test.ts
src/lib/__tests__/api.retry.test.ts
src/lib/__tests__/improve-feature.test.ts   # only if improve-feature helper kept
Any pure fetchApi / auth-redirect unit tests
```

### 3.5 Historical plan markdown (do not execute; optional move)

Not required for runtime. Optional: leave in place as historical or move under `docs/portal-rebuild/_historical/`:

```
clients/portal/PORTAL_UI_OVERHAUL_PLAN.md
clients/portal/PORTAL_OBSERVE_V3_PLAN.md
clients/portal/IMPROVE_V3_PLAN.md
clients/portal/DESIGN.md
```

Do **not** treat them as live specs after cutover.

---

## 4. What the stub looks like

Pick **one** stub UX for the teardown PR (document choice in PR body). Both are Mode A compliant.

### Option A — Sidebar + Coming soon (preferred for IA rehearsal)

Signed-in user sees:

1. Minimal shell: left sidebar + top bar (org switcher / user menu via Clerk only).
2. Sidebar labels matching **target** rebuild IA (not the old “Show Advanced” soup):

   - Dashboard  
   - Agents  
   - Traces  
   - Sessions  
   - Issues  
   - Alerts  
   - Evals  
   - Improve  
   - Cost  
   - Guardrails  
   - Audit  
   - AI Agent  
   - Settings  

3. Each href routes to `/dashboard` or `/_stub/[surface]` rendering a single **Coming soon** panel: title = surface name, body links to `docs/portal-rebuild/README.md` (and relevant `surfaces/*.md` when present).
4. **No** live TQ fetches for product lists on stub pages.
5. **No** red-team nav item.

### Option B — Single RebuildInProgress page

1. All authenticated product URLs redirect to `/dashboard`.
2. `/dashboard` shows RebuildInProgress: short copy, link to `docs/portal-rebuild/README.md`, Clerk user button, sign out.
3. No fake sidebar IA (faster teardown; weaker IA rehearsal).

### Stub file sketch (Option A)

```
src/app/(portal)/layout.tsx          # providers + StubChrome
src/app/(portal)/providers.tsx       # keep
src/components/shell/stub-chrome.tsx # NEW
src/lib/sidebar-config.ts            # NEW stub IA only
src/app/(portal)/dashboard/page.tsx  # Rebuild banner + status
src/app/(portal)/_stub/[surface]/page.tsx  # Coming soon
```

Set `NEXT_PUBLIC_PORTAL_REBUILD_STUB=1` in `.env.example` with a one-line comment.

---

## 5. Redirect strategy

Goal: every old deep link lands on stub (or `/dashboard`), never 404s into a half-deleted tree, never resurrects banned product UI.

### 5.1 `next.config.ts` redirects

1. **Keep** existing ghost redirects that already point at consolidated hubs (`/marketplace` → `/dashboard`, `/observability` → `/traces`, etc.) — then **retarget destinations** to `/dashboard` (or stub) because hubs are gone.

2. **Add** a comprehensive soft-land table for every former top-level prefix under `(portal)/`:

| Source pattern | Destination (stub phase) |
|----------------|--------------------------|
| `/agents`, `/agents/:path*` | `/dashboard` |
| `/traces`, `/traces/:path*` | `/dashboard` |
| `/sessions`, `/sessions/:path*` | `/dashboard` |
| `/issues`, `/issues/:path*` | `/dashboard` |
| `/alerts`, `/alerts/:path*` | `/dashboard` |
| `/evals`, `/evals/:path*` | `/dashboard` |
| `/improve`, `/improve/:path*` | `/dashboard` |
| `/artifacts`, `/ledger`, `/promotions`, … | `/dashboard` |
| `/redteam`, `/redteam/:path*` | `/dashboard` (never rebuild as top-level) |
| `/observability/:path*`, `/inspector`, `/replay`, `/debugger` | `/dashboard` |
| `/analytics`, `/users`, `/tools`, `/insights/:path*` | `/dashboard` |
| `/settings`, `/settings/:path*` | `/dashboard` (until P7) |
| Already-removed: `/marketplace`, `/builder`, `/jobs`, … | keep → `/dashboard` |

3. **Keep** auth redirects: `/login` → `/sign-in`, `/signup` → `/sign-up`.
4. **Keep** docs redirects to docs.edenobservability.com.
5. **Keep** marketing paths unredirected.

### 5.2 Middleware (`src/proxy.ts`)

- Preserve public route matchers for marketing + auth + `/api/health` + `/api/proxy`.
- Remove or no-op `buildHubRedirectUrl` / hub middleware that assumes old leaf pages exist.
- Ensure unknown authenticated paths still reach Next redirects or stub not-found that points to `/dashboard`.

### 5.3 In-app

- Rewrite `KNOWN_PORTAL_PREFIXES` / `REMOVED_PORTAL_PATH_PREFIXES` in `src/lib/portal-routes.ts` for stub reality.
- Stub sidebar must not link to deleted trees without a matching page or redirect.

---

## 6. Test strategy during stub

| Action | Detail |
|--------|--------|
| Delete/archive | All tests asserting old hubs, EmbeddedSurface, wave freezes, transcript DOM, dual palette |
| Add | `rebuild-stub.smoke.test.ts`: layout exports stub; sidebar ids ⊆ allowed stub set; no `/redteam` page file |
| Add | Optional Playwright: sign-in → `/dashboard` contains “rebuild” or “Coming soon” + docs link |
| CI | Portal package must `typecheck` + `test` green on remaining suite |
| E2E golden | Mark skipped in CI config or move to `_archive` — do not leave red |

Scripts that can stay unused: `test:e2e-improve-v3`, `test:visual-smoke` — skip in CI until P3+.

---

## 7. Deploy notes

| Topic | Note |
|-------|------|
| Host | Same Vercel (or current) project for `clients/portal` — **no** new project |
| Env | No rename of Clerk or `API_INTERNAL_URL`. Add `NEXT_PUBLIC_PORTAL_REBUILD_STUB=1` |
| Backend | **Do not** deploy FastAPI for this change |
| Docs site | Unaffected (separate docs host); portal `/docs` redirect remains |
| Comms | Expect signed-in customers to see stub — coordinate release notes / status page if prod |
| Preview | Use PR preview to verify marketing + sign-in + stub before promoting |
| Bundle | `check:bundle` may need budget relax while stub is tiny — OK |

---

## 8. Rollback

| Severity | Action |
|----------|--------|
| Before merge | Delete branch; tag unused |
| After merge, before prod promote | Revert merge commit |
| After prod | `git revert` of teardown merge **or** redeploy artifact from tag `portal-pre-teardown-*` |
| Data | No DB migration in teardown — rollback is frontend-only |
| Partial | Do not “rollback” by copying random old pages into stub — full revert only |

Verify rollback: old `/traces` page renders again; stub flag off.

---

## 9. Verification checklist

Sign off in the teardown PR:

- [ ] Backup tag exists and is reachable
- [ ] `(marketing)/` still builds and `/` (or marketing home) loads logged-out
- [ ] `/sign-in` and `/sign-up` work; Clerk session establishes
- [ ] Authenticated `/dashboard` shows stub (Option A or B), not old Home widgets
- [ ] Spot-check deep links: `/traces`, `/improve`, `/redteam`, `/observability/query` → stub/`/dashboard`
- [ ] `/api/health` returns OK without auth
- [ ] `/api/proxy/...` still forwards with auth (smoke one GET that does not require UI)
- [ ] `/docs` redirects to docs.edenobservability.com
- [ ] i18n pipeline still compiles (`en`/`de` messages load)
- [ ] `portal-chrome.tsx` / `components/portal-os/` gone or unreachable
- [ ] No `page.tsx` under `(portal)/redteam/`
- [ ] Vitest green; golden e2e skipped or archived
- [ ] FastAPI service untouched (no backend PR linked as required)
- [ ] PR description links `docs/portal-rebuild/README.md` + this runbook
- [ ] Kill-list contract test added or scheduled in same PR

---

## 10. Explicit DO NOT delete

Hard stop list — teardown PR review must reject deletions of:

| Path / concern | Reason |
|----------------|--------|
| `src/app/api/proxy/**` | BFF to FastAPI |
| `src/lib/proxy.ts` + proxy tests | Reliability contract |
| `src/app/api/health/**` | Probes |
| `src/proxy.ts` | Clerk + i18n middleware |
| `src/app/sign-in/**`, `sign-up/**`, `(auth)/**` | Auth |
| `src/components/auth/**` | Auth UI |
| `src/app/(marketing)/**` | Marketing/legal |
| `src/i18n/**`, `src/messages/*.json` | i18n infrastructure (trim OK, delete pipeline not OK) |
| `src/app/layout.tsx` Clerk + Geist + next-intl | Root shell |
| `src/app/globals.css` | Tokens |
| `.env.example` | Env contract documentation |
| `NEXT_PUBLIC_API_URL` / `API_INTERNAL_URL` / Clerk key **names** | Deploy identity |
| Northflank FastAPI repo/service | Out of scope |
| `docs/` product docs site sources (repo `docs/` aside from portal-rebuild edits) | D8 keep docs |
| `docs/portal-rebuild/**` | Specs for rebuild — never delete as part of teardown |

---

## 11. Suggested execution order (operator)

1. Preconditions + tag (§1)  
2. Add stub chrome + dashboard page **first** so the app always has a destination  
3. Expand redirects in `next.config.ts` (§5)  
4. Delete `(portal)` product trees (§3.1)  
5. Delete product components (§3.2)  
6. Replace `sidebar-config` / `portal-routes` (§3.3)  
7. Archive tests (§3.4 / §6)  
8. Run typecheck + unit tests; fix imports only (no feature creep)  
9. Verification checklist (§9)  
10. Merge + deploy notes (§7)  

---

## Change control

Teardown complete when §9 checklist is checked in the merged PR. Amendments to preserve/delete lists require updating this file and a dated note in `04-interview-log.md`.
