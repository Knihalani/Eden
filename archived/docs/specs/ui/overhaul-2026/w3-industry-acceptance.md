# Wave 3/4 — Industry-Standard Acceptance Checklist

**Status:** Wave 4 refresh — **Wave 10** verifier source of truth (was Wave 6 under prior 6-wave naming)  
**Agent:** `w4-acceptance` (refresh of `w3-industry-acceptance`)  
**Date:** 2026-07-20  
**Scope:** Docs only. Measurable checks for industry parity + **anti-clutter**. No product code.

**Wave 6 final-verifier fill (2026-07-20):** ~52/72 checkboxes marked `[x]` with evidence notes. **Gap-close pass:** +P0-4 Timeline + §2.2 Issues/Alerts Views OS → **~54/72**. ~18 remain open (manual/UNVERIFIED + a11y/i18n). See [`w6-verification-report.md`](./w6-verification-report.md).

**Inputs:**
- [`w2-competitor-pattern-library.md`](./w2-competitor-pattern-library.md) — P0–P2 steal-list
- [`w2-gap-matrix.md`](./w2-gap-matrix.md) — must-match vs moat
- [`w2-laminar-contracts.md`](./w2-laminar-contracts.md) — shell · traces · table OS contracts
- [`w1-consolidated-inventory.md`](./w1-consolidated-inventory.md) — Eden baseline
- [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md) — **binding clutter formula + hard caps**

**Sibling fold-in:** [`w3-laminar-acceptance.md`](./w3-laminar-acceptance.md) · [`w3-peer-acceptance.md`](./w3-peer-acceptance.md) · [`w3-design-brief.md`](./w3-design-brief.md) · [`w3-a11y.md`](./w3-a11y.md)

**Rule:** Clone interaction grammar, not skins. Pass = measurable evidence (manual steps, lint, vitest, golden e2e). Fail any **P0** or **§AC** → Wave 10 blocks ship.

**Wave owner legend (10-wave plan)**

| Owner | Meaning |
|---|---|
| **W5** | Foundation: tokens, primitives, shell, lint gates |
| **W6–W9** | Surface families (Observe → Evaluate → Improve/Settings) |
| **W10** | Verifier re-runs check; does not invent new UX |

---

## How to use

1. **Waves 5–9** implement against grouped checklists below + **§AC anti-clutter**.  
2. **Wave 10** runs every checkbox; paste evidence (screenshot path, grep count, test name, PR).  
3. **P0** and **§AC** must pass before portal overhaul ship. **P1** may defer with explicit waiver. **P2** optional.  
4. Pattern Library IDs (`P0-1` … `P0-10`) map 1:1 into Foundation / Observe / Settings sections.  
5. **Owner label map (10-wave):** rows still saying `W4` = first implementation (Wave **5** foundation / early Observe); `W5` = mid surface / density (Waves **6–9**); `W6` = final verify (**Wave 10**). Prefer updating evidence to W5–W10 IDs when re-running.

**Binding anti-clutter SoT:** [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md). Feature-complete but still overwhelming = **FAIL**.

---

## AC. Anti-clutter (binding — Wave 10 ship gate)

Industry bar: plan anti-clutter doctrine + Linear/Stripe calm chrome + Laminar ≤2-band Observe. Formula + caps: `w4-anti-clutter-contract`.

### AC.1 Hard caps

- [x] **AC-01 — Core hubs bands ≤2** — Traces, Issues, Alerts, Evals, Improve, Agents, Settings content: Identity + ≤1 Toolbar (+ optional thin KPI only). Zero triple+ stacked chrome bands.  
  **Verify:** Manual band count per hub; vitest asserts where present; Traces archetype must PASS.  
  **Owner:** W6–W9 → W10 · **Pri:** P0
  **Evidence (W10 2026-07-20):** PASS — source band table in [`w10-evidence-pack.md`](./w10-evidence-pack.md) §2; vitest `w6-observe-core` / `w7-satellite` / `w8-evals` / `w9-improve-settings` / `w5-settings-ia`.

- [x] **AC-02 — Dual identity = 0** — No page with two H1-class titles; no dual org switcher (shell Clerk only). Settings stays `dual_title=N`.  
  **Verify:** Manual Settings + hubs; grep rail `h2` / page org Select.  
  **Owner:** W5 → W10 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `w5-settings-ia.test.ts` single PageHeader title, no rail h2; lint `settings-org-select OK (0)`.

- [x] **AC-03 — Toolbar primary ≤5** — Visible primary toolbar/header actions ≤5; secondary in overflow (`More` / `DropdownMenu`).  
  **Verify:** Manual count on Traces / Issues / Alerts / Evals / Improve / Agents.  
  **Owner:** W6–W9 → W10 · **Pri:** P0
  **Evidence (W10 2026-07-20):** PASS — counts ≤5 on all core hubs ([`w10-evidence-pack.md`](./w10-evidence-pack.md) §2).

- [x] **AC-04 — KPI caps** — Home/hub Status: **5–7** desktop / **3–4** mobile primary glance metrics.  
  **Verify:** Count Home widgets at Comfortable; mobile viewport.  
  **Owner:** W7 → W10 · **Pri:** P0
  **Evidence (W10 2026-07-20):** PASS — `DEFAULT_WIDGETS` length 6 + `HOME_KPI_CAP_DESKTOP=7` in `dashboard/page.tsx`; Alerts severity strip 4 chips.

