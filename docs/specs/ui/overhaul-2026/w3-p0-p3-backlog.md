# Wave 3/4 — P0–P3 UX Backlog (`w4-backlog`)

**Date:** 2026-07-20  
**Agent:** `w4-backlog` (refresh of `w3-ux-audit-p0`)  
**Status:** Specs only — no product UI edits · **Approved-ready for Waves 5–10**  
**Inputs:** [`w1-consolidated-inventory.md`](./w1-consolidated-inventory.md) · [`w2-competitor-pattern-library.md`](./w2-competitor-pattern-library.md) · [`w2-gap-matrix.md`](./w2-gap-matrix.md) · [`w2-laminar-contracts.md`](./w2-laminar-contracts.md) · [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md)  
**Companion contracts:** U00 / U01 / U12 / U18 / U19 / U20 · Design Brief

**Rule:** Severity folds Wave 1–2 gaps with industry bars + **anti-clutter hard caps**. Clone patterns, not skins. Keep U12 ≤12 core + Eden moat. **Every Top-20 clutter hotspot has a P0** (§2.5).
---

## 1. Severity definitions

| Sev | Meaning | Ship rule |
|---|---|---|
| **P0** | Operators cannot work at Laminar/Braintrust Observe speed, **or** chrome is actively misleading (triple bands, double Settings, blank Suspense, dual org). Blocks Wave 4 OS exit. | Fix before / as first Wave 4 slices |
| **P1** | Unlocks evals / improve / settings / mobile quality after OS primitives land. Industry parity that is not chrome-blocking. | Wave 4 late → Wave 5 |
| **P2** | Consistency, scanability, token hygiene — debt that does not block Observe OS. | Wave 5–6 |
| **P3** | Niche peer features, leaf polish, optional delight. Explicit non-goals for early waves. | Wave 6+ / backlog |

**ID scheme:** `UX-{P0|P1|P2|P3}-{nn}` ranked within severity (lower `nn` = higher urgency).

---

## 2. Ranked backlog

### 2.1 P0

