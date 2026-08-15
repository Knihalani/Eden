<!-- Wave 1 + Wave 2 refresh (`w2-ui-primitives-inv`, `w2-portal-os-inv`, `w2-obs-component-map`, `w2-card-nest-audit`). -->

# Component Inventory — Wave 1 + Wave 2 systems refresh

Scope: `clients/portal/src/components/{ui,portal-os,layout}/*` + Observe stacks + card-nest audit  
Method: export/API scan + named-import graph across `clients/portal/src` (excluding self/barrel-only).  
**Wave 2 date:** 2026-07-20 — sections §6–§9 are systems discovery (do not clobber §1–§5 tables; refresh deltas live in Wave 2 sections).

---

## 1. Inventory tables

### `ui/` (barrel: `components/ui/index.ts`)

| Export | Props / variants | Path | Barrel? |
|---|---|---|---|
| `Button`, `buttonVariants` | `variant`: default\|destructive\|outline\|ghost\|secondary\|emerald\|danger\|link; `size`: default\|sm\|lg\|icon; `asChild`, `loading` | `ui/button.tsx` | yes |
| `Input` | native input attrs | `ui/input.tsx` | yes |
| `Textarea` | native textarea attrs | `ui/textarea.tsx` | yes |
| `FormField` | `label`, `htmlFor`, `description`, `error`, `required`, `children` | `ui/form-field.tsx` | yes |
| `Checkbox` | Radix + className | `ui/checkbox.tsx` | yes |
| `Switch` | Radix + className | `ui/switch.tsx` | yes |
| `Sheet*` | `SheetContent.side`: right\|bottom\|left | `ui/sheet.tsx` | yes |
| `FOCUS_RING_CLASS`, `FOCUS_RING_VARS` | CSS token helpers | `ui/focus-ring.ts` | CLASS yes / VARS yes |
| `EmptyState` | `icon`, `title`, `description`, `action`, `terminal`; `size` sm\|md\|lg; `variant` panel\|plain\|terminal | `ui/empty-state.tsx` | yes |
| `ErrorState` | `title`, `message`, `error`, `action`; `size` sm\|md\|lg | `ui/error-state.tsx` | yes |
| `QueryState` | `loading`, `error`, `data`, `onRetry`, `isEmpty`, slots | `ui/query-state.tsx` | yes |
| `NoOrgState` | `feature`, `description`, `icon`, `syncing`, `syncTimedOut`, `onRetrySync`, `secondaryAction` | `ui/no-org-state.tsx` | yes |
| `Breadcrumb` | `items[{label,href?}]` | `ui/breadcrumb.tsx` | yes |
| `Banner` | `tone`: accent\|terminal\|warning\|info\|error\|success | `ui/banner.tsx` | yes |
| `Alert` | `variant`: error\|warning\|info\|success; `title`, `description`, `action`, `onDismiss` | `ui/alert.tsx` | yes |
| `StatCard` | `accent`: neutral\|accent\|terminal\|warning\|error\|info; `trend`, `loading`, `empty`, `href` | `ui/stat-card.tsx` | yes |
| `StatusBadge`, `IssuePriorityBadge`, `IssueWorkflowBadge` | status descriptors; severity helpers | `ui/status-badge.tsx` | partial |
| `ImprovePlanStatusBadge`, `PRStatusBadge`, `OutcomeBadge`, `TraceOutcomeBadge`, `SeverityBadge`, `SeverityIcon` | specialized badges | `ui/status-badge.tsx` | **no** (direct import) |
| `Select*` | Radix select suite | `ui/select.tsx` | yes |
| `Badge`, `badgeVariants` | many status/pipeline/color variants | `ui/badge.tsx` | yes |
| `Card*` | `variant`: default\|elevated\|inset\|interactive; `padding`: none\|sm\|md\|lg\|xl; `as` | `ui/card.tsx` | yes |
| `Section` | `title`, `description`, `actions`, `contentClassName` | `ui/section.tsx` | yes |
| `ChartCard` | `height`, `csvRows`, `showDataTable`, empty/fallback | `ui/chart-card.tsx` | yes |
| `Avatar*` | Radix avatar | `ui/avatar.tsx` | yes |
| `DropdownMenu*` | full Radix menu suite | `ui/dropdown-menu.tsx` | yes |
| `Dialog*` | Radix dialog suite | `ui/dialog.tsx` | yes |
| `Tabs*` | `TabsList`/`TabsTrigger` `variant`: default\|underline\|pills | `ui/tabs.tsx` | yes |
| `Skeleton` | className | `ui/skeleton.tsx` | yes |
| `LoadingSkeleton` | `variant`: default\|stats\|table\|detail; `lines`; `size` | `ui/skeleton.tsx` | **no** |
| `SkeletonCard`, `SkeletonTableRow`, `SkeletonListItem` | layout helpers | `ui/skeleton.tsx` | **no** |
| `ToastProvider`, `useToast` | toast API | `ui/toast.tsx` | yes |
| `Tooltip*` | Radix tooltip | `ui/tooltip.tsx` | yes |
| `Table*` + `SortableTableHead` | primitive table | `ui/table.tsx` | yes |
| `DataTable`, `DataTableSearch` | columns, sort, page, selectable, empty* forwarded to EmptyState | `ui/data-table.tsx` | yes |
| `Separator` | Radix separator | `ui/separator.tsx` | yes |
| `CommandPalette` | `open`, `onOpenChange` | `ui/command-palette.tsx` | yes |
| `Tag` | `onRemove`, `removeLabel` | `ui/tag.tsx` | yes |
| `CodeBlock` | pre/code block | `ui/code-block.tsx` | yes |
| `Panel`, `panelVariants` | `tone`: flat\|inset\|subtle\|tint; `padding` none\|sm\|md\|lg\|xl | `ui/panel.tsx` | yes |
| `DataList`, `DataRow`, `DataLabel`, `DataValue` | `density`: tight\|regular\|loose | `ui/data-list.tsx` | yes |
| `CodeChip` | `as`: code\|kbd\|span; `size`: sm\|md\|lg | `ui/code-chip.tsx` | yes |
| `FilterBar`, `clearedFilters` | `filters`, `selects`, `search` | `ui/filter-bar.tsx` | **no** |
| `Wizard` | `steps`, `storageKey`, `completeSlug`, `brand`, `skipHref`, `hideBottomNavOn` | `ui/wizard.tsx` | **no** |
| `LinkCard` | `href`, `title`, `description`, `icon`, `badge`, `external` | `ui/link-card.tsx` | **no** |
| `ErrorBoundary` | class error boundary | `ui/error-boundary.tsx` | **no** |

