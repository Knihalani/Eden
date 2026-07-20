# Wave 3 — Laminar Must-Match Acceptance Criteria

**Agent:** `w3-apply-laminar-bar`  
**Date:** 2026-07-20  
**Status:** Binding for Waves 4–6  
**Source contracts:** [`w2-laminar-contracts.md`](./w2-laminar-contracts.md) (§A–§E)  
**Steal-list:** [`w2-competitor-pattern-library.md`](./w2-competitor-pattern-library.md) P0-1…P0-9  
**Gap bar:** [`w2-gap-matrix.md`](./w2-gap-matrix.md) §1.1 / §3.1  
**Eden baseline:** [`w1-consolidated-inventory.md`](./w1-consolidated-inventory.md)  

**Rule:** Clone Laminar **interaction grammar** (chrome bands, table OS, dirty views, master–detail, state stack). Keep Eden tokens, U12 ≤12 core, `portal-os` / `ui` components. **Not** a visual skin.

**How to use:** Every `[ ]` below is a must-match check. Wave 6 `w6-final-verifier` / `w6-qa-matrix` greps this file. Owners in §7 are plan agent IDs from Waves 4–5 (plus Wave 6 where noted).

---

## 1. Shell acceptance

Cites [`w2-laminar-contracts.md`](./w2-laminar-contracts.md) **§A.1–A.4**. Steal: P0-8, P0-9.

### 1.1 Single org switcher

- [ ] **S-01** Clerk `OrganizationSwitcher` mounts **only** in sidebar chrome (`portal-chrome.tsx` / `#portal-sidebar`). No page-body org `<Select>` (Settings or elsewhere).  
  Contract: §A.1 Must · “Single org switcher”
- [ ] **S-02** Grep Settings (and other hubs) for a second org/project switcher returns **zero** interactive controls.  
  Contract: §A.4 · “No dual org switcher in Settings”

### 1.2 Collapse-safe org/project context

- [ ] **S-03** Sidebar collapsed to icon rail (`w-16` / collapsible icon) still exposes org/project context via monogram or compact trigger; control remains **clickable** (no Settings detour).  
  Contract: §A.1 · “Collapse-safe switcher” · Laminar parity noted in §A.1
- [ ] **S-04** Collapsed state does **not** hide the only org switcher (Wave 1 failure mode).  
  Contract: §A.4 · “Collapsed sidebar still opens org/project context”

### 1.3 Chrome band budget

- [ ] **S-05** Shell sticky header is **one** band (`h-11`: breadcrumbs | ⌘K | density/actions). Pages do not restack a second sticky shell.  
  Contract: §A.1 · “Page vs shell header”
- [ ] **S-06** Resource pages use at most: Identity (`PageHeader`) + **one** toolbar band + optional thin KPI strip + content + bulk bar. No third stacked page chrome band on Observe hubs.  
  Contract: §A.2 Resource page chrome budget
- [ ] **S-07** Banner `top-*` offset matches sticky header height (`h-11`).  
  Contract: §A.4 · “Banner top-* offset”
- [ ] **S-08** `AppShell` slot tree unchanged (sidebar · header · banners · main · mobileNav · commandPalette · aiRail). Pages consume `CoreResourcePage` / `ResourcePageShell`, not one-off shells.  
  Contract: §A.1 Layout slots · §A.4

### 1.4 Settings identity

- [ ] **S-09** Settings shows **one** identity title: Settings rail heading **or** `PageHeader title="Settings"` — never both.  
  Contract: §A.1 · “Single Settings identity” · §A.3
- [ ] **S-10** Settings Suspense fallback is `LoadingSkeleton` / `PageLoadingSkeleton` — **never** `null`.  
  Contract: §A.3 · §A.4

### 1.5 Shell invariants (keep)

- [ ] **S-11** `CORE_NAV_ITEM_COUNT === 12`; Advanced collapsed by default; ⌘K indexes core + Advanced.  
  Contract: §A.1
- [ ] **S-12** No `min-h-screen` / `h-screen` on portal pages (layout lint).  
  Contract: §A.1 Must not

---

## 2. Traces hub acceptance

Cites **§B.1–B.5**. Steal: P0-1, P0-3, P0-5, P0-6.

### 2.1 ≤2 chrome bands

- [ ] **T-01** `/traces` renders exactly **one** identity `PageHeader` (eyebrow Observe · title Traces) + **one** toolbar band. Count of stacked page chrome bands ≤ **2**.  
  Contract: §B.5 · §A.2 Traces exception → target Identity + Toolbar only
- [ ] **T-02** Facet chips (`mcp` / `decisions` / `memory` / `retrieval`) live **inside** `QueryFilterBar` (or `?facet=` filter preset) — they do **not** create a third chrome band.  
  Contract: §B.1 `facet=` · §B.2 · §B.5

