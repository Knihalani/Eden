# Wave 3 — Laminar Implementable Contracts (+ declutter acceptance)

**Status:** Wave 3 refresh — 2026-07-20 (`w3-laminar-contracts`)  
**Audience:** Wave 4–6 implementers (Wave 4 owns Design Brief synthesis; this file is research contracts)  
**Parent:** [`w2-competitor-pattern-library.md`](./w2-competitor-pattern-library.md)  
**Baseline:** [`w1-consolidated-inventory.md`](./w1-consolidated-inventory.md) — Traces **3 bands** FAIL; Top-20 locked  
**Spec anchors:** U00, U01, U18

**Scope:** Interaction contracts only — **not** skins. Prefer existing Eden components.

---

## Declutter doctrine (binding for §A–§C)

1. **≤2 page chrome bands** on hubs (identity + ≤1 toolbar).  
2. **Progressive disclosure** — secondary tools in overflow / detail / menus.  
3. **≤5 primary toolbar actions** visible; rest → More.  
4. **Hide via views** — optional columns live in saved views / Display, not always-on chrome.  
5. **One identity** — no dual titles; org switcher shell-only.  
6. **Empty space is a feature** — do not fill header gaps with more controls.

---

## A. Shell contract (`AppShell` + chrome)

### A.1 Layout slots (locked)

```
AppShell
├── sidebar          # U12 core ≤12 + Advanced collapsed
├── header           # sticky h-11: breadcrumbs | cmdk | actions
├── banners          # Offline → org-syncing → auth; OnboardingBanner
├── main
│   ├── PageHeader   # max 1 identity row
│   └── ≤1 toolbar   # tabs + filters + views + overflow
├── mobileNav
├── commandPalette
└── aiRail           # ChatSidebar — moat
```

### A.2 Must / must not

| Rule | Contract |
|---|---|
| Single org switcher | Clerk in sidebar only; collapse-safe (monogram/compact) |
| Single Settings identity | Rail **or** PageHeader — never both (live: dual_title **N** — don’t regress) |
| Core nav | `CORE_NAV_ITEM_COUNT === 12` |
| Page vs shell | Shell sticky once; pages do not restack shell chrome |
| Hide chrome | Onboarding wizard only |

**Must not:** peer leaves in core; duplicate sticky titles; `min-h-screen` on portal pages.

### A.3 Resource page chrome budget

| Band | Allowed | Forbidden |
|---|---|---|
| Identity | One `PageHeader` | Second title, org Select |
| Toolbar | Tabs + filters + views + ≤5 primary actions + More | Facet chip runway; legacy tool strip; CrossLinkBar as peer band |
| Optional KPI | Thin severity/status only | Full widget wall in header |
| Content | Table ± detail | Nested page headers |
| Bulk | When selection > 0 | Always-visible bulk chrome |

**Traces today:** 3 bands — **non-compliant**. Target = Identity + Toolbar only.

### A.4 Declutter acceptance (shell)

- [ ] Collapsed sidebar still opens org context (no Settings detour).  
- [ ] No dual org / dual Settings title regression.  
- [ ] Worst-case main-column bands documented; page hubs ≤2 excluding shell sticky.  
- [ ] AI rail does not invent a second page title.  
- [ ] Banner `top-*` aligns with `h-11`.

---

## B. Traces hub contract (Laminar Observe)

### B.1 URL contract

```
/traces
  ?view=traces|spans|sessions
  &pastHours=24 | &from=&to=
  &q=... | &filter=...
  &viewId=...
  &traceId=...              # detail; list stays mounted
  &spanId=...
  &facet=...                # filter preset — NOT a chrome band
  &live=1
```

Legacy tool routes → Advanced/leaves/overflow — **never** hub tab siblings.

### B.2 Hub composition (≤2 bands)

```tsx
<ResourcePageShell
  header={<PageHeader eyebrow="Observe" title="Traces" actions={/* Live · Refresh · More */} />}
  toolbar={
    <>
      <Tabs /* traces | spans | sessions */ variant="underline" />
      <QueryFilterBar /* facets as chips inside */ />
      <ViewsMenu /* dirty amber */ />
      {/* DisplayMenu in More — P1 */}
    </>
  }
  table={<InfiniteDataTable />}
  detail={traceId ? <DetailPanelShell /> : null}
  bulkBar={selection.length ? <BulkActionBar /> : null}
/>
```