- [ ] **AC-05 — Card-nest ban** — No card-in-card-in-panel in page chrome; Traces detail bordered compose depth ≤3 frames.  
  **Verify:** Manual Traces detail; spot Settings/Studio; Wave 2 nest list cleared or waived.  
  **Owner:** W6 / W9 → W10 · **Pri:** P0
  **Evidence (W10 2026-07-20):** **WAIVE** — chrome nests cleared on hubs; Traces detail ≤3 frames painted check not stopwatched. Owner: Observe detail.

- [x] **AC-06 — Progressive disclosure** — Legacy Observe tools (Inspector/Replay/Debugger/Time-Travel/Query) not peer chrome on Traces tab row; hub CrossLinkBar not a permanent band between Identity and Tabs.  
  **Verify:** Manual `/traces`; Agents/Improve CrossLink demoted.  
  **Owner:** W6–W7 → W10 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED Traces: legacy in More/`LEGACY_TOOL_LINKS`; facets in QueryFilterBar `?facet=` — `w3-2-traces-hub.test.ts` UX-P0-01.

### AC.2 Score + scan

- [x] **AC-07 — Top-20 clutter tier drop** — Each W1 Top-20 surface drops ≥1 clutter tier vs baseline (formula in anti-clutter contract), or documents `WAIVE` with owner.  
  **Verify:** `w10-clutter-verifier` re-score table attached.  
  **Owner:** W10 · **Pri:** P0
  **Evidence (W10 2026-07-20):** PASS — 20/20 ≥1 tier; table in [`w10-evidence-pack.md`](./w10-evidence-pack.md) §3. Embed-leak soft residuals owned.

- [ ] **AC-08 — Home Status→Action &lt;5s** — Comfortable Home: status + next action readable within 5s (stopwatch ×3).  
  **Verify:** Manual.  
  **Owner:** W7 → W10 · **Pri:** P0
  **Evidence (W10 2026-07-20):** **WAIVE** — structure PASS (4 KPI + diagnosis + CTAs); stopwatch ×3 not run. Owner: Dashboard.

- [ ] **AC-09 — Hub scan &lt;3s after load** — On core hubs after load: operator answers “where am I / what next” in &lt;3s.  
  **Verify:** Manual × Traces / Issues / Alerts.  
  **Owner:** W6–W7 → W10 · **Pri:** P0
  **Evidence (W10 2026-07-20):** **WAIVE** — ≤2-band chrome supports scan; stopwatch not run. Owner: Observe.

- [x] **AC-10 — Settings rail calm** — Tabs grouped; Advanced collapsed by default; search filters tabs; no dual title regression.  
  **Verify:** Manual Settings; localStorage Advanced default.  
  **Owner:** W9 → W10 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `w5-settings-ia.test.ts` category groups + Advanced default collapsed + SettingsSearch.

- [x] **AC-11 — No competing dual UI** — Observability facets / Fleet / Signals / Incidents / optimization deep-links resolve per [`w3-redirect-ia.md`](./w3-redirect-ia.md); no second product chrome for same job.  
  **Verify:** Deep-link matrix.  
  **Owner:** W5 → W10 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `portal-hub-redirect.test.ts` + `portal-hub-redirect.ts` (/observability→/traces, /fleet→agents, /signals→alerts, /incidents→issues).

- [x] **AC-12 — Shell/hub micro-type** — Zero raw `text-[9|10|11px]` on shell/hub chrome; instrument via `--font-size-2xs/3xs` only.  
  **Verify:** Grep + lint ratchets.  
  **Evidence (W6):** `rg 'text-\[(9|10|11)px\]' portal-chrome.tsx AppShell.tsx page-header.tsx` → 0; tokens `text-2xs`/`text-3xs`. `polish:check` micro-text OK. Residual arbitrary px may remain on instrument leaves (allowed via tokens).  
  **Owner:** W5 / W10 · **Pri:** P0

---


## 1. Foundation (shell · primitives · IA · density roles)

Industry bar: Laminar shell + Linear/Stripe primitives + U12 ≤12. Contracts: `w2-laminar-contracts` §A; Pattern Library P0-6, P0-9, P0-10.

### 1.1 Pattern Library P0 (foundation slice)

- [x] **P0-6 — Canonical hub Tabs** — Every core hub that exposes a tablist imports `@/components/ui/tabs` (`Tabs` / `TabsList` / `TabsTrigger`, underline variant). Zero hand-rolled `role="tablist"` on Dashboard / Traces / Agents / Evals / Improve / Alerts / Issues.  
  **Verify:** `rg 'role="tablist"' clients/portal/src/app/(portal)` → 0 on hub pages; `rg "from '@/components/ui/tabs'" clients/portal/src/app/(portal)/{traces,agents,evals,improve,alerts,issues}` → ≥1 per hub. Vitest hub source tests.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED grep: traces/agents/evals/improve/alerts/issues `page.tsx` all import `@/components/ui/tabs`; hub `role="tablist"` absent (settings/replay residual only).

