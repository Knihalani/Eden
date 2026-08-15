<!-- Auto-captured from Wave 1 agent `w1-route-cartographer` (read-only discovery). -->

# Wave 1 Route Cartography — Eden Portal

**Scope:** `clients/portal/src/app`  
**Totals:** **97** `page.tsx` · **6** `layout.tsx`  
**Scan basis:** glob all pages/layouts; grep `PageContent` / `PageHeader` / `CoreResourcePage` / `ResourcePageShell` / `DetailPanelShell` in each `page.tsx` (strict). Re-export / sibling-module notes called out separately.

> **Live refresh 2026-07-20:** Counts re-verified (97 / 75 portal / 6 layouts). Shell adoption: PageContent **52**, PageHeader **67**, resource shells **18**. Competing duals (~35 page+redirect pairs) documented in [`w1-redirect-audit.md`](./w1-redirect-audit.md). Clutter scores live in [`w1-hub-surfaces.md`](./w1-hub-surfaces.md) / [`w1-consolidated-inventory.md`](./w1-consolidated-inventory.md).

---

## 1. Exact page / layout counts by route group

| Route group | `page.tsx` | `layout.tsx` | Notes |
|---|---:|---:|---|
| `(portal)` | **75** | **3** | `(portal)/layout.tsx`, `dashboard/layout.tsx`, `traces/layout.tsx` |
| `(marketing)` | **13** | **1** | `(marketing)/layout.tsx` |
| `(auth)` | **5** | **1** | `(auth)/layout.tsx` |
| `clerk-alias` | **2** | **0** | `sign-in/`, `sign-up/` — root layout only |
| `docs-fill` | **1** | **0** | `/docs-fill` |
| `notFound` | **1** | **0** | `[...notFound]` |
| **root** | — | **1** | `app/layout.tsx` |
| **TOTAL** | **97** | **6** | |

---

## 2. Full route matrix

**Legend**
- **PC** = `PageContent` in `page.tsx` **or** via `CoreResourcePage` (which wraps `PageContent`)
- **PH** = `PageHeader` in `page.tsx`
- **Shells** = `CoreResourcePage` / `ResourcePageShell` / `DetailPanelShell` (Y/N)
- Layout chain always includes root `layout.tsx`

### 2a. `(portal)` — 75 pages