### `portal-os/` (barrel: `components/portal-os/index.ts`)

| Export | Props / variants | Path | Notes |
|---|---|---|---|
| `AppShell` | `density`, `hideChrome`, slots: sidebar/header/mobileNav/commandPalette/aiRail | `portal-os/AppShell.tsx` | wraps `DensityProvider` |
| `ResourcePageShell` | `header`, `toolbar`, `kpiStrip`, `table`, `detail`, `bulkBar` | `portal-os/ResourcePageShell.tsx` | mostly via `CoreResourcePage` |
| `CoreResourcePage` | `size` + ResourcePageShell slots | `portal-os/CoreResourcePage.tsx` | `PageContent` + shell |
| `useResourceUrlState` | URL state hook | `portal-os/useResourceUrlState.ts` | |
| `useSavedViews` / `ViewState` | saved views hook | `portal-os/useSavedViews.ts` | |
| `QueryFilterBar`, `ViewsMenuTrigger` | `mode`: basic\|query; filters/query/selects | `portal-os/QueryFilterBar.tsx` | uses ui `FilterBar` |
| `ViewsMenu` | saved views menu | `portal-os/ViewsMenu.tsx` | |
| `ResourceOsToolbar` | filter+views+export compose | `portal-os/ResourceOsToolbar.tsx` | uses `TableExportToolbar` internally |
| `TableExportToolbar` | CSV/JSONL export | `portal-os/TableExportToolbar.tsx` | internal-only consumers |
| `BulkActionBar` | `count`, `actions[{variant default\|destructive}]`, `onClear` | `portal-os/BulkActionBar.tsx` | |
| `CrossLinkBar` | `links[{label,href,...}]` | `portal-os/CrossLinkBar.tsx` | |
| `DriftHistogram` | `baseline`, `current` | `portal-os/DriftHistogram.tsx` | |
| `DetailPanelShell` | `open`, tabs, nav, `mobileDrawer` | `portal-os/DetailPanelShell.tsx` | hand-rolled tabs inside |
| `InfiniteDataTable` | DataTable − pageSize + `hasMore`/`onLoadMore`/virtualize | `portal-os/InfiniteDataTable.tsx` | |
| `VirtualizedList` | `items`, `rowKey`, height/overscan | `portal-os/VirtualizedList.tsx` | |
| `CommandPalette` | re-export of ui | `portal-os/CommandPalette.tsx` | alias |
| `MobileBottomNav` | `items`; exports `MOBILE_CORE_NAV`, `MOBILE_MORE_LINKS` | `portal-os/MobileBottomNav.tsx` | |
| `DensityProvider`, `useDensity` | density context | `portal-os/DensityProvider.tsx` | used by AppShell/tables |
| `AppShell*Fixture`, `U18_SHELL_FIXTURES` | story fixtures | `portal-os/stubs/AppShellStates.tsx` | test/fixture only |