| Control | Placement |
|---|---|
| Traces / Spans / Sessions | Inside **toolbar** band (with filters) — not a separate band above filters |
| Filters / search | `QueryFilterBar` |
| Views | `ViewsMenu` |
| Live / Refresh | Header actions or toolbar — count toward ≤5 primary |
| Inspector / Replay / Debugger / Time-Travel / Query | **More** or detail CrossLinkBar |
| Facets | Chips / presets inside QueryFilterBar |

### B.3 Detail progressive disclosure

| Mode | Default? | Disclosure |
|---|---|---|
| Transcript | Yes | Full body |
| Tree | No | View-mode dropdown |
| Timeline | No | Toggle |
| Metadata | No | Toolbar button |
| Chat with trace | No | Toolbar / AI rail with span chips |
| Open in SQL | No | Trace overflow dropdown |

Subagents/tools: **collapsed cards** until expanded (Laminar transcript pattern).

### B.4 Master–detail

| Viewport | Behavior |
|---|---|
| ≥1280 | Split when `traceId` set |
| 768–1279 | Drawer/sheet |
| &lt;768 | Full-page detail OK |

**Forbidden:** Primary open navigates away from list hub.

### B.5 Declutter acceptance (traces)

- [ ] `band_count ≤ 2` (identity + one toolbar).  
- [ ] Facets do not add a third band.  
- [ ] Legacy tools only in More/detail.  
- [ ] Toolbar primary actions ≤5 visible.  
- [ ] Opening a row sets `traceId` without unmounting the table.  
- [ ] Transcript is default; Tree/Timeline/Metadata/SQL require an explicit detail control.  
- [ ] Clutter score drops ≥1 tier vs W1 baseline **2.5** (or WAIVE documented).  
- [ ] Hub tests assert band budget selectors.

---

## C. Table OS contract (Laminar table-views class)

### C.1 ViewState

```
ViewState = {
  resource: "traces" | "spans" | "sessions" | "issues" | "alerts" | …,
  filters: FilterState,
  search?: string,
  sort: { id: string, desc: boolean }[],
  columns: { id: string, visible: boolean, width?: number }[],
  density?: "comfortable" | "compact",
}
```

**Scoping:** Traces views never appear in Spans dropdown.

### C.2 Dirty / save / discard

| UI | Behavior |
|---|---|
| Amber dirty | Current ViewState ≠ active saved (filters **or** sort **or** columns) |
| Save / Save as / Discard | Laminar semantics |

### C.3 Filter modes (one toolbar slot)

| Mode | UX |
|---|---|
| Basic | Chip builder |
| Query | Single-line string (Langfuse-class) |
| Power | Link to SQL/Query leaf — **escape hatch**, new tab |

Basic ↔ Query lossless where possible. **Do not** add a permanent third-band filter sidebar on Eden hubs.

### C.4 Hide-first columns

Prefer: hide unused columns into the active view.  
Avoid: always-visible column-picker row that becomes band 3.

### C.5 Declutter acceptance (table OS)

- [ ] Dirty amber covers filters + sort + columns.  
- [ ] Save / Save as / Discard match Laminar.  
- [ ] No extra chrome band for column management (menu/overflow OK).  
- [ ] Issues + Alerts share `ResourceOsToolbar` + `ViewsMenu` path.  
- [ ] Empty: never-ingested vs no-matches + Clear filters.  
- [ ] No blank Suspense on resource hubs.

---

## D. Component checklist

| Component | Declutter touch |
|---|---|
| `ResourcePageShell` | Hard ≤2 bands |
| `QueryFilterBar` | Facets folded in; sticky OK |
| `ViewsMenu` | Full ViewState dirty |
| `DetailPanelShell` | Mode disclosure inside panel |
| `CrossLinkBar` | Detail/overflow only on hubs |
| `LiveTailPanel` | One toolbar control |
| `QueryState` | Default async wrapper |
| `Button` / `Tabs` | No snowflake CTAs/tablists |
| `ChatSidebar` | Span context without hub chrome |

---

## E. Non-goals

- Peer skins / light mode  
- Core nav >12  
- SQL Editor / Loop / render templates as chrome P0  
- Pixel-matching Laminar transcript spacing (use Eden tokens)

---

*End of w2-laminar-contracts (Wave 3 refresh).*