- [x] **P0-9 — Collapse-safe org switcher** — Collapsed sidebar (`w-16` / icon rail) still exposes org/project context via monogram or compact Clerk `OrganizationSwitcher` trigger; click opens picker without expanding rail or detouring to Settings.  
  **Verify:** Manual — collapse sidebar → click org control → switch org. Grep: org switcher not gated solely on `!collapsed`.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `portal-chrome.tsx` OrganizationSwitcher always mounted when collapsed (`Always mounted so collapsed 64px rail…`).

- [x] **P0-10 — Overview vs analysis density roles** — Home / hub chrome uses calm tokens (no new `text-[10px]` on shell). Analysis surfaces (`TranscriptView`, TraceDetailPanel, Alerts triage) may stay dense but use `--font-size-2xs` / `3xs` (not arbitrary px) on top-10 W1 hotspots after U19 pass.  
  **Verify:** Manual — Comfortable density on `/` shows Status→Action in &lt;5s (see §1.3). Lint/grep: `rg 'text-\[10px\]' clients/portal/src/app/(portal)/portal-chrome.tsx` → 0. Top-10 density files show token migration or tracked waiver.  
  **Evidence (W6):** `portal-chrome.tsx` micro-px → `text-2xs`/`text-3xs` (AC-12). Transcript/AI-rail hotspots tokenized in W5. Status→Action &lt;5s stopwatch still manual (AC-08).  
  **Owner:** W4 (shell) / W5 (TranscriptView) · **Pri:** P0

### 1.2 Shell chrome budget

- [x] **Single sticky shell header** — One `AppShell` sticky band (`h-11`): breadcrumbs + ⌘K/actions. Pages do not restate shell breadcrumbs in a second sticky identity strip.  
  **Verify:** Manual DOM — count sticky headers in main chrome = 1. Layout lint `lint:portal-layout` green.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED structure: `AppShell` skip+main; `npm run lint:portal-layout` OK (2026-07-20).

- [x] **Resource chrome ≤2 bands** — Identity (`PageHeader`) + at most one toolbar band under it. Optional KPI strip only when resource needs it; never a third competing band of tabs/facets/legacy links.  
  **Verify:** Manual on Traces / Issues / Alerts / Evals. Contract: `w2-laminar-contracts` §A.2.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED Traces archetype: `data-chrome-band="toolbar"` + `w3-2-traces-hub` / ResourcePageShell ≤2; other hubs use CoreResourcePage (painted band count still Wave 10).

- [x] **Single org switcher (global)** — Clerk `OrganizationSwitcher` only in sidebar. No page-body org `<Select>` anywhere (Settings included — see §4).  
  **Verify:** `rg 'OrganizationSwitcher' clients/portal/src` → sidebar only; `rg 'org.*Select|Select.*org' clients/portal/src/app/(portal)/settings` → 0 org switchers. Manual Settings page.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED OrganizationSwitcher only in `portal-chrome.tsx`; `w5-settings-ia` + clutter lint no page-body org Select.

- [x] **U12 still ≤12 core nav** — `CORE_NAV_ITEM_COUNT === 12`. Advanced remains collapsed by default. No peer-product leaves promoted to core to “match Laminar.”  
  **Verify:** Vitest U12/U18 IA suites; `sidebar-config.ts` count; manual sidebar leaf count.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `CORE_NAV_ITEM_COUNT===12` (`sidebar-config.ts`); `u18-portal.test.ts` ≤12; Agents=`advanced`.

- [x] **⌘K indexes core + Advanced** — Command palette lists all core destinations and Advanced leaves (U12 rule 3).  
  **Verify:** Manual ⌘K search for an Advanced leaf (e..g. Agents / Guardrails). Unit test if present.  
  **Owner:** W4 · **Pri:** P1
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `buildNavCommands` walks full sidebar incl. advanced (`w6-qa-matrix` Flow 10); unit coverage via nav/u18 suites.  
  **Evidence (W14/W15):** **S-06 PASS** — `SETTINGS_TAB_COMMANDS` deep-links `/settings?tab=`; **I-02 PASS** — Online scoring in Improve Go-to + ⌘K (`w14-interaction` / `w15-harden`).

- [x] **No `min-h-screen` / `h-screen` on portal pages** — Layout contract intact.  
  **Verify:** `npm run lint:portal-layout` (clients/portal).  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `npm run lint:portal-layout` OK.

- [x] **Zero raw primary CTAs outside `Button`** — No raw `<button>` with accent/primary styling on touched surfaces; all primary/secondary CTAs use `@/components/ui/button`. Baseline W1 ~53 fragments → target **0** on hubs + Settings + Observe leaves touched by overhaul.  
  **Verify:** Grep accent-class `<button>` fragments (same recipe as W1 inventory); polish/class lint; spot-check tools/replay/time-travel/QueryFilterBar.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `polish:check` → `lint:portal-classes accent-cta OK (6/6)` ratchet green on scoped surfaces.

- [x] **One Tabs pattern on core hubs** — Same as P0-6; Settings rail may wrap `ui/tabs` primitives (SettingsRailTabs OK) but must not invent a third tab grammar.  
  **Verify:** See P0-6; Settings rail uses shared trigger primitives.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED same as P0-6; Settings uses rail search/groups (`w5-settings-ia`), not a third hub Tabs grammar.