### `layout/` (barrel: `components/layout/index.ts`)

| Export | Props / variants | Path | Barrel? |
|---|---|---|---|
| `PageHeader` | `title`, `subtitle`, `eyebrow`, `actions`, `icon`, `greeting`, `description`, `embedded` | `layout/page-header.tsx` | yes |
| `PageContent` | `size`: default\|wide\|narrow\|full; `embedded` | `layout/page-content.tsx` | yes |
| `PageLoading`, `PageLoadingSkeleton` | size + loading/skeleton variants | `layout/page-content.tsx` | **no** |
| `EmbeddedSurface`, `useEmbeddedSurface` | suppress double chrome | `layout/embedded-surface.tsx` | yes |
| `SidebarSearch` | `items`, `hiddenIds` | `layout/sidebar-search.tsx` | yes |
| `LegalPage` | `eyebrow`, `title`, `description`; `size` narrow\|medium\|wide; `draft` | `layout/legal-page.tsx` | **no** |
| `PageHelpHint` | no props | `layout/page-help-hint.tsx` | **no** |
| `PortalNavLink`, `sidebarSearchResultClass` | nav link + helper | `layout/portal-nav-link.tsx` | **no** |

---

## 2. Canonical patterns

### Button
```tsx
import { Button } from "@/components/ui/button";
<Button variant="default" size="sm" loading={busy}>Save</Button>
```
- Prefer `variant`/`size` over hand-rolled accent classes.
- `loading` disables + shows `Loader2`.

### Tabs
```tsx
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
<Tabs defaultValue="a">
  <TabsList variant="underline"> {/* default | underline | pills */}
    <TabsTrigger variant="underline" value="a">A</TabsTrigger>
  </TabsList>
  <TabsContent value="a">…</TabsContent>
</Tabs>
```

### PageHeader
```tsx
import { PageHeader } from "@/components/layout/page-header";
<PageHeader title="Traces" description="…" actions={<Button>…</Button>} />
```
- Under `EmbeddedSurface` / `embedded`, chrome hides; actions-only row remains.

