# Wave 3/4 — Component Contract (Canonical Patterns)

**Status:** Wave 4 refresh — binding for Waves 5–10  
**Agent:** `w4-component-contract`  
**Date:** 2026-07-20  
**Audience:** Wave 5–10 implementers  
**Scope:** Docs only. Interaction/API contracts for shared portal components — not visual skins.

**Inputs:** [`w1-component-inventory.md`](./w1-component-inventory.md) · [`w1-states-loading.md`](./w1-states-loading.md) · [`w1-consolidated-inventory.md`](./w1-consolidated-inventory.md) · [`w2-laminar-contracts.md`](./w2-laminar-contracts.md) · [`w2-competitor-pattern-library.md`](./w2-competitor-pattern-library.md) (P0-6, P0-7) · [`w2-laminar-empty-loading.md`](./w2-laminar-empty-loading.md) · [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md)

**Peers:** Clone Laminar table-OS / empty-loading **grammar**. Keep Eden tokens + existing `ui` / `portal-os` / `layout` modules. **No snowflake toolbars** — hubs compose ResourcePageShell slots only.

---

## 0. Top canonical rules (locked)

| # | Rule |
|---|---|
| R1 | **CTA:** Accent primary actions use `Button` from `@/components/ui/button` only. Ban raw `<button>` with `bg-[var(--accent)]` / accent utility classes. |
| R2 | **Touch floor:** Primary / empty-state / mobile-critical CTAs use `min-h-11` (≥44px). Do not ship `h-7` / undersized accent CTAs on hub actions. Prefer `size="default"` or `size="lg"`; `size="sm"` only for dense inline chrome where WCAG 2.5.8 is already satisfied by a larger hit area. |
| R3 | **Tabs:** Every hub view switch uses `@/components/ui/tabs` (`Tabs` / `TabsList` / `TabsTrigger` / `TabsContent`). Ban page-local `role="tablist"` / `role="tab"`. Default hub variant: `underline`. |
| R4 | **Resource layout:** List/table hubs use `CoreResourcePage` (preferred) or `ResourcePageShell` when padding is already owned. Slot order: `header` → `toolbar` → optional `kpiStrip` → `table` ± `detail` → `bulkBar`. |
| R5 | **Detail:** Master–detail uses `DetailPanelShell` in the shell `detail` slot. Mode switches inside detail use `ui/tabs` (no hand-rolled tab strip in `DetailPanelShell`). |
| R6 | **Async default:** Async list/hub bodies wrap with `QueryState` (`loading → error+retry → empty → children`). |
| R7 | **Suspense:** Ban `fallback={null}` on Settings, hubs, and `useSearchParams` boundaries. Use `LoadingSkeleton` / `PageLoadingSkeleton` / `Loader2` box. Intentional overlay nulls (e.g. OnboardingOverlay, SelectedTraceRail) only. |
| R8 | **Empty taxonomy:** Zero-data (never ingested) ≠ filtered empty ≠ period/scoped empty. Never show install CTA on filtered empty; always offer Clear filters. |
| R9 | **Table load:** Resource tables load with `LoadingSkeleton variant="table"` (or table-shaped `loadingSlot`). Spinner reserved for action-busy / load-more / auth. |
| R10 | **Chrome budget:** ≤1 identity `PageHeader` + ≤1 toolbar band. No third facet/legacy band (P0-1). Toolbar **≤5** primary actions; rest overflow ([`w4-anti-clutter-contract`](./w4-anti-clutter-contract.md)). |
| R11 | **Filters/views:** Resource toolbars compose `QueryFilterBar` + `ViewsMenu` / `ResourceOsToolbar`; facets fold into filter chips / URL, not a sibling band. |
| R12 | **Page chrome:** Prefer `PageHeader` + `PageContent` (or via `CoreResourcePage`). Do not hand-roll `p-4 sm:p-6 lg:p-8 max-w-*` page padding. |
| R13 | **No snowflake toolbars:** Hubs do not invent parallel filter/views chrome outside portal-os slots. Card-in-card chrome banned. |

**Count: 13 top canonical rules.**