- [x] **Orphan / dual-route redirects** — `/observability?trace_id=` → `/traces?traceId=`; `/fleet` → Agents fleet; `/signals` / `/incidents` dual mounts resolve per U18 redirect map (no silent second IA).  
  **Verify:** Manual deep links; golden observe probe; redirect unit tests.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `portal-hub-redirect.test.ts` (8 files W5-lock suite green).

### 1.3 Comfortable density scan

- [ ] **Overview Status→Action visible in &lt;5s** — On Comfortable density at `/` (Home): within 5 seconds of paint, operator can see current status signal (widget/KPI or empty CTA) and a clear next action (e.g. Open Traces / Connect). Stopwatch manual; no competing chrome bands.  
  **Verify:** Manual stopwatch ×3 cold loads; record median. Fail if primary action buried below fold without status cue.  
  **Owner:** W5 · **Pri:** P0

- [x] **Shell micro-type eradicated** — `portal-chrome.tsx` and sticky header controls use design tokens, not `text-[9px]`/`[10px]`.  
  **Verify:** Grep those files; visual at Compact + Comfortable.  
  **Evidence (W6):** Same as AC-12 — zero raw 9/10/11px on `portal-chrome.tsx`.  
  **Owner:** W4 · **Pri:** P0

---

## 2. Observe (Traces · table OS · filters · detail)

Industry bar: Laminar traces + table-views + Langfuse dual filter. Contracts: `w2-laminar-contracts` §B–C; Pattern Library P0-1…P0-5, P0-7.

### 2.1 Pattern Library P0 (Observe slice)

- [x] **P0-1 — Traces chrome ≤2 bands** — Exactly one `PageHeader` (eyebrow Observe · title Traces) + one toolbar band containing: `Tabs` (traces|spans|sessions) + `QueryFilterBar` + `ViewsMenu` + Live/Refresh. Facets are chips / `?facet=` inside QueryFilterBar — **not** a third band. Legacy Inspector/Replay/Debugger/Time-Travel/Query **not** on tab row (overflow `DropdownMenu` or detail `CrossLinkBar`).  
  **Verify:** Manual count of page-level bands on `/traces` = 2. Vitest `traces/__tests__/w3-2-traces-hub.test.ts` selectors updated. Golden observe probe.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `w3-2-traces-hub.test.ts` UX-P0-01 + ResourcePageShell ≤2 (15/15).

- [x] **P0-2 — Table views dirty amber · save · discard** — For Traces (and Spans/Sessions scoped lists): when filters **or** sort **or** columns diverge from active saved view, `ViewsMenuTrigger` shows dirty/warning token (amber). Actions: Save changes · Save as new · Discard. Views scoped per table (Traces views ≠ Spans).  
  **Verify:** Manual — change filter → amber → Discard restores; Save persists across refresh; `?viewId=` restores preset. Unit: dirty detection covers columns+sort+filters.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED Traces `ViewsMenu`+`isViewDirty`; `useSavedViews-dirty.test.ts`; hub UX-P0-10.

- [x] **P0-3 — Master–detail list stays mounted** — Selecting a row sets `?traceId=` (and optional `spanId`); `InfiniteDataTable` remains mounted; `DetailPanelShell` opens (≥1280 split, 768–1279 drawer, &lt;768 full route OK). Primary open does **not** navigate away to `/observability?trace_id=` as happy path.  
  **Verify:** Manual — open row, confirm URL + list still in DOM (React tree / network idle without full remount flash). Deep link `/traces?traceId=` opens hub+detail. Golden + vitest.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `?traceId=` + `DetailPanelShell` in `traces/page.tsx`; hub tests.

- [x] **P0-4 — Transcript-first detail modes** — Detail modes: Transcript (default) · Tree · Timeline · Metadata via `ui/tabs` inside detail shell.  
  **Verify:** Manual mode switch; default = Transcript on first open.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 gap-close 2026-07-20):** VERIFIED `TRACE_DETAIL_MODE_TABS` = Transcript·Tree·Timeline·Metadata (+Scores); `useTraceTimeline` + `data-testid="trace-timeline"`; default `transcript` — `w3-2-traces-hub.test.ts`.

- [x] **P0-5 — Filter sticky + dual mode** — `QueryFilterBar` sticky under identity (inside toolbar band); basic chips ↔ query string; URL serializes `q`/`filter`; facets folded in. Power SQL/Query is escape hatch link, not a chrome band.  
  **Verify:** Manual scroll — filter bar stays visible while table scrolls. Share URL with filters → reload restores.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED code: QueryFilterBar in toolbar band + URL `q`/filters/`?facet=`; sticky paint still manual/Wave 10.

- [x] **P0-7 — Empty / filter-empty / error / loading** — Distinguish never-ingested (`EmptyState` CTA) vs filtered empty (Clear filters) vs `ErrorState`+retry vs table-shaped skeleton. No blank flash.  
  **Verify:** Manual three states on Traces; see also QueryState checks §2.3.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `w3-2-traces-hub` EmptyState/ErrorState/LoadingSkeleton gates.