### 2.2 URL contract

- [ ] **T-03** Hub URL supports documented keys: `view` (traces|spans|sessions, default `traces`), `pastHours` **or** `from`/`to`, `q` **or** `filter`, `viewId`, `traceId`, `spanId`, optional `facet`, `live=1`.  
  Contract: §B.1
- [ ] **T-04** `/observability?trace_id=` redirects to `/traces?traceId=`. Happy-path open does **not** leave `/traces` list unmounted for primary detail.  
  Contract: §B.1 Redirects · §B.4 Forbidden

### 2.3 Tabs + QueryFilterBar + ViewsMenu composition

- [ ] **T-05** Toolbar composition (order): `Tabs` (traces|spans|sessions) + `QueryFilterBar` + `ViewsMenu` (+ Live/Refresh; DisplayMenu P1). No hand-rolled `role="tablist"` on hub.  
  Contract: §B.2 Hub composition · §B.5
- [ ] **T-06** Hub tabs import `@/components/ui/tabs` with `variant="underline"` (or shared hub Tabs wrapper over that primitive).  
  Contract: §B.2 Toolbar ownership · §B.5
- [ ] **T-07** Saved views scoped per table: Traces views never appear in Spans/Sessions dropdowns (`useSavedViews("traces"|"spans"|"sessions")`).  
  Contract: §B.2 · §C.1 Scoping

### 2.4 Legacy tools overflow

- [ ] **T-08** Inspector / Replay / Debugger / Time-Travel / Query are **not** siblings of Traces|Spans|Sessions tabs. Placement: header `DropdownMenu` overflow and/or detail `CrossLinkBar` only.  
  Contract: §B.2 · §B.5 · Pattern Library P0-1 / P1-5
- [ ] **T-09** Legacy tool routes may remain Advanced/leaves; they are **not** promoted onto the hub tab row.  
  Contract: §B.1 Redirects note

### 2.5 Master–detail URL

- [ ] **T-10** Selecting a row sets `?traceId=` (and optional `spanId`) **without** unmounting the table; selected row highlighted.  
  Contract: §B.4 · §B.5
- [ ] **T-11** Breakpoints: ≥1280px split pane; 768–1279 `DetailPanelShell` drawer/sheet; &lt;768 full-page detail OK with deep link preserved.  
  Contract: §B.4
- [ ] **T-12** Vitest / golden observe selectors updated for new chrome (`traces/__tests__/…` + observe probe).  
  Contract: §B.5 last bullet

---

## 3. Table OS acceptance

Cites **§C.1–C.6**. Steal: P0-2, P0-5.

### 3.1 Dirty amber views

- [ ] **V-01** `ViewsMenuTrigger` shows dirty/warning (amber) token when current `ViewState` ≠ active saved view and ≠ Default.  
  Contract: §C.2
- [ ] **V-02** Dirty detection includes **filters + sort + columns** (not filters alone).  
  Contract: §C.2 · “wire dirty detection to filters+sort+columns”
- [ ] **V-03** Actions present with Laminar semantics: **Save changes** · **Save as new** · **Discard**.  
  Contract: §C.2 · §C.6

### 3.2 View payload (columns + sort + filters)

- [ ] **V-04** Persisted/saved view payload includes `filters`, `sort[]`, `columns[]` (id/visible/width), optional `search`, optional `density`.  
  Contract: §C.1 ViewState tuple
- [ ] **V-05** URL always carries a shareable subset (`q`/`filter`, sort, `viewId`, id selection). Refresh restores URL state; `?viewId=` restores saved preset.  
  Contract: §C.1 Persistence · §C.6
- [ ] **V-06** Issues + Alerts use same `ResourceOsToolbar` + `ViewsMenu` path (no one-off filter chrome).  
  Contract: §C.6

### 3.3 InfiniteDataTable on Observe core

- [ ] **V-07** Traces / Spans / Sessions list bodies use `InfiniteDataTable` (cursor/keyset `hasMore` / `onLoadMore`).  
  Contract: §C.4 Pagination · gap matrix §2.4 P0
- [ ] **V-08** Virtualization on when ≥~200 visible rows.  
  Contract: §C.4
- [ ] **V-09** Filter modes: Basic (`?filter=`) ↔ Query (`?q=`) on Observe; power SQL/Query is **escape hatch** (new tab / leaf), not a third chrome band.  
  Contract: §C.3 · Pattern Library P0-5
- [ ] **V-10** Empty path distinguishes never-ingested CTA vs “No matches” + Clear filters; errors use `ErrorState` + retry via `QueryState`.  
  Contract: §C.4 Empty/Error · §C.6 · “No blank Suspense on resource hubs”