### PageContent
```tsx
import { PageContent } from "@/components/layout/page-content";
<PageContent size="wide">{/* default | wide | narrow | full */}</PageContent>
```
- Owns padding + max-width + `space-y-5`. Do not hand-roll `p-4 sm:p-6 lg:p-8 max-w-*`.

### ResourcePageShell / CoreResourcePage
```tsx
import { CoreResourcePage } from "@/components/portal-os";
<CoreResourcePage
  size="default"
  header={<PageHeader title="…" />}
  toolbar={<ResourceOsToolbar resourceKey="…" />}
  table={<DataTable … />}
  detail={<DetailPanelShell … />}
  bulkBar={<BulkActionBar … />}
/>
```
- Prefer `CoreResourcePage` (PageContent + shell). Direct `ResourcePageShell` only when outer padding is already owned (e.g. traces).

### EmptyState
```tsx
import { EmptyState } from "@/components/ui/empty-state";
<EmptyState
  variant="panel" /* panel | plain | terminal */
  size="md"
  icon={Inbox}
  title="No traces yet"
  action={<Button>Ingest</Button>}
/>
```
- Also the empty path inside `DataTable` via `emptyTitle` / `emptyVariant` / `emptyTerminal`.

---

## 3. Drift counts

| Drift | Canonical | Drift | Ratio |
|---|---|---|---|
| **Accent buttons** | `Button` imports: **113** files; `<Button` JSX: **115** files | Raw `<button … bg-[var(--accent)]>`: **8 files / 11 hits** | ~7% drift by file |
| **Tabs** | `Tabs` imports/JSX: **12** files | Hand-rolled `role="tab"|"tablist"`: **13 files / 29 hits** | hand-roll ≈ canonical |
| **Loader vs Spinner** | **Neither `Spinner` nor `Loader` exists** in shared dirs | — | N/A as named components |

**Loader/Spinner reality (canonical loading stack):**

| Pattern | Files | Hits |
|---|---|---|
| `Loader2` (lucide) | 104 | 307 |
| `LoadingSkeleton` | 84 | — |
| `animate-spin` | 108 | 219 |
| `PageLoading` / `PageLoadingSkeleton` | 2–3 each | rare |
| `\bSpinner\b` / `\bLoader\b` | **0** | **0** |

**Raw accent button files:**  
`users/page.tsx`, `gateway-tab.tsx`, `sidebar-settings-view.tsx`, `exports-tab.tsx`, `org-tab.tsx`, `guardrails/page.tsx`, `sso-tab.tsx`, `observability/cohorts/page.tsx`

**Hand-rolled tab files:**  
`agents`, `analytics`, `evals`, `fleet`, `improve`, `insights/topics`, `issues`, `issues/[id]`, `replay`, `settings`, `traces`, marketing `InstallSection`, plus `DetailPanelShell` (built-in role=tab tabs).

---

## 4. Top 15 most-imported shared components

By named import occurrences from `@/components/{ui,portal-os,layout}*`:

| # | Component | Import files |
|---|---|---|
| 1 | `Button` | 113 |
| 2 | `ErrorState` | 94 |
| 3 | `LoadingSkeleton` | 77 |
| 4 | `NoOrgState` | 72 |
| 5 | `PageHeader` | 69 |
| 6 | `useToast` | 62 |
| 7 | `Card` | 61 |
| 8 | `PageContent` | 55 |
| 9 | `EmptyState` | 54 |
| 10 | `DataTable` | 28 |
| 11 | `Skeleton` | 25 |
| 12 | `CoreResourcePage` | 18 |
| 13 | `CrossLinkBar` | 17 |
| 14 | `Input` | 16 |
| 15 | `Panel` | 14 |

Honorable: `LegalPage` 12, `Tabs*` 12, `Dialog*` 10, `EmbeddedSurface` 10, `StatCard` 9.

---

## 5. Dead / unused components