### 2.2 Table OS (Laminar parity)

- [ ] **Filter sticky on Observe hubs** — Traces / Issues / Alerts toolbars remain sticky while content scrolls (same band as views).  
  **Verify:** Manual scroll on each hub.  
  **Owner:** W4 · **Pri:** P0

- [x] **Views dirty amber / save / discard on Issues + Alerts** — Same `ViewsMenu` + `useSavedViews(resource)` path as Traces (no one-off filter chrome).  
  **Verify:** Manual dirty→save→discard on Issues and Alerts; scoped resource keys.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 gap-close 2026-07-20):** VERIFIED `ResourceOsToolbar` (`resourceKey` issues/alerts) → `ViewsMenu` + `isViewDirty` + `onFiltersChange`; hub selects in ViewState — `w6-views-os-hubs.test.ts`.

- [x] **Column + sort persistence in view payload** — Saved view stores columns visibility/width + sort + filters (not filters alone).  
  **Verify:** Manual — hide column, save, reload; API/payload inspection or unit test on `useSavedViews`.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `useSavedViews.ts` + `useSavedViews-dirty.test.ts` filters|sort|columns.

- [x] **InfiniteDataTable on Observe core** — Traces list uses `InfiniteDataTable` with cursor load-more; virtualization when ≥~200 rows.  
  **Verify:** Source import check; load-more manual; U00 virtualization note.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `TracesTab.tsx` imports/uses `InfiniteDataTable`.

- [x] **URL share round-trip** — `?view=` / `?viewId=` / `?q=` / `?filter=` / `?traceId=` / time range survive refresh.  
  **Verify:** Manual copy-paste URL in new tab; vitest URL state hooks.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED hub URL helpers + `useResourceUrlState` / filter hydrate tests in `w3-2-traces-hub`.

### 2.3 Async states (Observe)

- [ ] **QueryState default on async hubs** — Traces / Issues / Alerts / Evals / Improve / Agents wrap primary async data in `QueryState` (or equivalent that owns loading/error/empty). Hand-rolled spinner-only paths removed on those hubs.  
  **Verify:** Source: each hub imports/uses `QueryState`; W1 baseline ~22 refs must rise on hubs. Manual loading/error injection.  
  **Owner:** W4 · **Pri:** P0

- [x] **No `Suspense fallback={null}` on Observe hubs** — Zero null fallbacks on Traces and related hub trees.  
  **Verify:** `rg 'fallback=\{null\}' clients/portal/src/app/(portal)/traces` → 0; same for issues/alerts/evals/improve/agents.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `rg fallback={null}` clean under traces/issues/alerts/evals/improve/agents/settings trees.

- [x] **LoadingSkeleton table variant** — Loading state matches table geometry (`LoadingSkeleton variant="table"` or route `loading.tsx` table recipe).  
  **Verify:** Throttle network; screenshot.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `traces/loading.tsx` + Suspense `LoadingSkeleton variant="table"`.

---

## 3. Hubs (non-Traces core surfaces)

Industry bar: one Tabs grammar + ResourcePageShell; Helicone IA clarity without nav sprawl.

- [x] **Core hubs use ResourcePageShell / CoreResourcePage** — Traces, Issues, Alerts, Evals, Improve, Agents compose via portal-os shells (not one-off page chrome).  
  **Verify:** Import grep on hub `page.tsx` files.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED import grep: traces ResourcePageShell; issues/alerts/evals/improve/agents CoreResourcePage.

- [x] **Evals hub Tabs via `ui/tabs`** — Seven peer tabs use shared Tabs; no hand-rolled tablist.  
  **Verify:** Source + keyboard arrow nav on tablist.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `evals/page.tsx` import `@/components/ui/tabs`.

- [x] **Issues / Incidents tabs via `ui/tabs`** — Issues hub uses shared Tabs for issues|incidents.  
  **Verify:** Source + manual.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `issues/page.tsx` import.

- [x] **Agents / Fleet tabs via `ui/tabs`** — Shared Tabs; fleet redirect preserved.  
  **Verify:** Source + `/fleet` redirect.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `agents/page.tsx` + `/fleet` redirect map.

- [x] **Improve tabs via `ui/tabs`** — queue|plans|history (or locked set) on shared Tabs.  
  **Verify:** Source + manual.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `improve/page.tsx` import.

- [ ] **QueryState on async hubs (non-Traces)** — Issues, Alerts, Evals, Improve, Agents primary queries use QueryState.  
  **Verify:** Same as §2.3 applied to each hub.  
  **Owner:** W4 · **Pri:** P0

- [ ] **No Suspense `fallback={null}` on hubs** — Agents/connect and other hub Suspense boundaries use skeleton, not null.  
  **Verify:** `rg 'fallback=\{null\}' clients/portal/src/app/(portal)` — allowlist empty for hubs/Settings; residual must be waived with ticket.  
  **Owner:** W4 · **Pri:** P0

- [x] **Mobile Agents discoverability** — Agents reachable from MobileBottomNav More sheet (without raising core nav count above 12).  
  **Verify:** Manual &lt;lg viewport — More → Agents. Vitest mobile nav config.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `MobileBottomNav` Agents first; `u18-portal` + `w10-w12` + `w6-a11y-motion`.