---

## 4. Detail modes

Cites **§B.3**. Steal: P0-4.

- [ ] **D-01** Detail mode tabs exist: **Transcript · Tree · Timeline · Metadata**. Implemented via `ui/tabs` inside `DetailPanelShell` (not ad-hoc controls).  
  Contract: §B.3
- [ ] **D-02** **Transcript** is the **default** mode on open.  
  Contract: §B.3 · §B.5
- [ ] **D-03** Transcript renders agent input, LLM turns, tool one-line previews, collapsible subagent cards (`TranscriptView`). Density uses Eden tokens (U19) — not Laminar px copy.  
  Contract: §B.3 · §E non-goal pixel-match
- [ ] **D-04** Tree: virtualized parent/child with duration/tokens/cost; collapsible branches.  
  Contract: §B.3
- [ ] **D-05** Timeline: condensed Gantt; zoom; optional session playhead.  
  Contract: §B.3
- [ ] **D-06** Metadata: read-only JSON of trace metadata.  
  Contract: §B.3
- [ ] **D-07** Detail header exposes: id · status · cost · tokens · session · user · Share · fullscreen · close.  
  Contract: §B.3 Detail header
- [ ] **D-08** Keyboard (U01 align): `j`/`k` next/prev; `Esc` close; `f` fullscreen; `⌘F` in-trace search when wired.  
  Contract: §B.3 Keyboard

---

## 5. Empty / loading state stack

Cites **§A.3**, **§C.4**, **§C.6**; Pattern Library **P0-7**; empty recipe in [`w2-laminar-empty-loading.md`](./w2-laminar-empty-loading.md) §2.

- [ ] **E-01** Async hubs default to `QueryState` (loading → error → empty → children). No blank screen.  
  Contract: §C.4 · Pattern Library P0-7
- [ ] **E-02** Loading uses layout-matched `LoadingSkeleton variant="table"` (or equivalent) matching density — not a lone spinner for initial table load.  
  Contract: §C.4 Loading
- [ ] **E-03** Zero-data (never ingested) ≠ filtered empty ≠ period empty. Filtered empty offers Clear filters; zero-data offers onboard CTA (`WaitingForFirstEvent` / hub placeholder).  
  Contract: empty-loading P-01/P-03 · §C.4 Empty
- [ ] **E-04** Error uses `ErrorState` + retry; copy ≠ empty.  
  Contract: §C.4 Error
- [ ] **E-05** No `Suspense fallback={null}` on Settings or Observe resource hubs (intentional overlays exempt).  
  Contract: §A.3 · §C.6 · Pattern Library P0-7 / anti-pattern “Blank Suspense”
- [ ] **E-06** Org/auth unresolved uses org skeleton / `NoOrgState` — not `EmptyState`.  
  Contract: empty-loading §2 decision tree

---

## 6. Explicit non-goals (not P0)

Cites **§E** and gap matrix §1.3. Do **not** block Wave 4–5 on these.

| ID | Non-goal | Why |
|---|---|---|
| NG-01 | Laminar / Braintrust **skin** (colors, typography, logo, light theme) | Brand moat; §E |
| NG-02 | Expanding core nav past **12** to mirror peer IA | U12 hard cap; §A.1 Must not · §E |
| NG-03 | Shipping **SQL Editor** depth / Open-in-SQL as P0 chrome | Escape hatch only; §C.3 Power · §E · gap §1.3 |
| NG-04 | Render templates / Braintrust Loop as chrome requirements | Pattern Library P2 / anti-pattern |
| NG-05 | Pixel-matching Laminar transcript spacing | Eden density tokens / U19; §E |
| NG-06 | Langfuse filter **sidebar rail** pixel layout | Dual-editor contract only; gap §1.3 |
| NG-07 | Personal→project→org default-view hierarchy complete | §C.5 P1 after dirty/save solid |
| NG-08 | Display menu / Live-as-first-class / Chat-with-trace / full Traces bulk registry | Pattern Library P1 — after P0 OS |

---

## 7. Owner map (criterion → Wave 4/5 agent + Eden path)

Paths relative to `clients/portal/src/`. Wave 6 agents verify, not invent P0 OS.

