<!-- Auto-captured from Wave 1 agent `w1-hub-surfaces` (read-only discovery). -->

# Hub chrome inventory (read-only)

**Convention:** Chrome bands = stacked identity/nav/filter rows above primary content (AppShell sidebar/topbar excluded). **Traces critical = 3** = PageHeader + hub tabs + QueryFilterBar OS (facets/legacy now in **More**). **Tabs:** many hubs now import `@/components/ui/tabs`; Settings still uses a custom rail. Shell: `CoreResourcePage` → `ResourcePageShell` (`header` → `toolbar` → table), except Settings.

> **Live clutter scores (Jobs 4–6) supersede §§1–8 band/title prose below** — see [Hub clutter scoring](#hub-clutter-scoring-jobs-46--live-re-read-2026-07-20) at end of this file. Stale claims in the original inventory: Settings double `h2`, Traces facet-chip sibling band, “no hub uses ui/tabs”.

---

## 1. Dashboard (Home)

| Field | Detail |
|--------|--------|
| **Routes / files** | `/dashboard` — `clients/portal/src/app/(portal)/dashboard/page.tsx`; prefetch `dashboard/layout.tsx`; widgets in `dashboard/_components/*` |
| **Nav** | Sidebar “Home” → `/dashboard` (`sidebar-config.ts:59-63`) |
| **Tabs** | **0** — no tablist |
| **Toolbars / filters** | None. Header actions: Open Traces / Issues / Connect / Edit layout (`page.tsx:528-560`). Edit mode = widget toggles (`:569-593`) |
| **CrossLinkBar / legacy** | **No** CrossLinkBar. CTA links only |
| **Chrome bands** | **1** (PageHeader only) |
| **PageHeader / double title** | Single: `title="Home"` (`:472-474`). Breadcrumb also “Home” (`breadcrumbs.ts:25`) — intentional, no category prefix |
| **Key children** | `ThroughputCard`, latency/cost/anomaly/agentic widgets, `RecentTracesCard`, `QuickLinks`; widgets `DEFAULT_WIDGETS` (`:43-52`) |

---

## 2. Traces (critical ~3)

| Field | Detail |
|--------|--------|
| **Routes / files** | `/traces` — `traces/page.tsx`; prefetch `traces/layout.tsx`; `traces/_components/{LiveTailPanel,SpanSearchBar}`; embeds inspector/replay/debugger/query + observability facets |
| **Tabs** | **3** hand-rolled hub: `traces` \| `spans` \| `sessions` (`HUB_VIEWS` `:52`, tablist `:445-466`) |
| **Toolbars / filters** | Band stack in `toolbar` (`:443-595`): (1) hub tabs + legacy links, (2) facet chips `mcp/decisions/memory/retrieval` (`:486-505`), (3) `QueryFilterBar` + agent chip + `ViewsMenu` + Refresh (`:507-594`). List also has `SpanSearchBar` (`:676`) |
| **CrossLinkBar / legacy** | **No** hub CrossLinkBar. **Legacy links** inline on tab row: Inspector, Replay, Debugger, Time-Travel, Query (`:467-483`). Detail: `TraceDetailPanel` CrossLinkBar (`TraceDetailPanel.tsx:147-163`) |
| **Chrome bands** | **3 critical** = PageHeader (`:717-721`) + tabs/legacy + facets/filters. Facet-only / legacy views swap toolbar (`:724-756`) |
| **PageHeader / double title** | One hub header: eyebrow `Observe`, title `Traces`. Embedded legacy/facet pages wrap `EmbeddedSurface` so nested PageHeaders hide (`:760-768`, `page-header.tsx:30-48`) |
| **Key children** | `TracesTab`, `SpansTab`, `SessionsTab`, `TraceDetailPanel`, `LiveTailPanel`, dynamic Inspect/Replay/Debug/Query + facet views |

---

## 3. Agents

| Field | Detail |
|--------|--------|
| **Routes / files** | `/agents` — `agents/page.tsx`; `/agents/connect`, `/agents/[id]/{page,ledger,book,artifacts,drift}` |
| **Tabs** | **2** hand-rolled: `agents` \| `fleet` (`AGENT_TABS` `:38`, tablist `:195-213`) |
| **Toolbars / filters** | Toolbar = CrossLinkBar + tabs (`:185-214`). List search + framework select in table body (`:286-331`), not shell toolbar |
| **CrossLinkBar / legacy** | Hub CrossLinkBar: Fleet, Improve, Ledger, Audit trail (`:187-193`). Fleet embed suppresses nested CrossLinkBar (`fleet/page.tsx:162-172`) |
| **Chrome bands** | **3** (PageHeader + CrossLinkBar + tabs); +1 in-body filter when on Agents |
| **PageHeader / double title** | One: `title="Agents"` + subtitle + `description` (`:141-148`) — dense, not double title. Fleet child header hidden via `EmbeddedSurface` (`:217-220`) |
| **Key children** | Agent cards grid; `FleetView` → `fleet/page.tsx` |

---

## 4. Evals

| Field | Detail |
|--------|--------|
| **Routes / files** | `/evals` — `evals/page.tsx`; embeds `/datasets`, `/playgrounds`, `/experiments`, `/observability/eval`, `/labeling`, `/studio`, `/synthetic` |
| **Tabs** | **7** hand-rolled: Datasets, Playground, Experiments, Scores, Labeling, Studio, Synthetic (`TABS`/`TAB_META` `:20-62`, tablist `:124-147`) |
| **Toolbars / filters** | Tab strip only — no QueryFilterBar / ResourceOsToolbar at hub |
| **CrossLinkBar / legacy** | **None**. Inline copy links to playground / docs (`:151-170`) |
| **Chrome bands** | **2** (PageHeader + tabs) |
| **PageHeader / double title** | One hub header (`:108-121`). Children wrapped in `EmbeddedSurface` (`:177-210`) → nested PageHeaders suppressed |
| **Key children** | Dynamic `DatasetsView`, `PlaygroundsView`, `ExperimentsView`, `EvalView`, `LabelingView`, `StudioView`, `SyntheticView` |

---

## 5. Improve

| Field | Detail |
|--------|--------|
| **Routes / files** | `/improve` — `improve/page.tsx`; related `/improve/{plans,runs,scorecard,change-impact,online-scoring}` |
| **Tabs** | **3** hand-rolled: Queue, Plans, History (`IMPROVE_TABS` `:39`, labels `:333`, tablist `:318-336`) |
| **Toolbars / filters** | No filter bar. Queue = kanban columns (`COLUMNS` `:58-64`); Refresh in header when `tab===queue` (`:293-304`) |
| **CrossLinkBar / legacy** | Hub CrossLinkBar: Issues, Artifacts, Promotions, Scorecard (`:310-316`) |
| **Chrome bands** | **3** (PageHeader + CrossLinkBar + tabs) |
| **PageHeader / double title** | One (`:288-291`). Plans/History via `EmbeddedSurface` (`:341-349`) |
| **Key children** | Queue `VirtualizedList` / columns; `PlansView` → `plans/page`; `HistoryView` → `runs/page` |

---

## 6. Alerts

| Field | Detail |
|--------|--------|
| **Routes / files** | `/alerts` — `alerts/page.tsx`; `?tab=signals` embeds `signals/page`; `?tab=rules` opens rules panel |
| **Tabs** | **No** hub tablist. Modes via URL: feed (default), `signals`, `rules` (`:128-131`, `:296-318`) |
| **Toolbars / filters** | Feed: `ResourceOsToolbar` (`:367-382`), severity KPI buttons (`:394-427`), ack filter All/Unread/Acknowledged (`:436-459`), Rules toggle (`:463+`), `BulkActionBar` (`:383-392`) |
| **CrossLinkBar / legacy** | Detail panel CrossLinkBar (`:864-877`). Signals mode: Feed · Signals text links (`:306-310`). Header “Signals” link (`:330-335`) |
| **Chrome bands** | Feed **~4–5** (PageHeader + ResourceOsToolbar + severity strip + ack/rules). Signals **2** (header + Feed/Signals) |
| **PageHeader / double title** | One `title="Alerts"` (`:324-327`). Signals child PageHeader hidden under `EmbeddedSurface` (`:313-315`) |
| **Key children** | Alert list + `DetailPanelShell`; `AlertRulesPanel`; `SignalsView` |

---

## 7. Issues (Agent Issues)

| Field | Detail |
|--------|--------|
| **Routes / files** | `/issues` — `issues/page.tsx`; `/issues/[id]`; incidents embed `/incidents` |
| **Tabs** | **2** section tabs: Agent Issues \| Incidents (`TOP_TABS`/`TOP_TAB_LABELS` `:43-47`, `:303-321`). Nested **7** status filters: all, open, triaged, fix pending, verifying, resolved, regressed (`STATUS_FILTERS` `:31-38`, `:120-140`) |
| **Toolbars / filters** | `ResourceOsToolbar` + status tablist inside `IssuesList` (`:111-140`); `BulkActionBar` on shell (`:338-381`) |
| **CrossLinkBar / legacy** | Detail CrossLinkBar only (`:430-439`) — not hub-level |
| **Chrome bands** | Issues tab **4** (PageHeader + section tabs + ResourceOsToolbar + status tabs). Incidents **2** at hub (+ child chrome suppressed) |
| **PageHeader / double title** | One: `title="Agent Issues"` (`:296-300`). Incidents embed hides its own PageHeader |
| **Key children** | `IssuesList` + `VirtualizedList`; `IncidentsView`; `DetailPanelShell` |

---

## 8. Settings

| Field | Detail |
|--------|--------|
| **Routes / files** | `/settings` — `settings/page.tsx`; leaf routes `settings/(tabs)/{pii,gateway,exports,retention,sidebar,status,webhooks-dlq}`; many `_components/*-tab.tsx` |
| **Tabs** | **~20** hand-rolled rail tabs (not shadcn Tabs): Organization, Account, API Keys, Members, Custom Roles (hidden), Code References, MCP, Security, SCIM, SSO (hidden), AI Gateway, PII, Retention, Exports, Audit Log, Platform status, Analytics, Billing, FinOps kills, Autonomous, Sidebar (`TABS` `:128-239`, rail `:408-415`) |
| **Toolbars / filters** | `SettingsSearch` on rail (`:407`). Per-tab tools (e.g. References `FilterBar`). Org switcher panel under header (`:428-462`) |
| **CrossLinkBar / legacy** | **None** |
| **Chrome bands** | **Different layout:** left rail (title + search + tabs) + main PageHeader + optional org panel. Not `CoreResourcePage` |
| **PageHeader / double title** | **Yes — double “Settings”:** rail `<h2>Settings</h2>` (`:406`) **and** `<PageHeader title="Settings" …>` (`:422-425`). Account/profile and Sidebar use `EmbeddedSurface` / `embedded` to avoid third titles |
| **Key children** | Org/Members/ApiKeys/… tab components; Account → profile embed; Sidebar → `SidebarSettingsView embedded` |

---

## Comparison table

| Hub | Route | Shell | Tabs (hand-rolled) | CrossLinkBar | Legacy / deep links | Chrome bands | PageHeader / double title | Primary filters |
|-----|-------|-------|--------------------|--------------|---------------------|--------------|---------------------------|-----------------|
| **Dashboard** | `/dashboard` | CoreResourcePage | 0 | No | CTA links | **1** | Home — OK | None |
| **Traces** | `/traces` | ResourcePageShell | 3 (+4 facet +4 legacy views) | Detail only | Inspector/Replay/Debugger/Time-Travel/Query | **~3 critical** | Traces — OK (embed suppresses) | QueryFilterBar + ViewsMenu |
| **Agents** | `/agents` | CoreResourcePage | 2 (agents/fleet) | Hub yes | Via CrossLinkBar | **3** (+ body search) | Agents — OK | Search + framework |
| **Evals** | `/evals` | CoreResourcePage | 7 | No | Inline docs/playground | **2** | Evals — OK (embed) | None at hub |
| **Improve** | `/improve` | CoreResourcePage | 3 (queue/plans/history) | Hub yes | Via CrossLinkBar | **3** | Improve — OK | None |
| **Alerts** | `/alerts` | CoreResourcePage | 0 (URL modes) | Detail only | Feed/Signals, `?tab=rules` | **~4–5** feed / **2** signals | Alerts — OK | ResourceOsToolbar + severity + ack |
| **Issues** | `/issues` | CoreResourcePage | 2 + 7 status | Detail only | Section tabs only | **4** (issues) | Agent Issues — OK | ResourceOsToolbar + status |
| **Settings** | `/settings` | Custom split rail | ~20 (gated/hidden) | No | `?tab=`, `/settings/webhooks-dlq` | Rail + header | **Double “Settings”** (`:406` + `:422`) | SettingsSearch |

---

## Shared chrome primitives (refs)

- `CoreResourcePage` — `clients/portal/src/components/portal-os/CoreResourcePage.tsx:18-44` (header/toolbar split avoids double-pad)
- `ResourcePageShell` — `ResourcePageShell.tsx:19-53` (slot order)
- `PageHeader` embed hide — `page-header.tsx:29-56`
- `CrossLinkBar` — `CrossLinkBar.tsx:18-44`
- `QueryFilterBar` / `ResourceOsToolbar` — portal-os
- Sidebar IA freeze — `sidebar-config.ts:52-214`
- **No hub uses** `components/ui/tabs` (`Tabs`/`TabsList`/`TabsTrigger`)

---

## Accomplished (evidence)

- Inventoried all **8** requested hubs with routes, tabs, toolbars, CrossLinkBar/legacy, band counts, PageHeader risks, key children.
- **Jobs 4–6 clutter scores** appended (live 2026-07-20) — supersede stale §§1–8 title/tabs claims.
- Traces documented as **band_count=3** FAIL ≤2 (`PageHeader` + hub tabs + QueryFilterBar OS; facets/legacy in More).
- Settings **dual_title=N** (rail h2 removed); overload = 19-tab / 6-group rail.
- Comparison + scoreboard tables included for side-by-side review.

---

# Hub clutter scoring (Jobs 4–6) — live re-read 2026-07-20

**Formula (0–10, higher = more overwhelming):**
- chrome bands beyond 2 → **+1.5 each** (identity/title, toolbar, filter/facet, KPI strip, secondary tabs, sticky extras)
- visible primary CTAs above 5 → **+0.5 each**
- KPI chips above 7 (desktop) → **+0.3 each**
- duplicate titles / dual identity → **+2**
- micro-controls packed in header → **+1**
- nested cards in chrome region → **+1**

**Convention:** AppShell sidebar / top breadcrumb excluded from band_count. Bands counted by *stacked chrome purpose*, even when co-mounted in one `toolbar` flex-wrap. Scores use **steady-state** (org present, non-empty where that unlocks KPI strips).

> **Drift vs inventory above:** Live code now imports `@/components/ui/tabs` on Traces/Issues/Evals/Improve/Agents. Traces moved legacy+facets into a **More** dropdown. Settings rail **no longer** has `<h2>Settings</h2>` (PageHeader-only title). Re-score below supersedes stale band/title claims for those hubs.

---

## Job 4 — `w1-hub-observe` (Dashboard / Traces / Issues / Alerts)

| Hub | Score | band_count | dual_title | visible_CTAs | KPI_count | Notes |
|-----|------:|-----------:|:----------:|-------------:|----------:|-------|
| **Dashboard / Home** | **0.0** | 1 | N | 4 | 0 | Calm: PageHeader only. Steady CTAs: Open Traces, Issues, Connect repo?, Edit layout (`dashboard/page.tsx:528-559`). Greeting+subtitle+actions are one identity band (`:472-564`). Widget StatCards are **content**, not chrome KPI strip. |
| **Traces** | **2.5** | **3** ⚠ | N | 4 | 0 | **Archetype failure (≥3).** Bands: (1) PageHeader eyebrow Observe + title (`:726-730`) (2) secondary tabs traces\|spans\|sessions (`:466-487`) (3) filter OS = QueryFilterBar + agent chip + ViewsMenu + Refresh + More (`:488-603`). Facet chips / legacy tools **collapsed into More** (`:574-603`) — better than prior inventory, but tabs+filter still stack. QueryFilterBar itself is 2 internal rows (mode + FilterBar) (`QueryFilterBar.tsx:130-162`). Micro-controls **Y** (+1). SpanSearchBar lives in table body (`:685`) — not counted as chrome band. |
| **Issues** | **4.0** | **4** | N | 3 | 0 | Bands: (1) PageHeader Agent Issues (`:298-302`) (2) section tabs Agent Issues\|Incidents (`:305-320`) (3) ResourceOsToolbar (`:114-122`) (4) status TabsList ×7 (`:123-146`). Beyond-2 = 2→+3.0; dense toolbar micro-controls +1. Dual title **N** (tab label matches page title — intentional, not dual identity). BulkActionBar only when selected (`:340-383`). |
| **Alerts** (feed) | **5.5** | **4** | N | 6 | 5 | Worst observe hub. Bands: (1) PageHeader + Signals/Refresh/Ack actions (`:331-370`) (2) ResourceOsToolbar (`:374-389`) (3) severity KPI grid ×5 (`:407-434`) (4) ack\|Rules\|verdict filter strip (`:442-516`). Beyond-2=+3.0; CTAs 6→+0.5; micro +1; nested card-like severity tiles in chrome +1. KPI_count=5 (≤7, no chip penalty). Signals mode drops to ~2 bands (`:303-325`). |

### Job 4 evidence (file:line)

| Hub | Evidence |
|-----|----------|
| Dashboard | `clients/portal/src/app/(portal)/dashboard/page.tsx:467-564` header; widgets `:759+`; `DEFAULT_WIDGETS` `:43-52` |
| Traces | `traces/page.tsx:464-605` toolbar; `:722-766` shell; `QueryFilterBar.tsx:120-162`; `ResourcePageShell.tsx:19-56` slot order |
| Issues | `issues/page.tsx:296-320` header+section tabs; `:114-146` toolbar+status; STATUS_FILTERS `:34-42` |
| Alerts | `alerts/page.tsx:328-516` feed chrome; severity `:410-434`; filters `:442-516` |

### Job 4 band math

| Hub | bands>2 | CTA>5 | KPI>7 | dual | micro | nested cards | **Total** |
|-----|--------:|------:|------:|-----:|------:|-------------:|----------:|
| Dashboard | 0 | 0 | 0 | 0 | 0 | 0 | **0.0** |
| Traces | 1×1.5 | 0 | 0 | 0 | 1 | 0 | **2.5** |
| Issues | 2×1.5 | 0 | 0 | 0 | 1 | 0 | **4.0** |
| Alerts | 2×1.5 | 1×0.5 | 0 | 0 | 1 | 1 | **5.5** |

---

## Job 5 — `w1-hub-evaluate-improve` (Evals / Improve / Artifacts / Ledger / Promotions / Audit)

| Hub | Score | band_count | dual_title | visible_CTAs | KPI_count | Notes |
|-----|------:|-----------:|:----------:|-------------:|----------:|-------|
| **Evals** | **0.0** | 2 | N | 1 | 0 | PageHeader + 7-tab strip only (`evals/page.tsx:108-141`). Docs ghost CTA (`:114-120`). No QueryFilterBar / CrossLinkBar. Eyebrow Evaluate + title Evals = hierarchy, not dual. **IA note (not scored):** 7 peer tabs wrap heavily — clutter feel without band penalty. |
| **Improve** | **1.5** | **3** | N | 1 | 0 | Bands: PageHeader (`:293-311`) + CrossLinkBar (`:315-322`) + Queue\|Plans\|History tabs (`:323-338`). Beyond-2=+1.5. Refresh only on queue tab. |
| **Artifacts** | **6.5** | **5** | N | 3 | 3 | **Worst Job 5.** Bands: (1) PageHeader + Promotions link (`:417-426`) (2) ResourceOsToolbar (`:191-201`) (3) KPI Panels Shadow/Promoted/Archived (`:225-236`) (4) Author-from-NL nested Panel (`:237-261`) (5) mode Tabs all\|shadow\|promoted\|archived (`:262-269`). Beyond-2=3→+4.5; micro +1; nested chrome cards +1. KPI=3 (no chip penalty). |
| **Ledger** | **0.0** | 2 | N | 1 | 0 | PageHeader + CrossLinkBar only (`ledger/page.tsx:67-80`). Empty CTA Browse artifacts (`:110-114`). |
| **Promotions** | **4.0** | **4** | N | 2 | 0 | Bands: PageHeader (`:235-238`) + status Button row ×4 (`:242-256`) + ResourceOsToolbar (`:257-266`) + CrossLinkBar (`:267-273`). Beyond-2=+3.0; micro +1. Title "Promotions inbox" OK. |
| **Audit trail** | **5.0** | **4** | N | 2 | 0 | Exists at `/audit-trail`. Bands: PageHeader+Verify (`:177-187`) + CrossLinkBar (`:189-197`) + dual nested Panels (chain verify + compliance export) (`:201-245`) + agent filter strip (`:247-270`). Beyond-2=+3.0; micro +1; nested chrome cards +1. Cross-links to Settings audit-log (`:195`). |

### Job 5 evidence (file:line)

| Hub | Evidence |
|-----|----------|
| Evals | `evals/page.tsx:19-28` TABS×7; `:106-141` header+toolbar |
| Improve | `improve/page.tsx:290-339` header+CrossLink+tabs |
| Artifacts | `artifacts/page.tsx:189-269` table chrome stack; `:415-428` shell header |
| Ledger | `ledger/page.tsx:65-80` |
| Promotions | `promotions/page.tsx:232-275` |
| Audit | `audit-trail/page.tsx:173-270` |

### Job 5 band math

| Hub | bands>2 | CTA>5 | KPI>7 | dual | micro | nested | **Total** |
|-----|--------:|------:|------:|-----:|------:|-------:|----------:|
| Evals | 0 | 0 | 0 | 0 | 0 | 0 | **0.0** |
| Improve | 1×1.5 | 0 | 0 | 0 | 0 | 0 | **1.5** |
| Artifacts | 3×1.5 | 0 | 0 | 0 | 1 | 1 | **6.5** |
| Ledger | 0 | 0 | 0 | 0 | 0 | 0 | **0.0** |
| Promotions | 2×1.5 | 0 | 0 | 0 | 1 | 0 | **4.0** |
| Audit trail | 2×1.5 | 0 | 0 | 0 | 1 | 1 | **5.0** |

---

## Job 6 — `w1-hub-settings-agents` (Settings / Agents / Connect)

### Settings rail census (exact)

| Metric | Count | Evidence |
|--------|------:|----------|
| `TABS` entries (declared) | **21** | `settings/page.tsx:117` Tab union; `:126-237` array |
| `hidden: true` | **2** (roles, sso) | `:151-152`, `:174-180` |
| Visible excl. hidden (admin max before perm gates) | **19** | filter `!t.hidden` `:346-352` |
| Category groups | **6** | Org · Members · Security · Compliance · Billing · Advanced — `CATEGORY_ORDER` `:241` |
| Soft-gated further | personal hides scim; audit/billing/edit gates | `canAccessTab` `:274-281` |

**Dual-title detection (Settings):**

| Signal | Present? | Evidence |
|--------|:--------:|----------|
| Rail `<h2>Settings</h2>` + PageHeader | **N** (fixed) | Rail is SettingsSearch only (`:398-407`); PageHeader `title="Settings"` (`:414-417`) |
| Page title + org Select in body | **N** | OrgTab has read-only org details cards, no Clerk Select (`org-tab.tsx:167-203`) |
| Residual dual identity | partial | Breadcrumb also "Settings" (`breadcrumbs.ts:29`) — AppShell, excluded; sidebar OrganizationSwitcher still global (`portal-chrome.tsx:668-686`) |

| Hub | Score | band_count | dual_title | visible_CTAs | KPI_count | Notes |
|-----|------:|-----------:|:----------:|-------------:|----------:|-------|
| **Settings** | **2.5** | **3** | **N** | 0 | 0 | Layout ≠ CoreResourcePage. Bands: (1) left rail nav (19 tabs / 6 groups) (2) SettingsSearch filter (`:399`) (3) main PageHeader (`:414-417`). Beyond-2=+1.5; dense rail micro-controls +1. **dual_title N** — classic double “Settings” h2 removed. Overload is **tab IA** (19), not title duplication. Nested SettingsCards are tab **content**, not chrome. |
| **Agents** | **4.0** | **4** | N | 3 | 0 | Bands: PageHeader+Docs/Link/Refresh (`:146-188`) + CrossLinkBar (`:192-199`) + agents\|fleet tabs (`:200-215`) + in-body search/framework filter (`:290-335`). Beyond-2=+3.0; header micro-pack +1. Fleet embed via EmbeddedSurface (`:220-223`). |
| **Agents / connect** | **0.5** | 2 | N | 0–3 | 0 | Back link + PageHeader (`connect/page.tsx:59-73`). Eyebrow Optional + title — hierarchy. Post-link success shows 3 text CTAs (`:97-118`). OnboardingConnectFlow is content. Score **0.5** = light micro density (back + identity), formula bands≤2 so floor ≈0–1. |

### Job 6 evidence (file:line)

| Hub | Evidence |
|-----|----------|
| Settings | `settings/page.tsx:117-241` tabs/groups; `:395-417` rail+header; `settings-category-group.tsx:1-10`; `portal-chrome.tsx:668-686` org switcher |
| Agents | `agents/page.tsx:138-335` |
| Connect | `agents/connect/page.tsx:57-126` |

### Job 6 band math

| Hub | bands>2 | CTA>5 | KPI>7 | dual | micro | nested | **Total** |
|-----|--------:|------:|------:|-----:|------:|-------:|----------:|
| Settings | 1×1.5 | 0 | 0 | **0** | 1 | 0 | **2.5** |
| Agents | 2×1.5 | 0 | 0 | 0 | 1 | 0 | **4.0** |
| Connect | 0 | 0 | 0 | 0 | 0.5* | 0 | **0.5** |

\*Connect: no formal micro-control penalty (+1); half-point noted for back-link+header stack only — **report 0.5** as rounded observational score with bands=2.

---

## Combined scoreboard (all Jobs 4–6)

| Rank | Hub | Score | band_count | dual_title | CTAs | KPIs |
|-----:|-----|------:|-----------:|:----------:|-----:|-----:|
| 1 | **Artifacts** | **6.5** | 5 | N | 3 | 3 |
| 2 | **Alerts** | **5.5** | 4 | N | 6 | 5 |
| 3 | **Audit trail** | **5.0** | 4 | N | 2 | 0 |
| 4 | **Issues** | **4.0** | 4 | N | 3 | 0 |
| 4 | **Promotions** | **4.0** | 4 | N | 2 | 0 |
| 4 | **Agents** | **4.0** | 4 | N | 3 | 0 |
| 7 | **Settings** | **2.5** | 3 | **N** | 0 | 0 |
| 7 | **Traces** | **2.5** | **3** ⚠ | N | 4 | 0 |
| 9 | **Improve** | **1.5** | 3 | N | 1 | 0 |
| 10 | **Connect** | **0.5** | 2 | N | 0–3 | 0 |
| 11 | Dashboard | **0.0** | 1 | N | 4 | 0 |
| 11 | Evals | **0.0** | 2 | N | 1 | 0 |
| 11 | Ledger | **0.0** | 2 | N | 1 | 0 |

### Worst offenders

1. **Artifacts (6.5)** — five stacked chrome regions including KPI Panels + author Panel + mode tabs + ResourceOsToolbar.
2. **Alerts feed (5.5)** — severity KPI tiles + triple filter grammar (toolbar / ack / verdict) + header actions.
3. **Audit trail (5.0)** — dual nested chrome Panels + CrossLinkBar + filter before the table.
4. **Issues / Promotions / Agents (4.0)** — four-band pattern (header + secondary nav + filter OS + extra strip/tabs).
5. **Traces (2.5)** — score improved vs old facet-chip era, but **still archetype-fails at band_count=3** (identity + hub tabs + QueryFilterBar OS). Collapse tabs into filter mode or merge into one Observe toolbar to reach ≤2.

### Traces archetype note

Wave 3 must-ship: **Traces ≤2 chrome bands**. Live state after More-menu collapse:

```
band 1: PageHeader (Observe / Traces)     traces/page.tsx:726-730
band 2: TabsList traces|spans|sessions   :466-487
band 3: QueryFilterBar + Views + Refresh + More  :488-603
```

Still **≥3 → failure**. Facets no longer a sibling chip band (win), but secondary tabs remain a separate band from the filter OS.

### Settings dual-title note

Prior Wave 1 claim (rail h2 + PageHeader) is **stale**. Live dual_title = **N**. Remaining Settings clutter is **19-tab / 6-group rail density**, not duplicate titles. Org switcher remains shell-only (good vs old in-page Select).