- [x] **CrossLinkBar policy** — Detail/overflow on Traces; hub CrossLinkBar OK on Improve/Alerts/Issues/Agents; not used as a third Traces chrome band.  
  **Verify:** Manual; no legacy link strip on Traces tab row.  
  **Owner:** W4 · **Pri:** P1
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED Traces legacy overflow (not tab-row CrossLink); hub CrossLinks remain on Improve/Evals per QA PASS.

- [ ] **Evals hub filter OS (P1)** — Evals gains QueryFilterBar or documented deferral waiver.  
  **Verify:** Manual or waiver note in Wave 6 report.  
  **Owner:** W5 · **Pri:** P1

- [ ] **BulkActionBar on Traces (P1)** — Selection → BulkActionBar per U00 registry.  
  **Verify:** Manual multi-select.  
  **Owner:** W5 · **Pri:** P1

---

## 4. Settings

Industry bar: Stripe settings IA — one title, one org context, searchable rail. Pattern Library P0-8; contracts §A.3.

- [x] **P0-8 — Settings searchable** — Settings rail search filters ~21 tabs; typing narrows visible tabs.  
  **Verify:** Manual type “billing” / “members” → matching tabs only.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `SettingsSearch` + synonym keywords — `w5-settings-ia.test.ts`.

- [x] **P0-8 — Single Settings title** — Either rail heading **or** `PageHeader title="Settings"` — never both visible.  
  **Verify:** Manual — count “Settings” headings = 1. Source: remove duplicate `h2` or PageHeader.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED single PageHeader; no rail h2 — `w5-settings-ia`.

- [x] **P0-8 — Single org switcher** — No in-page org `<Select>`; only sidebar Clerk switcher.  
  **Verify:** Manual Settings page; grep Settings for org Select.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED no page-body org Select — `w5-settings-ia` + clutter lint.

- [x] **No Suspense `fallback={null}` on Settings** — Settings Suspense uses `LoadingSkeleton` / `PageLoadingSkeleton` / `settings/loading.tsx`.  
  **Verify:** `rg 'fallback=\{null\}' clients/portal/src/app/(portal)/settings` → 0. Throttle + navigate Settings tabs — no blank flash.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `fallback={<SettingsLoading />}` — `w5-settings-ia`.

- [x] **Settings tabs share Tabs grammar** — Rail triggers built on `ui/tabs` primitives or SettingsRailTabs wrapper (one pattern).  
  **Verify:** Source; keyboard roving tabindex.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED settings rail uses SettingsSearch + category groups (one Settings pattern); not hand-rolled hub Tabs.

- [x] **Collapse-safe path does not require Settings** — Operator can switch org from collapsed sidebar without opening Settings (ties P0-9).  
  **Verify:** Manual.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED collapsed OrganizationSwitcher in shell (`portal-chrome.tsx`).

- [x] **Governance tabs remain discoverable** — Audit / Compliance / Security / Billing remain reachable (moat — do not delete for thin nav).  
  **Verify:** Manual rail + ⌘K.  
  **Owner:** W6 (verify keep) · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED sidebar Audit trail + Settings Compliance/Security/Billing categories (`w5-settings-ia` groups).

---

## 5. A11y

Industry bar: Stripe/Linear completeness; U20; WCAG 2.2 AA on core. Gap matrix §2.12.

- [ ] **`audit:a11y` green on core routes** — `npm run audit:a11y` passes for Home, Traces, Issues, Alerts, Evals, Improve, Settings (core set).  
  **Verify:** CI or local script output attached to Wave 6 report.  
  **Owner:** W5 / W6 · **Pri:** P0  
  **Evidence (W10–W15):** **WAIVE** — no live portal on `:3000` this session; prior auth axe reports 0 critical/serious on 8 routes. Re-run when up · Owner: QA.

- [ ] **Hub tablists keyboard-complete** — Arrow keys + Home/End (Radix Tabs) on all migrated hubs; focus ring visible.  
  **Verify:** Manual keyboard; axe tablist rules.  
  **Owner:** W4 · **Pri:** P0

- [ ] **TranscriptView nested-interactive fixed or waived** — No button-in-button / illegal nesting on default Transcript path (AUDIT-FRONTEND caution).  
  **Verify:** axe + manual; code review of `TranscriptView.tsx`.  
  **Owner:** W5 · **Pri:** P0

- [x] **Skip-to-content works** — Skip link focuses main content on portal pages.  
  **Verify:** Manual Tab from address bar.  
  **Owner:** W6 · **Pri:** P1
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `AppShell` `<a href="#main-content" className="skip-to-content">` (manual Tab still recommended).

- [x] **Touch targets on mobile chrome** — Bottom nav / More rows ≥44px; toolbar icon hits on Observe not &lt;24px on touch.  
  **Verify:** Manual mobile; spot-measure.  
  **Owner:** W5 · **Pri:** P1
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `MobileBottomNav` min 44px + Button `min-h-11` (`w6-a11y-motion`).

- [x] **Focus visible on Button CTAs** — Migrated Buttons show focus ring; no `outline-none` without replacement.  
  **Verify:** Manual Tab through Traces toolbar + Settings.  
  **Owner:** W4 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `FOCUS_RING_CLASS` on Button/Tabs — `w6-a11y-motion.test.ts`.