| ID | Wave owner(s) | Primary Eden path(s) |
|---|---|---|
| S-01, S-02 | `w4-org-switcher-dedupe` | `app/(portal)/portal-chrome.tsx`; Settings page under `app/(portal)/settings/` |
| S-03, S-04 | `w4-org-switcher-dedupe` · `w4-appshell-breathing` | `portal-chrome.tsx`; `components/portal-os/AppShell.tsx` |
| S-05, S-07, S-08 | `w4-appshell-breathing` · `w4-resource-shells` | `AppShell.tsx`; `CoreResourcePage.tsx`; `ResourcePageShell.tsx` |
| S-06 | `w4-page-chrome` · `w5-traces-hub` | `components/layout/page-header.tsx`; `app/(portal)/traces/page.tsx` |
| S-09, S-10 | `w4-org-switcher-dedupe` · `w4-page-chrome` · `w5-settings` · `w4-states-normalize` | `settings/*`; `page-header.tsx`; `page-content.tsx` |
| S-11 | `w4-sidebar-cleanup` | `lib/sidebar-config.ts`; `CommandPalette` under `portal-os/` |
| S-12 | `w4-lint-gates` | layout lint scripts; portal pages |
| T-01, T-02, T-05, T-08, T-09 | `w5-traces-hub` · `w4-filter-toolbar` · `w4-tabs-unify` | `traces/page.tsx`; `QueryFilterBar.tsx`; `ui/tabs.tsx`; `CrossLinkBar.tsx` |
| T-03, T-04, T-10, T-11 | `w5-traces-hub` · `w4-resource-shells` · `w4-ia-redirects` | `useResourceUrlState` (portal-os/hooks); `DetailPanelShell.tsx`; redirects |
| T-06 | `w4-tabs-unify` · `w5-traces-hub` | `components/ui/tabs.tsx`; hub pages |
| T-07, V-01…V-06 | `w4-resource-shells` · `w4-filter-toolbar` · `w5-traces-hub` · `w5-issues-alerts` | `ViewsMenu.tsx`; `useSavedViews`; `ResourceOsToolbar`; Issues/Alerts hubs |
| V-07, V-08 | `w4-resource-shells` · `w5-traces-hub` | `InfiniteDataTable.tsx` |
| V-09 | `w4-filter-toolbar` · `w5-observe-leaves` | `QueryFilterBar.tsx`; observability query leaf |
| V-10, E-01…E-06 | `w4-states-normalize` · `w5-traces-hub` · `w6-empty-microcopy` | `ui/query-state.tsx`; `empty-state.tsx`; `error-state.tsx`; `LoadingSkeleton` |
| D-01…D-08 | `w5-detail-panels` · `w5-transcript` · `w5-traces-hub` | `DetailPanelShell.tsx`; `observability/TranscriptView.tsx`; tree/timeline children |
| T-12 | `w5-traces-hub` · `w6-visual-regression` / `w6-qa-matrix` | `traces/__tests__/`; `e2e/golden/` |
| NG-* | — (explicit skip) | Document in Design Brief; `w6-final-verifier` confirms not treated as P0 |

### Component touch list (from contracts §D)

| Component | Path |
|---|---|
| `AppShell` | `components/portal-os/AppShell.tsx` |
| `PortalChrome` | `app/(portal)/portal-chrome.tsx` |
| `CoreResourcePage` / `ResourcePageShell` | `components/portal-os/*` |
| `PageHeader` / `PageContent` | `components/layout/*` |
| `Tabs` | `components/ui/tabs.tsx` |
| `QueryFilterBar` | `components/portal-os/QueryFilterBar.tsx` |
| `ViewsMenu` / `useSavedViews` | `components/portal-os/*` |
| `InfiniteDataTable` | `components/portal-os/InfiniteDataTable.tsx` |
| `DetailPanelShell` | `components/portal-os/DetailPanelShell.tsx` |
| `TranscriptView` | `components/observability/TranscriptView.tsx` |
| `BulkActionBar` | `components/portal-os/BulkActionBar.tsx` |
| `CrossLinkBar` | `components/portal-os/CrossLinkBar.tsx` |
| `QueryState` / `EmptyState` / `ErrorState` | `components/ui/*` |

---

## 8. Checklist rollup

| Section | IDs | Count |
|---|---|---:|
| Shell | S-01…S-12 | 12 |
| Traces hub | T-01…T-12 | 12 |
| Table OS | V-01…V-10 | 10 |
| Detail modes | D-01…D-08 | 8 |
| Empty/loading | E-01…E-06 | 6 |
| **Must-match total** | | **48** |
| Non-goals (documented skip) | NG-01…NG-08 | 8 |

**Wave 4 chrome exit (minimum):** S-01…S-10, S-12, E-05.  
**Wave 5 Observe exit (minimum):** T-01…T-11, V-01…V-05, V-07, D-01…D-02, E-01…E-04.  
**Wave 6 verify:** all 48 must-match boxes + confirm NG-* not filed as P0 defects.

---

*End of w3-laminar-acceptance. Binding until Design Brief amends with explicit ID strikes.*