---

## 1. Canonical vs drift

| Component | Canonical path / import | Canonical usage | Drift (Wave 1) | Contract |
|---|---|---|---|---|
| **Button** | `ui/button.tsx` → `@/components/ui/button` | `variant` + `size` + optional `loading`; accent via `variant="default"` | ~53 raw accent `<button>` fragments; 8 files / 11 hits with `bg-[var(--accent)]` | **Must** use `Button`. Primary CTAs `min-h-11`. |
| **Tabs** | `ui/tabs.tsx` → `@/components/ui/tabs` | Hub: `TabsList variant="underline"` + matching `TabsTrigger` | **0 hubs** import it; 8+ hubs + Settings rail + `DetailPanelShell` hand-roll `role="tab*"` (~13 files / 29 hits) | **Must** migrate all hubs + detail mode tabs. Settings rail may wrap same primitives. |
| **EmptyState** | `ui/empty-state.tsx` | `variant` panel\|plain\|terminal; `action` = `Button` | 57 prod files; some hubs lack any empty surface; dashboard uses card `empty` props | Required for zero-data / filtered / period empties (distinct copy+CTA). |
| **ErrorState** | `ui/error-state.tsx` | `title`/`message`/`onRetry` via `action` | Widespread (~102 prod files) — keep; do not reuse empty copy | Errors always `ErrorState` + retry; never EmptyState. |
| **QueryState** | `ui/query-state.tsx` | Default async shell; custom `loadingSlot` / `emptySlot` | Only **3** prod pages (agents, audit-trail, webhooks-dlq); ~22 refs total | **Default** for new/touched async hubs. |
| **ResourcePageShell** | `portal-os/ResourcePageShell.tsx` | Slots only; no page padding | Direct use: `/traces` only | Allowed when outer `PageContent` already owns padding. |
| **CoreResourcePage** | `portal-os/CoreResourcePage.tsx` | `PageContent` + `ResourcePageShell` | **17** pages; Analytics hub still B-only | **Preferred** for list/table hubs. Adoption target: all Observe/Evaluate/Improve list hubs + Alerts/Issues/Artifacts/… |
| **DetailPanelShell** | `portal-os/DetailPanelShell.tsx` | `open` + URL id; split ≥1280 / drawer 768–1279 | Present on traces/alerts/issues/artifacts/experiments/promotions; **hand-rolled internal tabs** | Adopt on master–detail resources; **replace internal tab UI with `ui/tabs`**. |
| **QueryFilterBar** | `portal-os/QueryFilterBar.tsx` | `mode` basic\|query; URL via `useResourceUrlState` | Traces uses under overloaded 3-band chrome; facets duplicate | Single toolbar owner for filters; facets → chips / `?facet=`. |
| **InfiniteDataTable** | `portal-os/InfiniteDataTable.tsx` | Cursor/`hasMore`/`onLoadMore`; empty* → EmptyState | Uneven vs paged `DataTable` | Observe + large lists: prefer Infinite; empty taxonomy via empty* props. |
| **PageHeader** | `layout/page-header.tsx` | One identity row (eyebrow + title + actions) | Settings double title (rail `h2` + PageHeader) | Max **one** identity title per surface. |
| **PageContent** | `layout/page-content.tsx` | `size` default\|wide\|narrow\|full; padding owner | ~54% pages historically; CoreResourcePage covers many | Required unless shell already wraps it (`CoreResourcePage`). |

---

## 2. CTA contract (`Button`)

### Must

```tsx
import { Button } from "@/components/ui/button";

<Button variant="default" className="min-h-11" loading={busy}>
  Ingest
</Button>
```

| Rule | Detail |
|---|---|
| Import | `@/components/ui/button` (or barrel `@/components/ui`) |
| Accent fill | `variant="default"` (maps to `--accent`) — not custom `bg-[var(--accent)]` on native `<button>` |
| Height | Primary / EmptyState / mobile CTAs: **`min-h-11`** (44px). Aligns WCAG 2.2 AA / HIG floor from `w2-web-ux-standards`. |
| Busy | Use `loading` prop (disables + `Loader2`) — do not nest ad-hoc spinners unless icon-only. |
| Composition | `asChild` for `Link`/`a` CTAs that must look like buttons. |