### Truly unused (no external imports; barrel-only or self-only)

| Component | Path | Notes |
|---|---|---|
| **`LinkCard`** | `ui/link-card.tsx` | not in barrel; zero consumers |
| **`Wizard`** | `ui/wizard.tsx` | not in barrel; zero consumers |
| **`Avatar` / `AvatarImage` / `AvatarFallback`** | `ui/avatar.tsx` | barreled, never imported |
| **`DropdownMenu*` (entire suite)** | `ui/dropdown-menu.tsx` | barreled, never imported |
| **`DataList` / `DataRow` / `DataLabel` / `DataValue`** | `ui/data-list.tsx` | barreled, never imported |
| **`CodeBlock`** | `ui/code-block.tsx` | barreled, never imported |
| **`Separator`** | `ui/separator.tsx` | barreled, never imported |
| **`Breadcrumb`** | `ui/breadcrumb.tsx` | barreled; chrome uses other breadcrumb path |
| **`SidebarSearch`** | `layout/sidebar-search.tsx` | barreled; not wired from chrome imports as component usage graph shows 0 external |
| **`StatusBadge` (base)** | `ui/status-badge.tsx` | only specialized badges imported; base unused directly |
| **`PRStatusBadge`, `OutcomeBadge`** | `ui/status-badge.tsx` | unused |
| **`Table*` primitives + `SortableTableHead`** | `ui/table.tsx` | unused outside DataTable internals |
| **`SkeletonCard`, `SkeletonListItem`** | `ui/skeleton.tsx` | unused (`SkeletonTableRow` may be internal) |
| **`CardFooter`** | `ui/card.tsx` | unused subcomponent |
| **`ViewsMenuTrigger`** | `portal-os/QueryFilterBar.tsx` | exported, unused externally |
| Unused Select parts | `SelectGroup/Label/Separator/Scroll*` | unused |
| Unused Dialog/Sheet parts | `DialogTrigger/Close/Portal/Overlay`, `SheetTrigger/Close/Portal/Overlay` | rarely/never imported |
| **`badgeVariants` / `cardVariants` / `panelVariants`** | variant helpers | unused externally |
| **`FOCUS_RING_VARS`** | `ui/focus-ring.ts` | unused (`FOCUS_RING_CLASS` barely used) |
| **All `AppShell*Fixture` / `U18_SHELL_FIXTURES`** | stubs | fixture-only |

### Used only internally (not dead, but no page imports)

| Component | Used by |
|---|---|
| `DensityProvider` / `useDensity` | `AppShell`, `QueryFilterBar`, `InfiniteDataTable`, `VirtualizedList` |
| `TableExportToolbar` | `ResourceOsToolbar` only |
| `ResourcePageShell` | `CoreResourcePage` + 1 direct (`traces/page.tsx`) |

### Barrel gaps (alive but not re-exported from index)

`FilterBar`, `Wizard`, `LinkCard`, `ErrorBoundary`, `LoadingSkeleton` (+ skeleton helpers), most status-badge specialists, `PageLoading`/`PageLoadingSkeleton`, `LegalPage`, `PageHelpHint`, `PortalNavLink`.

---

## Evidence summary (Wave 1 baseline — see §6 for Wave 2 deltas)

| Metric | Value |
|---|---|
| Files scanned under `{ui,portal-os,layout}` | ~73 source files (excl. tests) |
| Top import | `Button` ×113 |
| Button drift | 11 raw accent `<button>` vs 113 Button |
| Tabs drift | 13 hand-rolled files vs 12 Tabs |
| Spinner/Loader components | **0 / 0** (use `Loader2` + `LoadingSkeleton`) |
| Clear dead product components | `LinkCard`, `Wizard`, `Avatar*`, `DropdownMenu*`, `DataList*`, `CodeBlock`, `Separator`, unused Table primitives |
| Preferred page stack | `PageContent` → `PageHeader` → (`CoreResourcePage` \| content) → `EmptyState`/`ErrorState`/`LoadingSkeleton` |

