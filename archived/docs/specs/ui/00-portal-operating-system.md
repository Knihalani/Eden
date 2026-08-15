# U00: Portal Operating System

| Field | Value |
|---|---|
| **Spec ID** | U00 |
| **Priority** | P0 |
| **Effort** | XL |
| **Eden status** | PARTIAL — DataTable + FilterBar exist; saved views / URL filters / split-pane OS missing |
| **Clone targets** | Laminar infinite-datatable + table-views; Braintrust Display/Filter/Views; Langfuse filter search bar; Helicone sidebar IA |
| **Dependencies** | F58 (saved views API), F48 (contracts) |
| **Primary code** | `clients/portal/src/components/ui/`, `sidebar-config.ts`, `layout.tsx` |

---

## 1. Summary

A shared **portal operating system** so every list surface (Traces, Issues, Alerts, Datasets, Experiments, Artifacts, Signals) behaves the same: filter → view → select → act → open detail. Without this, cloning Laminar/Braintrust UI page-by-page creates inconsistent UX debt.

---

## 2. Eden current state

| Component | Path | Gap |
|---|---|---|
| `DataTable` | `clients/portal/src/components/ui/` | No column picker persistence, weak virtualization |
| `FilterBar` | `clients/portal/src/components/ui/filter-bar.tsx` | Barely adopted |
| Page chrome | `PageHeader` + `PageContent` | Consistent but not dense enough |
| Sidebar | `sidebar-config.ts` | Too many Advanced items still feel first-class |
| Saved searches | Phase N backend | **Zero portal wiring** |
| Trace detail | `/traces` → navigates away | Breaks Laminar master–detail pattern |

---

## 3. Layout chrome (every resource page)

```
┌─ Sidebar (U12) ─┬─ PageHeader: title · resource tabs · time range · Live ▾ ─┐
│                 ├─ Toolbar: FilterBar · Views ▾ · Display ▾ · Actions        │
│                 ├─ Optional KPI strip (resource-specific)                   │
│                 ├─────────────────────┬─────────────────────────────────────┤
│                 │  Infinite table     │  Detail panel (optional)            │
│                 │  (virtualized)      │  resizable 360–720px                │
│                 └─────────────────────┴─────────────────────────────────────┘
│                 └─ Bulk action bar (appears when selection > 0) ─────────────┘
└─ ChatSidebar / Copilot (U16) — bottom-right, context-aware ──────────────────┘
```

**Breakpoints**
- `≥1280px`: split pane default when `?id=` set
- `768–1279`: detail becomes slide-over drawer
- `<768`: full-page detail route (keep deep links)

---

## 4. Table OS contracts

### 4.1 Columns
- Resize, reorder, show/hide
- Persist per `(org_id, user_id, resource, view_id)`
- Custom SQL/EQL expression columns (F58) — optional advanced

### 4.2 Selection
- Checkbox column; Shift-click range; `⌘A` select page
- Bulk actions registry per resource (see §6)

### 4.3 Sorting & pagination
- Server-side sort on indexed columns only
- Cursor or keyset pagination (no offset past 10k)
- Virtualized rows for ≥200 visible

### 4.4 Density
- Display menu: Comfortable | Compact (default Compact for Observe)

---

## 5. FilterBar (Langfuse-class)

### 5.1 Modes
1. **Basic** — chip builder: field · op · value with autocomplete
2. **Query** — typed string `latency:>2 agent:support scores.accuracy:<0.8`
3. **SQL/EQL** — power mode (resource-dependent)

### 5.2 Behaviors
- Filters serialize to URL `?filter=` (JSON) or `?q=` (query string)
- Undo/redo filter edits (Laminar advanced-search pattern)
- Suggestions + Recent (Braintrust)
- “Create alert from filters” (U04 / F81)
- “Save as view” dirty amber indicator when diverged from saved view

### 5.3 Time range
- Presets: 15m, 1h, 6h, 24h, 7d, 30d, Custom
- Live toggle (SSE) when resource supports N11

---

## 6. Bulk actions registry

| Resource | Actions |
|---|---|
| Traces | Tag, Add to dataset, Add to labeling queue, Score, Open in playground, Create issue, Export |
| Issues | Assign, Snooze, Resolve, Link experiment, Create artifact |
| Alerts | Ack, Silence, Mark benign, Escalate |
| Datasets | Tag, Add to playground, Run experiment |
| Artifacts | Promote, Archive, Export YAML |

Toolbar appears sticky bottom when `selection.length > 0`.

---

## 7. Views system (pairs with F58)

```
Views ▾
  ★ Default
  ── Personal ──
  Errors only
  My unreviewed
  ── Project ──
  On-call P0
  Cost outliers
  [Save] [Save as…] [Discard changes]
```

- Dirty state amber on Views button when filters/columns/sort diverge
- Defaults hierarchy: personal → project → org → built-in
- Permissions: members create personal; admins publish project views

---

## 8. Detail panel OS

Shared shell for Trace, Issue, Alert, Artifact, Experiment row:

| Zone | Content |
|---|---|
| Header | ID, status chips, copy link, fullscreen, close |
| Tabs | resource-specific (e.g. Transcript \| Tree \| Timeline \| Metadata) |
| Body | scrollable; lazy payload fetch for large JSON |
| Footer actions | primary CTA + overflow ⋯ |

Keyboard: `j/k` next/prev row while panel open; `Esc` close; `f` fullscreen.

---

## 9. Empty / error / loading states

| State | Pattern |
|---|---|
| Empty (no data ever) | Illustration + one CTA teaching the loop (connect SDK / send first trace) |
| Empty (filters) | “No matches” + Clear filters + Save as alert |
| Error | Inline ErrorState + retry; never blank page |
| Loading | Skeleton matching table density (not full-page spinner) |

---

## 10. Component inventory to build

```
clients/portal/src/components/portal-os/
  ResourcePageShell.tsx
  FilterBar/          # basic + query + eql modes
  ViewsMenu.tsx
  DisplayMenu.tsx
  TimeRangePicker.tsx
  BulkActionBar.tsx
  DetailPanelShell.tsx
  InfiniteDataTable.tsx   # wraps/extends DataTable
  useResourceUrlState.ts  # sync filter/view/id/time to URL
  useSavedViews.ts
```

---

## 11. Acceptance criteria

- [ ] Traces, Issues, Alerts, Datasets all use `ResourcePageShell`
- [ ] Filter state survives refresh via URL
- [ ] Saved view round-trips filters + columns + sort
- [ ] Detail panel opens without full navigation on desktop
- [ ] Keyboard prev/next works on Traces and Issues
- [ ] Core nav ≤12 items after U12

---

## 12. Performance & cost

| Operation | p50 | p95 |
|---|---|---|
| Table first paint | <300ms | <800ms |
| Filter apply (indexed) | <100ms | <400ms |
| Open detail panel | <200ms | <600ms |
| Saved views list | <50ms | <150ms (Redis) |

No LLM in table OS path. Metric: `eden_portal_table_query_seconds`.