### Must not

- Raw `<button className="…bg-[var(--accent)]…">` (or equivalent accent utilities) for product CTAs.
- `h-7` / `h-8` accent primary actions on Improve board, EmptyState, or mobile-critical paths without an enclosing ≥44px target.
- New accent CTAs outside `Button` on any Wave 4 touched file.

### Known drift purge list (Wave 1)

`users/page.tsx`, `gateway-tab.tsx`, `sidebar-settings-view.tsx`, `exports-tab.tsx`, `org-tab.tsx`, `guardrails/page.tsx`, `sso-tab.tsx`, `observability/cohorts/page.tsx`, plus broader ~53 accent `<button>` fragments (tools, time-travel, replay, QueryFilterBar chrome).

---

## 3. Tabs contract

### Must

```tsx
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

<Tabs value={view} onValueChange={setView}>
  <TabsList variant="underline">
    <TabsTrigger variant="underline" value="traces">Traces</TabsTrigger>
    <TabsTrigger variant="underline" value="spans">Spans</TabsTrigger>
    <TabsTrigger variant="underline" value="sessions">Sessions</TabsTrigger>
  </TabsList>
  <TabsContent value="traces">{/* table */}</TabsContent>
</Tabs>
```

| Surface | Contract |
|---|---|
| Traces / Spans / Sessions | `ui/tabs` inside `ResourcePageShell.toolbar` (P0-6) |
| Agents, Evals, Improve, Issues, Analytics, Fleet, Replay, Insights topics | Same primitive; hub-specific values |
| Settings rail | Keep rail layout; replace trigger implementation with `Tabs` or `SettingsRailTabs` wrapper over `ui/tabs` |
| `DetailPanelShell` modes | Transcript · Tree · Timeline · Metadata via `ui/tabs` — **refactor shell** so it does not own `role="tablist"` |

### Must not

- Page-local `role="tablist"` / `role="tab"` button rows.
- Legacy tool links as tab siblings (Inspector/Replay/Debugger/…) — overflow `DropdownMenu` or detail `CrossLinkBar` only (`w2-laminar-contracts` §B).

**Baseline:** Zero hubs imported `@/components/ui/tabs` at Wave 1. Wave 4 exit = **all hubs** + detail mode tabs compliant.

---

## 4. Resource shells — adoption targets

### Slot map (locked)

```
CoreResourcePage | ResourcePageShell
├── header     → PageHeader (≤1 identity row)
├── toolbar    → Tabs + QueryFilterBar + ViewsMenu + Live/Refresh  (≤1 band)
├── kpiStrip   → optional severity/status chips only
├── table      → InfiniteDataTable | DataTable | VirtualizedList
├── detail     → DetailPanelShell | null
└── bulkBar    → BulkActionBar when selection > 0
```

### Prefer `CoreResourcePage` when

- Page needs standard `PageContent` padding/max-width.
- List/table hub (Agents, Evals, Improve, Issues, Alerts, Artifacts, Ledger, …).

### Prefer direct `ResourcePageShell` when

- Outer padding already owned (today: `/traces` with explicit `PageContent`).

### Adoption targets (Wave 4)

| Priority | Surface | Target stack |
|---|---|---|
| P0 | `/traces` | `ResourcePageShell` + `ui/tabs` + `QueryFilterBar` + `InfiniteDataTable` + `DetailPanelShell` — **collapse to ≤2 bands** |
| P0 | `/issues`, `/alerts` | Already `CoreResourcePage` + detail — align toolbar to `ResourceOsToolbar` + `ui/tabs` where tabbed |
| P0 | `/evals`, `/agents`, `/improve` | Keep `CoreResourcePage`; migrate hand-rolled tabs → `ui/tabs` |
| P1 | `/analytics` | Promote from PageContent-only → `CoreResourcePage` |
| P1 | Datasets / experiments / playgrounds / labeling / synthetic (hub + leaves) | Parity toolbar + empty taxonomy |
| P1 | Observability leaves used as Trace facets | Do not add hub chrome; deep-link / overflow only |
| P2 | Remaining Advanced list pages without shell | Opportunistic on touch |