| Route | File | Layout chain | PC | PH | CR / RS / DP | Notes |
|---|---|---|:-:|:-:|---|---|
| `/agents` | `(portal)/agents/page.tsx` | root → `(portal)` | Y | Y | Y / — / — | via CoreResourcePage |
| `/agents/[id]` | `(portal)/agents/[id]/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/agents/[id]/artifacts` | `…/artifacts/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/agents/[id]/book` | `…/book/page.tsx` | root → `(portal)` | N* | N* | — / — / — | **re-export** of ledger → effective Y/Y |
| `/agents/[id]/drift` | `…/drift/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/agents/[id]/ledger` | `…/ledger/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/agents/connect` | `…/connect/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/alerts` | `(portal)/alerts/page.tsx` | root → `(portal)` | Y | Y | Y / — / Y | master-detail |
| `/analytics` | `(portal)/analytics/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/artifacts` | `(portal)/artifacts/page.tsx` | root → `(portal)` | Y | Y | Y / — / Y | |
| `/audit-trail` | `(portal)/audit-trail/page.tsx` | root → `(portal)` | Y | Y | Y / — / — | |
| `/dashboard` | `(portal)/dashboard/page.tsx` | root → `(portal)` → `dashboard` | Y | Y | Y / — / — | RQ dehydrate layout |
| `/datasets` | `(portal)/datasets/page.tsx` | root → `(portal)` | Y | Y | Y / — / — | |
| `/datasets/[id]` | `…/[id]/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/debugger` | `(portal)/debugger/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/debugger-sessions` | `…/debugger-sessions/page.tsx` | root → `(portal)` | Y | Y | Y / — / — | |
| `/debugger-sessions/[id]` | `…/[id]/page.tsx` | root → `(portal)` | Y | **N** | — / — / — | PC without PH |
| `/evals` | `(portal)/evals/page.tsx` | root → `(portal)` | Y | Y | Y / — / — | |
| `/experiments` | `(portal)/experiments/page.tsx` | root → `(portal)` | Y | Y | Y / — / Y | |
| `/fleet` | `(portal)/fleet/page.tsx` | root → `(portal)` | Y | Y | Y / — / — | |
| `/guardrails` | `(portal)/guardrails/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/improve` | `(portal)/improve/page.tsx` | root → `(portal)` | Y | Y | Y / — / — | |
| `/improve/change-impact` | `…/change-impact/page.tsx` | root → `(portal)` | Y | Y | Y / — / — | |
| `/improve/online-scoring` | `…/online-scoring/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/improve/plans` | `…/plans/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/improve/plans/[id]` | `…/plans/[id]/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/improve/runs` | `…/runs/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/improve/scorecard` | `…/scorecard/page.tsx` | root → `(portal)` | Y | Y | Y / — / — | |
| `/incidents` | `(portal)/incidents/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/incidents/[cluster_id]` | `…/[cluster_id]/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/insights` | `(portal)/insights/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/insights/topics` | `…/topics/page.tsx` | root → `(portal)` | **N** | **N** | — / — / — | **orphan shell** — custom layout |
| `/inspector` | `(portal)/inspector/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/issues` | `(portal)/issues/page.tsx` | root → `(portal)` | Y | Y | Y / — / Y | |
| `/issues/[id]` | `…/[id]/page.tsx` | root → `(portal)` | Y | **N** | — / — / — | PC without PH |
| `/labeling` | `(portal)/labeling/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/labeling/queues/[id]` | `…/queues/[id]/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/ledger` | `(portal)/ledger/page.tsx` | root → `(portal)` | Y | Y | Y / — / — | |
| `/observability` | `(portal)/observability/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/observability/cohorts` | `…/cohorts/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/observability/decisions` | `…/decisions/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/observability/eval` | `…/eval/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/observability/mcp` | `…/mcp/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/observability/memory` | `…/memory/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/observability/query` | `…/query/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/observability/retrieval` | `…/retrieval/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/observability/time-travel` | `…/time-travel/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/onboarding/improvement-loop` | `…/improvement-loop/page.tsx` | root → `(portal)` | N* | N* | —* | **thin page** → `../improvement-loop.tsx` has CR+PH |
| `/optimization` | `(portal)/optimization/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/optimization/budget` | `…/budget/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/optimization/model-advisor` | `…/model-advisor/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/optimization/outcomes` | `…/outcomes/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/optimization/predict` | `…/predict/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/playgrounds` | `(portal)/playgrounds/page.tsx` | root → `(portal)` | Y | Y | Y / — / — | |
| `/profile` | `(portal)/profile/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/promotions` | `(portal)/promotions/page.tsx` | root → `(portal)` | Y | Y | Y / — / Y | |
| `/prompts` | `(portal)/prompts/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/redteam` | `(portal)/redteam/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/replay` | `(portal)/replay/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/runs/[run_id]/lineage` | `…/lineage/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/sessions/[sessionId]` | `…/[sessionId]/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/settings` | `(portal)/settings/page.tsx` | root → `(portal)` | Y | Y | — / — / — | tabbed hub |
| `/settings/exports` | `settings/(tabs)/exports/page.tsx` | root → `(portal)` | Y | Y | — / — / — | deep-link tab |
| `/settings/gateway` | `…/gateway/page.tsx` | root → `(portal)` | **N** | **N** | — / — / — | **redirect** → `?tab=gateway` |
| `/settings/pii` | `…/pii/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/settings/retention` | `…/retention/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/settings/sidebar` | `…/sidebar/page.tsx` | root → `(portal)` | N* | N* | — | **wrapper** → `SidebarSettingsView` has PC+PH |
| `/settings/status` | `…/status/page.tsx` | root → `(portal)` | **N** | **N** | — / — / — | **orphan** — `StatusTab` only |
| `/settings/webhooks-dlq` | `…/webhooks-dlq/page.tsx` | root → `(portal)` | Y | Y | — / — / — | also in sidebar |
| `/signals` | `(portal)/signals/page.tsx` | root → `(portal)` | Y | Y | — / — / — | nav uses `/alerts?tab=signals` |
| `/studio` | `(portal)/studio/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/synthetic` | `(portal)/synthetic/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/tools` | `(portal)/tools/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |
| `/traces` | `(portal)/traces/page.tsx` | root → `(portal)` → `traces` | Y | Y | — / **Y** / Y | **dual:** PageContent+ResourcePageShell (not CoreResourcePage) |
| `/users` | `(portal)/users/page.tsx` | root → `(portal)` | Y | Y | — / — / — | |

\*N in `page.tsx` file; shell lives in re-export / sibling / child component.

### 2b. Non-portal pages (PC/PH N/A — different chrome)

| Route | File | Group | Layout chain | PC | PH | Shells | Notes |
|---|---|---|---|:-:|:-:|---|---|
| `/` | `(marketing)/page.tsx` | marketing | root → marketing | N | N | — | landing |
| `/about` | `(marketing)/about/page.tsx` | marketing | root → marketing | N | N | — | |
| `/changelog` | `(marketing)/changelog/page.tsx` | marketing | root → marketing | N | N | — | |
| `/contact` | `(marketing)/contact/page.tsx` | marketing | root → marketing | N | N | — | |
| `/do-not-sell` | `(marketing)/do-not-sell/page.tsx` | marketing | root → marketing | N | N | — | |
| `/dpa` | `(marketing)/dpa/page.tsx` | marketing | root → marketing | N | N | — | |
| `/health` | `(marketing)/health/page.tsx` | marketing | root → marketing | N | N | — | |
| `/pricing` | `(marketing)/pricing/page.tsx` | marketing | root → marketing | N | N | — | |
| `/privacy` | `(marketing)/privacy/page.tsx` | marketing | root → marketing | N | N | — | |
| `/security` | `(marketing)/security/page.tsx` | marketing | root → marketing | N | N | — | |
| `/status` | `(marketing)/status/page.tsx` | marketing | root → marketing | N | N | — | public status |
| `/subprocessors` | `(marketing)/subprocessors/page.tsx` | marketing | root → marketing | N | N | — | |
| `/terms` | `(marketing)/terms/page.tsx` | marketing | root → marketing | N | N | — | |
| `/login/[[…]]` | `(auth)/login/…/page.tsx` | auth | root → auth | N | N | — | Clerk |
| `/signup/[[…]]` | `(auth)/signup/…/page.tsx` | auth | root → auth | N | N | — | |
| `/forgot-password` | `(auth)/forgot-password/page.tsx` | auth | root → auth | N | N | — | |
| `/reset-password` | `(auth)/reset-password/page.tsx` | auth | root → auth | N | N | — | |
| `/invite/[token]` | `(auth)/invite/[token]/page.tsx` | auth | root → auth | N | N | — | |
| `/sign-in/[[…]]` | `sign-in/…/page.tsx` | clerk-alias | root | N | N | — | Clerk alias |
| `/sign-up/[[…]]` | `sign-up/…/page.tsx` | clerk-alias | root | N | N | — | |
| `/docs-fill` | `docs-fill/page.tsx` | docs-fill | root | N | N | — | util |
| `/[…notFound]` | `[...notFound]/page.tsx` | notFound | root | N | N | — | catch-all |

---

## 3. % adoption stats

### Portal only (n = 75) — strict (`page.tsx` text)

| Metric | Count | % |
|---|---:|---:|
| **PageContent** (direct **or** via CoreResourcePage) | **69** | **92.0%** |
| **PageHeader** | **67** | **89.3%** |
| Both PC + PH | **67** | **89.3%** |
| PC without PH | **2** | **2.7%** (`/issues/[id]`, `/debugger-sessions/[id]`) |
| **CoreResourcePage** | **17** | **22.7%** |
| **ResourcePageShell** (direct in page) | **1** | **1.3%** (`/traces` only) |
| ResourcePageShell effective (CR wraps RS) | **18** | **24.0%** |
| **DetailPanelShell** | **6** | **8.0%** |

### Portal — effective (resolve re-exports / sibling modules)

| Metric | Count | % |
|---|---:|---:|
| PageContent effective | **72** | **96.0%** | +book, +onboarding module, +sidebar view |
| PageHeader effective | **70** | **93.3%** | same three; still missing issues/[id] + debugger-sessions/[id] |
| True shell orphans | **3** | **4.0%** | `/insights/topics`, `/settings/status`, `/settings/gateway` (redirect) |

### Dual / special patterns
| Pattern | Routes |
|---|---|
| PageContent + ResourcePageShell (not CoreResourcePage) | `/traces` only |
| CoreResourcePage + DetailPanelShell | `/alerts`, `/artifacts`, `/experiments`, `/issues`, `/promotions` |
| ResourcePageShell + DetailPanelShell (no CR) | `/traces` |

### App-wide (n = 97)
Portal shell chrome is intentional for `(portal)` only. Marketing/auth/aliases: **0/22** PageContent (expected).

---

## 4. The 6 layouts — what each provides

| # | File | Provides |
|---|---|---|
| 1 | `/Users/kaiavnihalani/Downloads/Eden/clients/portal/src/app/layout.tsx` | **Root:** ClerkProvider, fonts (Geist), optional next-intl (skipped for known portal paths), CookieConsent, UnregisterServiceWorkers, global CSS, metadata/robots/icons, `min-h-full` html scroll fix |
| 2 | `…/app/(portal)/layout.tsx` | **Portal chrome:** `PortalProviders` + `PortalChrome` (sidebar, top bar, org/auth/query/toast). All 75 portal pages inherit this |
| 3 | `…/app/(portal)/dashboard/layout.tsx` | **Dashboard prefetch:** server `HydrationBoundary` for me + traces + summary (RQ dehydrate) when org session exists |
| 4 | `…/app/(portal)/traces/layout.tsx` | **Traces prefetch:** server `HydrationBoundary` for me + traces hub list |
| 5 | `…/app/(marketing)/layout.tsx` | **Marketing surface:** indexable robots, OG/Twitter metadata, `marketing-surface grain-overlay` wrapper — no portal providers |
| 6 | `…/app/(auth)/layout.tsx` | **Pass-through** fragment; Clerk middleware gates; pages own their chrome |

**Not layouts but relevant shells (components):**
- `PageContent` — padding, max-width (`default|wide|narrow|full`), `page-enter`, embedded mode
- `PageHeader` — title / subtitle / eyebrow / actions / icon
- `CoreResourcePage` = `PageContent` + `ResourcePageShell` slots (header, toolbar, kpi, table, detail, bulkBar)
- `ResourcePageShell` — master-detail column layout
- `DetailPanelShell` — slide-over / detail pane with tabs + prev/next

---

## 5. Sidebar ↔ page gap lists

**Nav source:** `clients/portal/src/lib/sidebar-config.ts` (`DEFAULT_SIDEBAR`).

### Sidebar-present → page exists
All sidebar hrefs resolve to a real route:

| Sidebar href | Page |
|---|---|
| `/dashboard` | ✓ |
| `/traces` | ✓ |
| `/issues` | ✓ |
| `/alerts` | ✓ |
| `/agents` | ✓ |
| `/analytics` | ✓ |
| `/alerts?tab=signals` | ✓ (alerts hub tab; **not** `/signals`) |
| `/debugger-sessions` | ✓ |
| `/evals` | ✓ |
| `/improve` | ✓ |
| `/artifacts` | ✓ |
| `/ledger` | ✓ |
| `/promotions` | ✓ |
| `/optimization` | ✓ |
| `/guardrails` | ✓ |
| `/prompts` | ✓ |
| `/audit-trail` | ✓ |
| `/settings` | ✓ |
| `/settings?tab=api-keys` | ✓ (settings hub) |
| `/settings/webhooks-dlq` | ✓ |
| Docs Quickstart | external (`DOCS_QUICKSTART_URL`) — N/A |

**Sidebar-present / no page:** **none** (for in-app paths).

### Page present / no sidebar nav (portal orphans from DEFAULT_SIDEBAR)

Top-level / notable hubs not in sidebar:

`/profile`, `/fleet`, `/observability` (+ 8 children), `/insights` (+ `/insights/topics`), `/labeling`, `/datasets`, `/playgrounds`, `/studio`, `/experiments`, `/incidents`, `/debugger`, `/tools`, `/users`, `/signals`*, `/redteam`, `/synthetic`, `/replay`, `/inspector`, `/agents/connect`, `/onboarding/improvement-loop`, `/sessions/[sessionId]`, `/runs/[run_id]/lineage`, agent subpages (`/[id]`, drift, ledger, artifacts, book), improve children (plans, runs, scorecard, change-impact, online-scoring), optimization children (budget, outcomes, predict, model-advisor), settings tab deep-links (`/settings/exports|pii|retention|sidebar|status|gateway`), `/issues/[id]`, `/debugger-sessions/[id]`, `/datasets/[id]`, `/labeling/queues/[id]`, `/incidents/[cluster_id]`.

\*Nav labels “Signals” but links to `/alerts?tab=signals` — dedicated `/signals` page is **page-no-nav**.

### Marketing nav gaps (secondary)
**Nav (`NAV_LINKS`):** `/`, `#install`, `/pricing`, `/about`, `/contact`, docs.  
**Footer-linked, not primary nav:** `/security`, `/changelog`, `/privacy`, `/terms`, `/dpa`, `/subprocessors`, `/do-not-sell`.  
**Pages with weak/no marketing nav:** `/health`, `/status` (marketing).

---

## Evidence summary

| Fact | Value |
|---|---|
| Glob `**/page.tsx` under `app` | **97** |
| Glob `**/layout.tsx` under `app` | **6** |
| Portal pages | **75** |
| Strict PageContent adoption | **69/75 = 92.0%** |
| Effective PageContent (re-exports) | **72/75 = 96.0%** |
| CoreResourcePage hubs | **17** |
| DetailPanelShell hubs | **6** |
| Only page with direct ResourcePageShell (not CR) | `/traces` |
| True portal shell orphans | `/insights/topics`, `/settings/status` (+ gateway redirect) |

**What was accomplished:** Exhaustive read-only cartography of every `page.tsx`/`layout.tsx` under `clients/portal/src/app`, with a route→layout→shell matrix, adoption %, layout inventory, and sidebar/page gap lists for Wave 1.