| ID | Sev | Title | Problem (W1) | Industry bar (W2) | Primary paths | Owner | Acceptance hint |
|---|---|---|---|---|---|---|---|
| **UX-P0-01** | P0 | Collapse Traces triple chrome | Hub = **3 bands**: `PageHeader` + hand-rolled tabs/legacy links + facet chips/`QueryFilterBar` ([w1 §7.1](./w1-consolidated-inventory.md), [w1-hub-surfaces §2](./w1-hub-surfaces.md) `:443-595`) | **P0-1** Laminar one Observe toolbar; gap matrix §2.3 / §3.1#1 | `clients/portal/src/app/(portal)/traces/page.tsx` · `traces/layout.tsx` · `traces/_components/SpanSearchBar.tsx` · `traces/_components/LiveTailPanel.tsx` · `components/portal-os/ResourcePageShell.tsx` · `components/portal-os/QueryFilterBar.tsx` | **w4-traces-chrome** | Identity + **one** toolbar band only; facets inside filters (`?facet=`); legacy Inspector/Replay/Debugger/Time-Travel/Query → overflow/`CrossLinkBar` — see [w2-laminar-contracts §B](./w2-laminar-contracts.md) |
| **UX-P0-02** | P0 | Settings single identity + single org | Rail `<h2>Settings</h2>` + `PageHeader title="Settings"`; Clerk switcher **and** in-page `<Select>` org ([w1 §7.2](./w1-consolidated-inventory.md), [w1-chrome-mapper](./w1-chrome-mapper.md) A/B) | **P0-8** Stripe/Laminar one title · org in shell only; gap §2.8 | `clients/portal/src/app/(portal)/settings/page.tsx` (`:406`, `:422-462`) · `clients/portal/src/app/(portal)/portal-chrome.tsx` (`:671-684`) | **w4-settings-shell** | Exactly one “Settings” title; zero page-body org Select; org only in sidebar |
| **UX-P0-03** | P0 | Collapse-safe org switcher | `OrganizationSwitcher` rendered only when `!collapsed` — vanishes in icon rail ([w1-chrome-mapper](./w1-chrome-mapper.md) overload #3) | **P0-9** Laminar collapsed monogram picker stays clickable; gap §3.1#4b | `clients/portal/src/app/(portal)/portal-chrome.tsx` (`:671-684`, widths `:78-79`) · `components/portal-os/AppShell.tsx` | **w4-shell-org** | Collapsed (64px) rail still opens org context without Settings detour |
| **UX-P0-04** | P0 | Ban Suspense `fallback={null}` on settings/hubs | **7** hits; Settings/connect/replay blank-flash ([w1 §8](./w1-consolidated-inventory.md), [w1-states-loading §4A](./w1-states-loading.md)) | **P0-7** Linear/Stripe never flash null; Pattern anti-pattern “Blank Suspense” | `settings/page.tsx` (`:519`) · `settings/(tabs)/gateway/page.tsx` (`:52`) · `agents/connect/page.tsx` (`:137`) · `replay/page.tsx` (`:730`) · `portal-chrome.tsx` (`:1046` overlay — keep intentional) · `observability/_components/SelectedTraceCard.tsx` (`:36` — keep intentional) | **w4-states** | Prod `fallback={null}` only on intentional overlays; Settings uses `LoadingSkeleton` / `settings/loading.tsx` shape |
| **UX-P0-05** | P0 | Hub Tabs → `@/components/ui/tabs` | **0/8 hubs** import `ui/tabs`; all hand-roll `role="tablist"` ([w1 §4.2](./w1-consolidated-inventory.md), [w1-hub-surfaces](./w1-hub-surfaces.md)) | **P0-6** one control grammar; gap §2.13 / §2.9 | `components/ui/tabs.tsx` · hubs: `traces/page.tsx` · `agents/page.tsx` · `evals/page.tsx` · `improve/page.tsx` · `issues/page.tsx` · `alerts/page.tsx` · `settings/page.tsx` (rail) · `optimization/page.tsx` | **w4-primitives-tabs** | Traces → Issues → Evals → Settings rail use `Tabs`/`TabsList`/`TabsTrigger` (`variant="underline"`); no new hand-rolled tablists |
| **UX-P0-06** | P0 | CTA drift — raw accent `<button>` | ~**53** raw accent button fragments (tools, time-travel, replay, settings tabs, QueryFilterBar…) ([w1 §0 / §4.2](./w1-consolidated-inventory.md)); density top CTA files: studio×6, OnboardingConnectFlow×6 ([w1-density-grep](./w1-density-grep.md)) | **P0** Linear/Stripe `Button` microstates; Pattern anti-pattern “Hand-rolled accent button”; gap §2.13 | `components/ui/button.tsx` · `studio/page.tsx` · `replay/page.tsx` · `observability/time-travel/page.tsx` · `tools/page.tsx` · `portal-os/QueryFilterBar.tsx` · `settings/page.tsx` + `settings/_components/*-tab.tsx` · `agents/connect` / onboarding connect flow | **w4-primitives-button** | Touched surfaces use `Button`; lint/ban new `bg-[var(--accent)]` on raw `<button>` |
| **UX-P0-07** | P0 | Master–detail without navigate-away | `DetailPanelShell` + `TraceDetailPanel` exist; U01/U18 still warn navigate-away; chrome overload fights pattern ([w1 §7 / foreshadow](./w1-consolidated-inventory.md)) | **P0-3** Laminar/Braintrust/Helicone split/drawer; contracts §B.4 | `traces/page.tsx` · `components/portal-os/DetailPanelShell.tsx` · `components/observability/TraceDetailPanel.tsx` · `components/portal-os/CoreResourcePage.tsx` | **w4-traces-detail** | Row open sets `?traceId=`; list stays mounted ≥1280 split / 768–1279 drawer; deep links redirect into hub |
| **UX-P0-08** | P0 | Transcript-first detail modes + density #1 | `TranscriptView` density hotspot #1 (`text-[10px]`×21, score 84); Tree/Timeline/Metadata not one toolbar contract ([w1 §6](./w1-consolidated-inventory.md)) | **P0-4** Laminar Transcript·Tree·Timeline·Metadata; **P0-10** Datadog analysis density OK with tokens | `components/observability/TranscriptView.tsx` · `TraceDetailPanel.tsx` · `DetailPanelShell.tsx` | **w4-transcript** → **w5-density** | Default mode = Transcript; mode switch via `ui/tabs`; replace arbitrary `text-[10px]` with `--font-size-2xs/3xs` — do not copy Laminar px |
| **UX-P0-09** | P0 | Filter OS: facets into QueryFilterBar | Facet chips are a **third band**; `QueryFilterBar` basic\|query under overload ([w1-hub-surfaces §2](./w1-hub-surfaces.md)) | **P0-5** Langfuse dual editor + Laminar search; gap §2.5 | `portal-os/QueryFilterBar.tsx` · `traces/page.tsx` · `portal-os/useResourceUrlState` (or equiv) · facet leaves under `observability/*` | **w4-filter-os** | Facets = filter chips / `?facet=` inside toolbar; no sibling facet band; URL round-trip |
| **UX-P0-10** | P0 | Table views OS (dirty · save · discard) | `ViewsMenu` + `useSavedViews` partial; columns/sort/density not Laminar-complete; uneven hub adoption ([w1 §4](./w1-consolidated-inventory.md), specs U00/U08) | **P0-2** Laminar table-views amber dirty; Braintrust defaults; contracts §C | `portal-os/ViewsMenu.tsx` · `portal-os/ViewsMenuTrigger` · `useSavedViews` · `InfiniteDataTable.tsx` · `ResourceOsToolbar.tsx` · `traces/page.tsx` | **w4-table-os** | Dirty when filters **or** sort **or** columns diverge; scoped views per traces\|spans\|sessions; Save / Save as / Discard |
| **UX-P0-11** | P0 | QueryState as default async wrapper | QueryState ~**22** refs vs EmptyState ~168 / ErrorState ~393; hubs hand-roll loading/error/empty ([w1 §8](./w1-consolidated-inventory.md), [w1-states-loading](./w1-states-loading.md) — only 3 pages use QueryState in prod) | **P0-7** Linear skeleton→content; gap §2.6 | `components/ui/query-state.tsx` · adopt on: `traces/page.tsx` · `issues/page.tsx` · `alerts/page.tsx` · `evals/page.tsx` · `improve/page.tsx` · (today: `agents/page.tsx`, `audit-trail/page.tsx`, `settings/(tabs)/webhooks-dlq/page.tsx`) | **w4-states** | Hubs use `QueryState`; distinguish never-ingested vs filter-empty vs error+retry |
| **UX-P0-12** | P0 | Density program — overview calm / analysis tokenized | `text-[10px]`×**256**; shell + hubs micro-type; U19 MISSING as program ([w1 §5–6](./w1-consolidated-inventory.md)) | **P0-10** Datadog role density; gap §2.10 | Top files: `TranscriptView.tsx` · `components/ai-insights/ApprovalCard.tsx` · `alerts/page.tsx` · `guardrails/page.tsx` · `fleet/page.tsx` · `studio/page.tsx` · `portal-chrome.tsx` · `globals.css` (`--font-size-2xs/3xs`) | **w5-density-u19** | Top-10 density files off arbitrary px; shell/Home calm; analysis stays dense via tokens |
| **UX-P0-13** | P0 | Orphan / dual route redirect map | `/observability/*`, `/fleet`, `/signals`, `/incidents`, evals leaves dual with hubs; U18 redirect map incomplete ([w1 §1.4](./w1-consolidated-inventory.md)) | Gap §2.2 must-match; Helicone single hub URLs; contracts §B.1 redirects | `lib/sidebar-config.ts` · `lib/portal-routes.ts` (if present) · `fleet/page.tsx` · `signals/page.tsx` · `incidents/page.tsx` · `observability/page.tsx` · embeds in `traces/page.tsx` / `evals/page.tsx` / `alerts/page.tsx` / `issues/page.tsx` / `agents/page.tsx` | **w4-ia-redirects** | Canonical hub URLs; standalone routes redirect or embed-only; document U12 leaf decision without exceeding 12 |
| **UX-P0-14** | P0 | Mobile Agents discoverability | Agents = Advanced-only; **absent** from `MOBILE_MORE_LINKS` ([w1-mobile-shell](./w1-mobile-shell.md), [w1 §9](./w1-consolidated-inventory.md)) | Gap §2.11 / §3.1#9; Pattern **P2-6** elevated to P0 by gap matrix must-match | `components/portal-os/MobileBottomNav.tsx` (`MOBILE_CORE_NAV`, `MOBILE_MORE_LINKS`) · `lib/sidebar-config.ts` · `u18-portal` tests | **w4-mobile-ia** | Agents reachable from More (or promoted path) **without** raising core count above 12 |
| **UX-P0-15** | P0 | Core a11y + Tabs keyboard | U20 MISSING as program; TranscriptView nested-interactive (AUDIT H2); hand-rolled tablists ([w1 §10–11](./w1-consolidated-inventory.md), [w1-specs-gap](./w1-specs-gap.md)) | Gap §2.12 / §3.1#10; WCAG 2.2 / Stripe-Linear completeness | `TranscriptView.tsx` · hub pages (tabs) · `npm run audit:a11y` · golden observe probe · `traces/__tests__/w3-2-traces-hub.test.ts` | **w5-a11y-u20** | Axe clean on core routes; hub tabs via Radix `ui/tabs`; nested interactive fixed on transcript path |

---

### 2.2 P1

| ID | Sev | Title | Problem (W1) | Industry bar (W2) | Primary paths | Owner | Acceptance hint |
|---|---|---|---|---|---|---|---|
| **UX-P1-01** | P1 | Improve mobile kanban | Board columns at xl/2xl; no dedicated narrow layout ([w1 §9](./w1-consolidated-inventory.md), [w1-mobile-shell](./w1-mobile-shell.md)) | Gap §2.11; Pattern P1 Improve moat keep | `app/(portal)/improve/page.tsx` (`:412` columns) · Improve related `improve/plans`, `improve/runs` | **w5-improve-mobile** | &lt;lg = list/stack; touch ≥44px on queue actions |
| **UX-P1-02** | P1 | Spacing token scale | Only `--space-2/3/4`; `py-0.5`×148; tokens not in `@theme` ([w1 §5](./w1-consolidated-inventory.md)) | Gap §2.10 P1; Design-system 4/8 grid | `app/globals.css` · consumers of arbitrary `p-1`/`gap-0.5`/`py-0.5` on chrome | **w5-tokens** | Add `--space-1`…`--space-8`; expose utilities; chrome uses tokens |
| **UX-P1-03** | P1 | PageContent adoption on hubs | Portal PageContent **52/75**; hubs often skip when using `CoreResourcePage` ([w1 §1.3](./w1-consolidated-inventory.md), [w1-route-matrix](./w1-route-matrix.md)) | Pattern §6 Page identity; CoreResourcePage wraps PageContent | Hubs **N** PageContent: `agents/page.tsx` · `alerts/page.tsx` · `artifacts/page.tsx` · `audit-trail/page.tsx` · `dashboard/page.tsx` · `datasets/page.tsx` · `evals/page.tsx` · `experiments/page.tsx` · `fleet/page.tsx` · `improve/page.tsx` · `issues/page.tsx` · `ledger/page.tsx` · `playgrounds/page.tsx` · `promotions/page.tsx` · + leaves `agents/[id]/book`, settings gateway/sidebar/status | **w5-page-stack** | Document: CoreResourcePage **owns** padding → OK without outer PageContent; standalone leaves adopt PageContent; kill snowflake padding |
| **UX-P1-04** | P1 | Display menu (columns · density · row type) | Global `DensityProvider` only; no hub Display menu; column persist incomplete | Pattern **P1-1** Braintrust Display / Laminar columns | `InfiniteDataTable.tsx` · future `DisplayMenu` · `DensityProvider` · Traces/Issues/Alerts | **w5-display-menu** | Per-table column picker + optional density override on Observe |
| **UX-P1-05** | P1 | Live tail as Observe header control | `LiveTailPanel` exists; not U00/U01 Live ▾ contract | Pattern **P1-2** | `traces/_components/LiveTailPanel.tsx` · `traces/page.tsx` header actions | **w5-live-tail** | Live control in identity/toolbar; SSE only when supported |
| **UX-P1-06** | P1 | CrossLink overflow (not hub bands) | Traces legacy on tab row; hub CrossLinkBar missing; Evals has none ([w1-hub-surfaces](./w1-hub-surfaces.md)) | Pattern **P1-5** | `CrossLinkBar.tsx` · `traces/page.tsx` · `evals/page.tsx` · `TraceDetailPanel.tsx` | **w4-traces-chrome** / **w5-evals** | Legacy tools off tab row; Evals gains Observe/Improve links |
| **UX-P1-07** | P1 | Bulk action registry on Traces | `BulkActionBar` on Alerts/Issues; Traces incomplete vs U00 | Pattern **P1-4** | `BulkActionBar.tsx` · `traces/page.tsx` · Issues/Alerts reference | **w5-bulk** | Selection → dataset/playground/export/issue per U00 registry |
| **UX-P1-08** | P1 | Evals hub OS polish | 7 peer tabs; no hub FilterBar; dual standalone routes ([w1 §7.1](./w1-consolidated-inventory.md)) | Pattern **P1-6**; keep mega-hub for ≤12 | `evals/page.tsx` · leaf embeds `datasets`/`playgrounds`/`experiments`/`studio`/`synthetic`/`labeling` | **w5-evals** | `ui/tabs` + optional ResourceOsToolbar; no core-nav explosion |
| **UX-P1-09** | P1 | Chat-with-trace span citations | Global `ChatSidebar`; not span-chip jump in detail | Pattern **P1-3** | `ChatSidebar.tsx` · `portal-chrome.tsx` AI rail · `DetailPanelShell` | **w5-ai-rail** | With `?traceId=`, citations select span in detail |
| **UX-P1-10** | P1 | Dual Skeleton recipes | `LoadingSkeleton` 176 / `<Skeleton` 152; fleet `loading.tsx` re-exports page ([w1-states-loading](./w1-states-loading.md)) | Gap §2.6 PARTIAL | `components/ui/skeleton.tsx` · `fleet/loading.tsx` · `settings/(tabs)/status` (missing loading) · `onboarding/improvement-loop` | **w5-loading** | One route recipe; fix fleet anti-pattern; status tab gets `loading.tsx` |
| **UX-P1-11** | P1 | Table mobile card/list fallback | Sticky first col optional; many surfaces horizontal-scroll only ([w1-mobile-shell](./w1-mobile-shell.md)) | Gap §2.11 | `components/ui/data-table.tsx` · `SpansTab.tsx` · fleet/runs/cohorts surfaces | **w5-mobile-tables** | &lt;lg card/list fallback or sticky primary col on core tables |
| **UX-P1-12** | P1 | ⌘K action completeness | Palette present; action coverage vs sidebar incomplete ([w1-chrome-mapper](./w1-chrome-mapper.md)) | Gap §2.1 P1 | `components/ui/command-palette.tsx` · `lib/nav-commands` · `sidebar-config.ts` | **w5-cmdk** | Indexes core + Advanced + primary actions |
| **UX-P1-13** | P1 | Settings tab grouping | ~21 rail tabs; heavy IA ([w1 §7.2](./w1-consolidated-inventory.md)) | Gap §2.8 P1 Stripe grouped sections | `settings/page.tsx` · `settings/_components/*` | **w5-settings-ia** | Group/collapse Org · Members · Security · Compliance · Billing · Advanced |
| **UX-P1-14** | P1 | Group id ≠ label cleanup | `build`→Home, `automate`→Evaluate, `optimize`→Improve ([w1 §3.1](./w1-consolidated-inventory.md)) | Gap §2.2 PARTIAL | `lib/sidebar-config.ts` · breadcrumb `GROUP_LABEL` maps | **w6-ia-hygiene** | Ids match IA language **or** documented map + no code confusion |
| **UX-P1-15** | P1 | Remaining density hotspots (non-top-10) | ChatSidebar Composer/MessageList/ToolCallCard; SpanSearchBar; ParallelToolLane; improve/page ([w1 §6](./w1-consolidated-inventory.md)) | P0-10 follow-through | Listed components under `components/` + `improve/page.tsx` | **w5-density-u19** | Same token pass as UX-P0-12 wave 2 |

---

### 2.3 P2

| ID | Sev | Title | Problem (W1) | Industry bar (W2) | Primary paths | Owner | Acceptance hint |
|---|---|---|---|---|---|---|---|
| **UX-P2-01** | P2 | Icon collisions | `PatchIcon`×3, `FileText`×3, `TraceIcon`×2, `AlertNavIcon`×2, `Settings`×2 ([w1 §3.3](./w1-consolidated-inventory.md)) | Gap §2.2 P2; Linear unique icons | `lib/sidebar-config.ts` · icon components under `components/` | **w6-icons** | Unique icon per core leaf |
| **UX-P2-02** | P2 | Resource shell universalize | Resource shells on **18** pages only ([w1 §1.3](./w1-consolidated-inventory.md)) | Pattern §6 / anti-pattern page-by-page clones | Leaves still custom: tools, users, guardrails, observability/*, insights | **w6-shell-adoption** | Advanced/list leaves on `CoreResourcePage` where table+detail fits |
| **UX-P2-03** | P2 | Filter undo/redo + suggestions | Missing productized undo; Suggestions/Recent uneven | Pattern P1 partial → P2; gap §2.5 | `QueryFilterBar.tsx` · ViewsMenu | **w6-filter-power** | Observe: Suggestions/Recent; undo if cheap |
| **UX-P2-04** | P2 | Default-view hierarchy | Personal→project→org incomplete | Pattern **P2-3** Braintrust | `useSavedViews` · savedViews API | **w6-views-defaults** | Load order per contracts §C.5 |
| **UX-P2-05** | P2 | SQL / query deep-link from trace | Observability query leaf exists; not overflow action | Pattern **P2-2** | `observability/query/page.tsx` · Trace detail overflow | **w6-sql-escape** | Overflow “Open in Query” with prefill — not chrome band |
| **UX-P2-06** | P2 | Sessions analytics table polish | Sessions hub tab exists | Pattern **P2-5** | `traces` SessionsTab · `InfiniteDataTable` | **w6-sessions** | Sessions view uses full table OS |
| **UX-P2-07** | P2 | KPI strips / banner polish | Inconsistent hub KPI; banners already strong | Gap §2.1/§2.7 P2 | `alerts/page.tsx` severity strip · `portal-chrome.tsx` banners | **w6-chrome-polish** | Optional thin KPI; no new Traces bands |
| **UX-P2-08** | P2 | AI rail z-index vs sticky header | Both `z-30` band ([w1-chrome-mapper](./w1-chrome-mapper.md), gap §2.1) | Moat keep AI rail; fix collision | `portal-chrome.tsx` · `AppShell.tsx` · `ChatSidebar.tsx` | **w5-ai-rail** | Layering documented; no cover fights |
| **UX-P2-09** | P2 | CrossLinkBar policy doc + remaining hubs | Present Agents/Improve/Alerts/Issues; absent Traces hub/Evals | Moat glue (gap §1.2) | `CrossLinkBar.tsx` + hub pages | **w6-crosslinks** | Written policy: hub vs detail-only |

---

### 2.4 P3

| ID | Sev | Title | Problem (W1) | Industry bar (W2) | Primary paths | Owner | Acceptance hint |
|---|---|---|---|---|---|---|---|
| **UX-P3-01** | P3 | Render templates / custom trace JSX | Spec-gap: route not found ([w1-specs-gap](./w1-specs-gap.md)) | Pattern **P2-1** — non-goal early | Future Advanced leaf | **w6+** | Out of Wave 4 chrome |
| **UX-P3-02** | P3 | Braintrust Loop / Laminar Agent product clone | N/A — product moat features | Pattern anti-patterns §4 | — | — | Do not schedule as chrome work |
| **UX-P3-03** | P3 | Light-mode portal for peer parity | Dark-only brand ([w1 §5](./w1-consolidated-inventory.md)) | Gap §1.3 non-goal | `globals.css` | — | Keep dark-terminal |
| **UX-P3-04** | P3 | Expand core nav past 12 | Leaf set ≠ locked U12; temptation to add leaves | Gap §1.3 / U12 hard cap | `sidebar-config.ts` | — | Fix via hubs/embeds/Advanced only |
| **UX-P3-05** | P3 | Langfuse filter sidebar pixel clone | Dual-editor needed; rail layout optional | Gap §1.3 | `QueryFilterBar.tsx` | — | Match contract, not Langfuse pixels |
| **UX-P3-06** | P3 | Niche portal-os helpers audit | `DriftHistogram`, `BulkActionBar` (partial), `TableExportToolbar` concentrated ([w1 §4.3](./w1-consolidated-inventory.md)) | — | `components/portal-os/*` | **w6-deadcode** | Confirm dead vs keep; no drive-by deletes |

---

## 2.5 Top-20 clutter hotspots → P0 map (Wave 4)

**Binding:** Every W1 Top-20 overwhelm surface has a P0 before Waves 5–10. Caps: [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md). Extend `UX-P0-*` / `UX-CL-*` here only — do not fork ticket systems.

| # | Surface | Primary backlog | Wave | Acceptance |
|---:|---|---|---|---|
| 1 | Traces | **UX-P0-01**, UX-P0-09, UX-P0-07/08/10 | W5–W6 | bands ≤2; toolbar ≤5; AC-01/03/06 |
| 2 | Guardrails | **UX-CL-01** · UX-P0-12 | W9 | hub calm; micro-type tokens; bands ≤2 |
| 3 | Alerts | **UX-CL-02** · UX-P0-12 | W7 | bands ≤2 + thin KPI |
| 4 | Studio | **UX-CL-03** · UX-P0-06 | W8 | form/CTA declutter |
| 5 | Replay | **UX-CL-04** | W7 | ≤2 bands; calm leaf |
| 6 | Fleet | **UX-CL-05** · UX-P0-13 | W7 | embed; KPI cap |
| 7 | Time-Travel | **UX-CL-06** | W7 | overflow leaf |
| 8 | Settings | **UX-P0-02** · UX-P1-13 · UX-CL-07 | W5 / W9 | dual_title=N; Advanced collapsed |
| 9 | Model Advisor | **UX-CL-08** · UX-P0-13 | W9 | dual-chrome GAP closed |
| 10 | Users | **UX-CL-09** | W9 | nest declutter |
| 11 | Tools | **UX-CL-10** · UX-P0-06 | W9 | Button + PageContent |
| 12 | Memory facet | **UX-CL-11** · UX-P0-09 | W6–W7 | facet path; hide leaf chrome |
| 13 | Retrieval facet | **UX-CL-12** · UX-P0-09 | W6–W7 | same as Memory |
| 14 | Query DSL | **UX-CL-13** · UX-P0-06 | W6 / W10 | overflow escape |
| 15 | Analytics | **UX-CL-14** | W9 | KPI ≤7 |
| 16 | Insights | **UX-CL-15** | W9 | ≤2 bands |
| 17 | Prompts | **UX-CL-16** | W8–W9 | Advanced calm |
| 18 | Agents | **UX-CL-17** · UX-P0-05/14 | W7 | bands ≤2 |
| 19 | Issues | **UX-CL-18** · UX-P0-05/11 | W7 | status in toolbar |
| 20 | FinOps / Improve queue | **UX-CL-19** · UX-P1-01 | W9 | CrossLink→More; mobile list |

**Crowding TOP-5 components:** `portal-chrome` → **UX-CL-20**; `TranscriptView` → UX-P0-08/12; `ApprovalCard` → **UX-CL-21**; plus Guardrails/Alerts already in rows 2–3.

### New P0 IDs (UX-CL-01…21)

| ID | Title | Owner |
|---|---|---|
| UX-CL-01 | Guardrails declutter | w9-advanced-guard |
| UX-CL-02 | Alerts chrome collapse | w7-alerts |
| UX-CL-03 | Studio control soup | w8-studio |
| UX-CL-04 | Replay leaf calm | w7-replay-inspector |
| UX-CL-05 | Fleet embed / KPI | w7-fleet |
| UX-CL-06 | Time-Travel overflow leaf | w7-obs-deep |
| UX-CL-07 | Settings rail group/collapse | w9-settings-ia |
| UX-CL-08 | Model Advisor dual chrome | w9-advanced-cost |
| UX-CL-09 | Users nest declutter | w9-advanced-cost |
| UX-CL-10 | Tools multi-tab calm | w9-advanced-cost |
| UX-CL-11 | Memory facet nest | w6-crosslinks / w7-obs-deep |
| UX-CL-12 | Retrieval facet nest | w6-crosslinks / w7-obs-deep |
| UX-CL-13 | Query DSL leaf | w6-crosslinks |
| UX-CL-14 | Analytics KPI wall | w9-advanced-cost |
| UX-CL-15 | Insights nested tabs | w9-advanced-cost |
| UX-CL-16 | Prompts Advanced calm | w8-prompts-redteam |
| UX-CL-17 | Agents CrossLink demote | w7-agents |
| UX-CL-18 | Issues status strip fold | w7-issues |
| UX-CL-19 | Improve/FinOps chrome | w9-improve-hub |
| UX-CL-20 | portal-chrome crowding | w5-appshell |
| UX-CL-21 | ApprovalCard micro stack | w9-ai-rail |

---

## 3. Pattern Library P0 steal-list cross-ref

| Steal ID | Name | Backlog IDs | Wave hint |
|---|---|---|---|
| **P0-1** | Single Observe chrome band | **UX-P0-01**, UX-P0-09 | w4-traces-chrome |
| **P0-2** | Table views OS | **UX-P0-10** | w4-table-os |
| **P0-3** | Master–detail | **UX-P0-07** | w4-traces-detail |
| **P0-4** | Transcript-first modes | **UX-P0-08** | w4-transcript / w5-density |
| **P0-5** | Filter OS chips + query | **UX-P0-09** | w4-filter-os |
| **P0-6** | Canonical hub Tabs | **UX-P0-05** | w4-primitives-tabs |
| **P0-7** | Empty / filter-empty / error / loading | **UX-P0-04**, **UX-P0-11** | w4-states |
| **P0-8** | Settings chrome hygiene | **UX-P0-02** | w4-settings-shell |
| **P0-9** | Collapse-safe context switcher | **UX-P0-03** | w4-shell-org |
| **P0-10** | Overview vs analysis density | **UX-P0-12**, UX-P0-08 | w5-density-u19 |

Gap-matrix extras folded into P0 (not numbered in steal-list): **UX-P0-06** Button CTA, **UX-P0-13** redirects, **UX-P0-14** mobile Agents, **UX-P0-15** a11y.

---

## 4. Required coverage checklist

| Topic | Backlog ID(s) | Evidence paths |
|---|---|---|
| Traces triple chrome | UX-P0-01 | `traces/page.tsx` |
| Settings double title + dual org | UX-P0-02 | `settings/page.tsx`, `portal-chrome.tsx` |
| CTA drift (~53 raw accent) | UX-P0-06 | `studio/page.tsx`, `QueryFilterBar.tsx`, tools/replay/time-travel |
| Tabs drift (0 hubs use `ui/tabs`) | UX-P0-05 | all hub `page.tsx` + `ui/tabs.tsx` |
| Improve mobile | UX-P1-01 | `improve/page.tsx` |
| Density: TranscriptView | UX-P0-08, UX-P0-12 | `TranscriptView.tsx` |
| Density: alerts | UX-P0-12 | `alerts/page.tsx` |
| Density: portal-chrome | UX-P0-12 | `portal-chrome.tsx` |
| Density: studio | UX-P0-12, UX-P0-06 | `studio/page.tsx` |
| Suspense `fallback={null}` | UX-P0-04 | settings / connect / replay / chrome / SelectedTraceCard |
| Orphan / dual routes | UX-P0-13 | fleet, signals, incidents, observability/*, evals leaves |
| Collapse-safe org switcher | UX-P0-03 | `portal-chrome.tsx` |
| QueryState underuse | UX-P0-11 | `ui/query-state.tsx` + hubs |
| Spacing token gaps | UX-P1-02 | `globals.css` |
| Icon collisions | UX-P2-01 | `sidebar-config.ts` |
| PageContent adoption gaps | UX-P1-03 | [w1-route-matrix](./w1-route-matrix.md) N rows + CoreResourcePage hubs |

---

## 5. Counts summary

| Severity | Count | IDs |
|---|---:|---|
| **P0 (UX)** | **15** | UX-P0-01 … UX-P0-15 |
| **P0 (anti-clutter CL)** | **21** | UX-CL-01 … UX-CL-21 |
| **P1** | **15** | UX-P1-01 … UX-P1-15 |
| **P2** | **9** | UX-P2-01 … UX-P2-09 |
| **P3** | **6** | UX-P3-01 … UX-P3-06 |
| **Total** | **66** | |

---

## 6. Wave sequencing hint (for owners) — 10-wave plan

```
Wave 5 (foundation): tokens · Button/Tabs · QueryState · shell org · ResourcePageShell band≤2
                     · redirects · mobile More · clutter lint gates · UX-CL-20
Wave 6 (Observe core): UX-P0-01 Traces ≤2 · filters · views · detail · transcript · facets CL-11/12
Wave 7 (satellite+Home): Alerts/Issues/Agents/Fleet/Replay · Dashboard KPI · CL-02/04/05/17/18
Wave 8 (Evaluate): Evals hub · Studio CL-03 · prompts/redteam
Wave 9 (Improve/Settings/Advanced/AI): Settings CL-07 · Guardrails CL-01 · FinOps CL-19 · ApprovalCard CL-21
Wave 10 (verify): densify hotspots · a11y · w10-clutter-verifier Top-20 · industry+§AC PASS
Never: P3 skin/nav/light-mode / Loop clone
```

Aligns with [w2-gap-matrix §4](./w2-gap-matrix.md) WP-A→WP-H, Pattern Library §7, and [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md).

---

## 7. Moat do-not-break (while closing P0)

- Dark-terminal brand + terminal `EmptyState`
- AI rail as first-class sibling (`ChatSidebar`)
- `CORE_NAV_ITEM_COUNT === 12`
- Instrument density on analysis (tokenized, not deleted)
- Improve ↔ Artifacts ↔ Promotions ↔ Audit closed loop
- `CrossLinkBar` as glue, not third chrome band

---

*End of `w3-p0-p3-backlog`.*