**Exit metric:** Resource shell family on core Observe/Evaluate/Improve hubs = **100%**; portal-wide list hubs ≫ Wave 1 **18/19%**.

### `DetailPanelShell` rules

| Viewport | Behavior |
|---|---|
| ≥1280px | Split; list stays mounted |
| 768–1279 | Drawer / sheet |
| &lt;768 | Full-page detail route OK; preserve deep link |

**Forbidden:** Primary open navigates away from list hub as happy path.

---

## 5. State recipes (Laminar table OS aligned)

### 5.1 Decision tree

```
async surface
 ├─ org / auth unresolved     → NoOrgState (not EmptyState)
 ├─ loading (no cached rows)  → QueryState loadingSlot | LoadingSkeleton variant="table"
 ├─ error                     → ErrorState + retry
 ├─ success, count == 0
 │   ├─ never had data        → ZERO-DATA (onboard CTA / WaitingForFirstEvent-class)
 │   ├─ filters / search set  → FILTERED EMPTY + Clear filters (no install CTA)
 │   └─ time/scope only       → PERIOD EMPTY (quiet EmptyState, no install CTA)
 └─ success, count > 0        → children (table / detail)
```

### 5.2 QueryState default

```tsx
<QueryState
  loading={isLoading}
  error={error}
  data={rows}
  isEmpty={rows.length === 0}
  onRetry={refetch}
  loadingSlot={<LoadingSkeleton variant="table" />}
  emptySlot={
    filtersActive ? (
      <EmptyState title="No matches" description="…" action={<Button className="min-h-11" onClick={clearFilters}>Clear filters</Button>} />
    ) : (
      <EmptyState title="No traces yet" action={<Button className="min-h-11">Connect SDK</Button>} />
    )
  }
>
  <InfiniteDataTable … />
</QueryState>
```

Callers **must** distinguish zero-data vs filtered via `emptySlot` (or DataTable `emptyTitle` + clear action). Single `isEmpty` boolean is insufficient alone — compute taxonomy before render (Traces: `deriveTracesListUi` pattern).

### 5.3 Ban `fallback={null}`

| Allowed null | Forbidden null |
|---|---|
| OnboardingOverlay (intentional invisible) | `settings/page.tsx` Suspense |
| SelectedTraceRail when no selection | `settings/(tabs)/gateway`, `agents/connect`, `replay` `useSearchParams` boundaries |

Replace forbidden sites with `LoadingSkeleton` / `PageLoadingSkeleton` / centered `Loader2` matching sibling hubs.

### 5.4 Loading metaphor consistency

| Context | Canonical |
|---|---|
| Route `loading.tsx` (portal lists) | `LoadingSkeleton variant="table"` (or stats/detail by page type) |
| In-page Suspense / tab switch | Same skeleton family as route — **not** spinner if route is skeleton |
| Action busy | `Button loading` / icon `Loader2` |
| Auth routes | Centered `Loader2` OK |

**Fix:** `fleet/loading.tsx` must not re-export the page.

### 5.5 Table empty props

`DataTable` / `InfiniteDataTable` empty* → `EmptyState`. Prefer empty* on the table when the shell already shows chrome; prefer hub-scale zero-data placeholder when never-ingested (Laminar P-01).

---

## 6. Migration priority (Wave 4 agents)

Execute in order — earlier items unblock later chrome work.