---

## 6. Wave 2 — UI primitives refresh (`w2-ui-primitives-inv`)

**Live 2026-07-20:**

| Signal | Count |
|---|---:|
| UI modules (`.tsx` + `focus-ring.ts`, excl. barrel/test) | **42** |
| `Button` import files | **120** |
| `ui/tabs` adopters | **20** |
| Hand-rolled `role="tablist"` | **6** files |
| Portal raw accent CTA-ish lines | **~28** / ~17 files |
| `<button` + accent (multiline, excl. `ui/`) | **29** files |
| Raw `<button` matches (all src) | **~324** / ~127 files |
| `EmptyState` non-test consumers | **~56** |
| `ErrorState` importers | **~93** |
| `QueryState` page consumers | **6** |
| `FilterBar` prod consumers | **2** (`references-tab`, `QueryFilterBar`) |

### Wave 2 CTA / Tabs drift (supersedes §3 where conflicting)

**Hand-rolled tablists (6):** `settings/page.tsx`, `replay/page.tsx`, `fleet/page.tsx`, `issues/[id]/page.tsx`, `insights/topics/page.tsx`, marketing `InstallSection.tsx`.

**Wave 5 purge priority:** observability/* (eval/query/memory/decisions/cohorts) → optimization/* → settings/replay/fleet tabs → incidents + agents/[id] → wizard.tsx internal CTA.

**Under-adopted:** `FilterBar` (barrel gap + 2 consumers), `QueryState` (6 pages), `LinkCard`/`Wizard`/`ErrorBoundary` (not in barrel).

---

## 7. Wave 2 — Portal-OS adoption (`w2-portal-os-inv`)

**Catalog:** 20 portal-os files (~1.8k LOC). Barrel: `components/portal-os/index.ts`.

### Hub adoption matrix (legend: ✅ / ⚠️ hand / ❌)

| Hub | CoreResourcePage | ResourceOsToolbar | QueryFilterBar | ViewsMenu | DetailPanelShell | InfiniteDataTable | VirtualizedList | BulkActionBar |
|---|---|---|---|---|---|---|---|---|
| Traces | ❌ (direct shell) | ❌ | ✅ hand | ✅ hand | ✅ | ⚠️ Spans/Sessions | ❌ | ❌ |
| Issues | ✅ | ✅ | ◐ | ◐ | ✅ | ❌ | ✅ | ✅ |
| Alerts | ✅ | ✅ | ◐ | ◐ | ✅ | ❌ | ✅ | ✅ |
| Artifacts | ✅ | ✅ | ◐ | ◐ | ✅ | ❌ (.map) | ❌ | ✅ |
| Experiments | ✅ | ✅ | ◐ | ◐ | ✅ | ✅ | ❌ | ❌ |
| Datasets | ✅ | ✅ | ◐ | ◐ | ❌ | ✅ | leaf only | ❌ |
| Promotions | ✅ | ✅ | ◐ | ◐ | ✅ | ❌ (.map) | ❌ | ✅ |
| Improve | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ queue | ❌ |
| Agents | ✅ | ❌ | ❌ (custom input) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Evals | ✅ shell-only | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Settings | ❌ | ❌ | ❌ (ui FilterBar once) | ❌ | ❌ | ❌ | ❌ | ❌ |

**W11 OS hubs** (`portal-polish.ts`): traces, issues, alerts, artifacts, experiments, datasets, promotions — Traces special-cased to allow hand-composed `QueryFilterBar` instead of `ResourceOsToolbar`.

**Underused OS:** `TableExportToolbar` (only via ResourceOsToolbar), `DriftHistogram` (1 leaf), `ViewsMenuTrigger` (external unused), InfiniteDataTable (5 call sites).

**Waves 5–7 adopt order:** Traces→ResourceOsToolbar → Agents/Improve toolbars → Settings tables→InfiniteDataTable → Guardrails/Users/Tools/Studio/Replay→CoreResourcePage.

---

## 8. Wave 2 — Observe component map (`w2-obs-component-map`)

| File | Role | Nest / control-pile |
|---|---|---|
| `components/observability/TranscriptView.tsx` | Canonical chronological transcript | **Heaviest:** SummaryCard + toolbar + bordered rows + sub-panels + sidebar |
| `components/transcript-v2/TranscriptV2.tsx` | Orchestrator + progressive load | Adds ParallelToolLane above TranscriptView |
| `components/transcript-v2/VirtualizedTranscript.tsx` | Alias → TranscriptV2 | Entry from TraceDetailPanel |
| `components/transcript-v2/ParallelToolLane.tsx` | Parallel tool swimlanes | Outer bordered well + lane cards |
| `components/transcript-v2/MessageCards.tsx` | LLM message stack | Recursive bordered cards |
| `components/traces/TraceDetailPanel.tsx` | Trace detail body | Meta + mode toggle + VirtualizedTranscript |
| `components/portal-os/DetailPanelShell.tsx` | Right-rail chrome | First nest layer (`border-l`) |
| `app/(portal)/traces/page.tsx` | Traces hub | ResourcePageShell + filters + LiveTail + detail |
| `app/(portal)/traces/_components/LiveTailPanel.tsx` | Live SSE | Hand-rolled bordered section |
| `observability/_components/{TracesTab,SelectedTraceCard}.tsx` | Legacy/hub embeds | Filter Card + sticky selected-trace card |

**Worst compose path (depth ~5):**  
`ResourcePageShell` → `DetailPanelShell` → `TraceDetailPanel` → `VirtualizedTranscript` → `TranscriptV2` (`ParallelToolLane` + `TranscriptView` + sidebar).

---

## 9. Wave 2 — Card-nest audit (`w2-card-nest-audit`)

**Contract:** Card = interactive container; Panel = grouping; **no Card-in-Card**. Anti-clutter: flatten boxes-on-boxes.

### Top 10 nest offenders

| # | Surface | Depth | Sev | Notes |
|---:|---|---:|---|---|
| 1 | `/traces` detail stack | **~5** | P0 | DetailPanelShell → TraceDetailPanel → TranscriptV2 → lanes → TranscriptView |
| 2 | `TranscriptView.tsx` | **~4** | P0 | Summary + toolbar + bordered expandables + sidebar |
| 3 | `ParallelToolLane.tsx` | **3** | P0 | Well + lane cards + label controls |
| 4 | `MessageCards.tsx` | **3+** | P1 | Recursive bordered message cards |
| 5 | SettingsCard + inner wells | **3** | P1 | members / api-keys / org-tab nested boxes |
| 6 | `studio/page.tsx` | **3** | P1 | Generator Card + example mini-cards + Card→DataTable |
| 7 | Card→DataTable double frame | **2** | P1 | ≥10 files (studio, users, TracesTab, exports, gateway, obs leaves) |
| 8 | improve change-impact / scorecard | **2–3** | P1 | KPI Card grids |
| 9 | `guardrails/page.tsx` | **2–3** | P1 | Panel form + 3 bordered result cards |
| 10 | autonomous / scim / roles / security tabs | **3** | P1 | Hand-rolled `rounded-xl border` piles |

### Flatten targets

- **W5 Observe:** one chrome owner for TraceDetail+TranscriptV2; demote ParallelToolLane wells; hairline/left-accent instead of nested borders; LiveTail → Panel.
- **W6 Settings/tables:** SettingsCard children open or Panel; drop outer Card around DataTable.
- **W7 Improve/studio/guardrails:** KPI as Stat strip not Card grid; studio examples without double Card; filter bars demote to hairline under ResourcePageShell.