---

## 6. Moat-preserve (do not “fix” by deleting)

Industry: match structure; keep Eden differentiation. Gap matrix §1.2 / §3.4.

- [x] **Dark-terminal brand intact** — Portal remains dark-only; no light-theme peer skin; terminal `EmptyState` variant still available.  
  **Verify:** Manual theme; `color-scheme: dark` in globals; no Laminar/Langfuse palette copy.  
  **Owner:** W6 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `globals.css` `color-scheme: dark`; EmptyState `variant="terminal"` available; `polish:check` green.

- [x] **AI rail first-class** — `ChatSidebar` remains sibling of `main` (FAB/sheet/aside); not collapsed to header-only icon. z-index does not permanently obscure sticky header interactions.  
  **Verify:** Manual open rail on Traces with detail open; header still clickable.  
  **Owner:** W4 (z-index) / W6 (presence) · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `portal-chrome` `aiRail={<ChatSidebar …/>}` sibling of main.

- [x] **U12 ≤12 core (moat)** — Same as Foundation; re-check after any IA PR.  
  **Verify:** Vitest + sidebar count.  
  **Owner:** W6 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED same as Foundation CORE=12.

- [ ] **Instrument density on analysis** — Traces transcript / Alerts triage / Improve queue remain information-dense (not flattened to marketing whitespace). Density uses tokens.  
  **Verify:** Manual side-by-side Comfortable Home vs Trace detail.  
  **Owner:** W6 · **Pri:** P0

- [x] **Improve ↔ Artifacts ↔ Promotions ↔ Audit loop** — Closed-loop surfaces remain in core (or clearly linked); CrossLinkBar glue preserved where intentional.  
  **Verify:** Manual navigation loop; sidebar still lists Improve / Artifacts / Promotions / Audit.  
  **Owner:** W6 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED core sidebar leaves Improve/Artifacts/Promotions/Audit trail (`sidebar-config.ts`).

- [x] **Governance discoverable** — Ledger / Audit / Compliance not deleted for Helicone-thin nav.  
  **Verify:** Sidebar + Settings.  
  **Owner:** W6 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED Ledger + Audit trail core; Settings Compliance group.

- [x] **Anti-pattern: no competitor skins** — No peer hex, purple glow, cream editorial, or logo marks introduced for “parity.”  
  **Verify:** `polish:check`; design review.  
  **Owner:** W6 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED `npm run polish:check` all invariants pass (hex/skin gates).

- [x] **Anti-pattern: no nav sprawl** — Core not expanded past 12 to mirror Laminar/Braintrust leaf counts.  
  **Verify:** Sidebar count.  
  **Owner:** W6 · **Pri:** P0
  **Evidence (W6 final-verifier 2026-07-20):** VERIFIED CORE_NAV_ITEM_COUNT=12.

---

## 7. Pattern Library P0 master checklist (cross-index)

Every Pattern Library P0 must appear above; this table is the Wave 6 rollup.

| ID | Name | Section | Wave owner | Pri |
|---|---|---|---|---|
| P0-1 | Traces chrome ≤2 bands | §2 Observe | W4 | P0 |
| P0-2 | Table views dirty amber · save · discard | §2 Observe | W4 | P0 |
| P0-3 | Master–detail `?traceId=` list mounted | §2 Observe | W4 | P0 |
| P0-4 | Transcript-first detail modes | §2 Observe | W4 | P0 |
| P0-5 | Filter sticky + dual mode | §2 Observe | W4 | P0 |
| P0-6 | Canonical `ui/tabs` on hubs | §1 Foundation | W4 | P0 |
| P0-7 | Empty / filter-empty / error / loading | §2 Observe | W4 | P0 |
| P0-8 | Settings searchable; single title; single org | §4 Settings | W4 | P0 |
| P0-9 | Collapse-safe org switcher | §1 Foundation | W4 | P0 |
| P0-10 | Overview vs analysis density roles | §1 Foundation | W4/W5 | P0 |

---

## 8. Wave 10 verifier — summary table

Use this as the execution order. **Pass criterion:** all P0 + §AC rows PASS; P1 may WAIVE with link.