| Order | Workstream | Components | Why first |
|---:|---|---|---|
| 1 | **Primitives lint gate** | `Button`, `Tabs` | Stop new drift; enables safe hub PRs |
| 2 | **Suspense null purge** | Settings, connect, replay, gateway | Removes blank flashes (P0-7 / P0-8) |
| 3 | **Traces chrome collapse** | `ResourcePageShell`, `Tabs`, `QueryFilterBar`, `ViewsMenu`, `InfiniteDataTable` | P0-1 Observe band; highest overload |
| 4 | **DetailPanelShell tabs** | `DetailPanelShell` → `ui/tabs` + Transcript modes | P0-4; depends on stable hub toolbar |
| 5 | **Hub Tabs sweep** | Agents, Evals, Improve, Issues, Analytics, Fleet, Replay, Insights | P0-6 remainder |
| 6 | **CTA purge** | Raw accent `<button>` file list + QueryFilterBar | P0 Button; can parallelize after lint gate |
| 7 | **QueryState adoption** | Traces, Issues, Alerts, Evals, observability leaves missing empty | P0-7; empty taxonomy |
| 8 | **Shell parity** | Analytics → `CoreResourcePage`; Issues/Alerts toolbar parity | Completes resource OS |
| 9 | **Settings rail Tabs wrapper** | Settings ~21 tabs | P0-6/P0-8; keep layout, swap control |
| 10 | **Leaves opportunistic** | Guardrails, cohorts, tools, users, … | Same contracts on touch |

**Do not** invent page-local shells. Always compose §4 slots.

---

## 7. Lint invariants

Wave 4 must add or extend checks (local scripts → CI when ready). Fail the PR on new violations in `clients/portal/src`.

| ID | Invariant | Suggested enforcement |
|---|---|---|
| L1 | No raw accent CTA: `<button` + `bg-[var(--accent)]` / `bg-accent` product patterns outside `ui/button.tsx` | `lint:portal-classes` or dedicated `lint:portal-cta` rg gate |
| L2 | Hub/page files under `app/(portal)/{traces,agents,evals,improve,issues,alerts,analytics,fleet,replay,settings}/**` must not introduce new `role="tablist"` | rg deny-list; allowlist only `components/ui/tabs.tsx` until DetailPanelShell migrated |
| L3 | No new `fallback={null}` under `app/(portal)` except allowlisted overlay modules | rg + unit test update (unlock connect test that locks null) |
| L4 | New list hubs must import `CoreResourcePage` or `ResourcePageShell` | review checklist + optional import graph test |
| L5 | Touched async hubs must import `QueryState` **or** document DataTable empty* + ErrorState path | PR template / source-read test |
| L6 | Primary EmptyState actions include `min-h-11` or `Button` size default/lg | a11y / class lint subset |
| L7 | No `min-h-screen` / `h-screen` on portal pages | existing `lint:portal-layout` |
| L8 | Detail mode tabs after DetailPanelShell refactor: no `role="tab"` in `DetailPanelShell.tsx` | unit source test |

**Allowlist exceptions (document in lint config):** marketing `InstallSection` until marketing pass; intentional overlay Suspense nulls; non-CTA native `<button>` (icon chrome without accent fill).

---

## 8. Quick reference — do / don't

| Do | Don't |
|---|---|
| `Button` + `min-h-11` for accent CTAs | Raw accent `<button>` |
| `ui/tabs` on every hub | Hand-rolled `role="tablist"` |
| `CoreResourcePage` / `ResourcePageShell` slots | One-off page chrome stacks |
| `QueryState` + taxonomy empties | `if (loading)` sprawl + blank Suspense |
| Table-shaped `LoadingSkeleton` | Spinner on navigate + skeleton on tab (mixed metaphor) |
| Clear-filters empty | Install CTA when filters caused empty |

---

## 9. Acceptance (Wave 4 exit for this contract)

- [ ] Zero new raw accent CTAs on touched surfaces; known purge list cleared or ticketed.
- [ ] All hubs in §3 import `@/components/ui/tabs`.
- [ ] Traces ≤2 chrome bands; toolbar owns Tabs + filters + views.
- [ ] `DetailPanelShell` mode tabs use `ui/tabs`.
- [ ] No forbidden `fallback={null}` under portal Settings/hubs/connect/replay.
- [ ] Traces + ≥2 other hubs use `QueryState` (or equivalent empty taxonomy) with zero-data ≠ filtered.
- [ ] Lint invariants L1–L3 enforced in portal scripts.

---

*End of w3-component-contract.*