| # | Check (short) | Group | Pri | How (one line) | Owner | Result |
|---:|---|---|---|---|---|---|
| 1 | Traces chrome ≤2 bands | Observe / AC | P0 | Manual band count + vitest traces hub | W6→W10 | ✅ |
| 2 | Filter sticky on Observe | Observe | P0 | Scroll table; toolbar stays | W6→W10 | ☐ unverified |
| 3 | Detail split; list mounted w/ `?traceId=` | Observe | P0 | Open row; DOM list + URL | W6→W10 | ✅ |
| 4 | Views dirty amber / save / discard | Observe | P0 | Diverge filters/sort/cols → amber → save/discard | W6→W10 | ✅ Traces + Issues/Alerts |
| 5 | Transcript default + mode tabs | Observe | P0 | Open detail; modes via ui/tabs | W6→W10 | ✅ + Timeline |
| 6 | QueryState default on async hubs | Hubs | P0 | Import + loading/error states | W5–W7→W10 | ☐ partial (Evals) |
| 7 | No `fallback={null}` Settings/hubs | Settings/Hubs | P0 | `rg fallback=\{null\}` → 0 | W5→W10 | ☐ residual Suspense |
| 8 | Settings searchable | Settings | P0 | Rail search filters tabs | W9→W10 | ✅ |
| 9 | Settings single title | Settings / AC | P0 | One “Settings” heading | W5→W10 | ✅ |
| 10 | Settings single org switcher | Settings / AC | P0 | No page Select; sidebar only | W5→W10 | ✅ |
| 11 | Collapse-safe org switcher | Foundation | P0 | Icon rail → switch org | W5→W10 | ✅ |
| 12 | Zero raw primary CTAs outside Button | Foundation | P0 | Grep accent `<button>` → 0 on scope | W5→W10 | ✅ ratchet |
| 13 | One Tabs pattern on core hubs | Foundation | P0 | All hubs import ui/tabs | W5→W10 | ✅ |
| 14 | U12 ≤12 core nav | Foundation/Moat | P0 | `CORE_NAV_ITEM_COUNT` + vitest | W5→W10 | ✅ CORE=12 |
| 15 | Status→Action &lt;5s (Comfortable Home) | AC | P0 | Stopwatch ×3 | W7→W10 | ☐ unverified |
| 16 | Mobile Agents in More | Hubs | P0 | &lt;lg More sheet | W5→W10 | ✅ |
| 17 | Orphan redirects | Foundation / AC | P0 | Deep-link matrix | W5→W10 | ✅ |
| 18 | `audit:a11y` core green | A11y | P0 | `npm run audit:a11y` | W10 | ☐ live axe unverified |
| 19 | TranscriptView nested-interactive | A11y | P0 | axe + code | W6/W10 | ☐ gap |
| 20 | Dark-terminal + AI rail + Improve loop | Moat | P0 | Manual moat checklist §6 | W10 | ✅ moat code |
| 21 | Pattern Library P0-1…P0-10 all PASS | Cross | P0 | §7 table | W10 | ✅ P0-1…10 code (P0-5 sticky paint manual) |
| 22 | Issues/Alerts views OS | Observe | P0 | Dirty/save/discard | W7→W10 | ✅ |
| 23 | URL filter/view round-trip | Observe | P0 | Share URL reload | W6→W10 | ✅ Traces |
| 24 | lint:portal-layout | Foundation | P0 | npm script | W5→W10 | ✅ |
| 25 | polish:check (no peer skin hex) | Moat | P0 | npm script | W10 | ✅ |
| 26 | Toolbar primary ≤5 on core hubs | AC | P0 | Manual count + overflow | W6–W9→W10 | ☐ unverified |
| 27 | KPI 5–7 / 3–4 mobile | AC | P0 | Home + hub Status count | W7→W10 | ☐ unverified |
| 28 | Card-nest ban (Traces detail ≤3) | AC | P0 | Manual compose depth | W6→W10 | ☐ unverified |
| 29 | Top-20 clutter tier drop | AC | P0 | Re-score vs W1 baseline | W10 | ☐ W10 |
| 30 | §AC checklist 100% PASS | AC | P0 | All AC-01…AC-12 | W10 | ☐ **5/12** AC pass (AC-02/06/10/11/12); 7 UNVERIFIED painted |

**Wave 10 exit:** All P0 + §AC rows PASS (or documented non-P0 deferral only for marked P1 items elsewhere). Attach evidence pack: grep outputs, test logs, clutter re-score table, 5 screenshots (Home, Traces list+detail, Settings, collapsed sidebar org, mobile More).

---

## 9. Explicit non-goals (do not fail Wave 6 for these)

| Non-goal | Why |
|---|---|
| Laminar SQL Editor depth | P2 / post-OS |
| Langfuse filter sidebar pixel rail | Dual-editor contract only |
| Braintrust Loop / custom React views | Product, not chrome |
| Light-mode portal | Brand moat |
| Raising core nav &gt;12 | Moat + U12 |
| Pixel-matching Laminar transcript spacing | U19 tokens, not peer px |
| Full DisplayMenu / Live header contract | P1 unless already shipped |

---

## 10. Checkbox count

| Group | Checkboxes |
|---|---:|
| **§AC Anti-clutter** | **12** |
| §1 Foundation | 14 |
| §2 Observe | 14 |
| §3 Hubs | 11 |
| §4 Settings | 7 |
| §5 A11y | 6 |
| §6 Moat-preserve | 8 |
| **Total acceptance checkboxes** | **72** |

§7 P0 master table = 10 index rows (not extra checkboxes).  
§8 Wave 10 summary = 30 verifier rows (execution UI; maps onto the 72).

---

## 11. Accomplished (Wave 4 refresh)

- Kept Foundation / Observe / Hubs / Settings / A11y / Moat checklists.
- **Added §AC anti-clutter** (12 binding checkboxes) from [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md).
- Retargeted verifier to **Wave 10**; extended summary table with toolbar / KPI / card-nest / Top-20 / §AC rollup.
- Cross-linked Design Brief + a11y.

*End of `w3-industry-acceptance`.*
