# Wave 3 — Competitor Pattern Library (calm chrome · progressive disclosure)

**Status:** Wave 3 exit — refreshed 2026-07-20 (10-wave plan `w3-pattern-library`)  
**Prior:** Wave 2 competitive synthesis (same filename; content superseded below)  
**Primary peer:** [Laminar](https://laminar.sh) (OSS: [lmnr-ai/lmnr](https://github.com/lmnr-ai/lmnr))  
**Secondary peers:** Langfuse, Phoenix, Braintrust, LangSmith, Weave, Helicone  
**Eden baseline (live):** [`w1-consolidated-inventory.md`](./w1-consolidated-inventory.md) — Top-20 clutter, Traces **3 bands**, Wave 2 systems append  
**Gap matrix:** [`w2-gap-matrix.md`](./w2-gap-matrix.md)  
**Contracts:** [`w2-laminar-contracts.md`](./w2-laminar-contracts.md)

**Rule:** Clone **interaction grammar**, not skins. Steal **hide / overflow / band-budget** first. Keep Eden dark-terminal, U12 ≤12 core, AI rail, Improve loop.

---

## 0. How to use this doc

1. **§1 Declutter steal-list (P0)** — hide/overflow/band-budget — Waves 5–6 start here.  
2. **§2 Table / detail / filter (P0 continued)** — after chrome collapses.  
3. **§3 P1 / §4 P2** — only if unblocking P0.  
4. **§5 Anti-patterns** — hard reject.  
5. **§6 Mapping** — peer → Eden component.

**Wave 3 doctrine:** A pattern that adds features but increases simultaneous chrome **fails**. Power stays; visibility is progressive.

---

## 1. P0 steal-list — hide / overflow / band-budget (ship first)

### P0-1 — Band budget ≤2 (collapse Traces triple stack)

| Field | Detail |
|---|---|
| **Name** | One identity + one toolbar |
| **How peers do it** | **Laminar:** Traces\|Spans\|Sessions tabs + **one** table toolbar (search, filters, views, Live, columns) — modes live **inside** the detail toolbar (Transcript/Tree/Timeline), not as hub bands. **Braintrust Logs:** Display · Filter · Views as **one** chrome grammar. **Helicone Requests:** list + filter + drawer — no competing title rows. |
| **Eden gap (W1/W2 live)** | Traces = **3 bands** (PageHeader + hub Tabs + QueryFilterBar OS). Facets/legacy already in **More** (partial win) but `band_count` still **FAIL ≤2**. Clutter score **2.5**; archetype #1 on Top-20. Alerts/Agents/Issues still **4–5** bands. |
| **Steal move** | **Hide:** fold Tabs into the single toolbar band (or merge identity+tabs if height allows). Cap hub chrome at Identity + Toolbar. KPI strips only when thin and resource-required. |
| **Eden mapping** | `ResourcePageShell` hard-code ≤2 page bands · `PageHeader` · one `toolbar` slot with `Tabs` + `QueryFilterBar` + `ViewsMenu` + Live/Refresh/More. |

### P0-2 — Overflow menu for secondary tools (progressive disclosure)

| Field | Detail |
|---|---|
| **Name** | Power in ⋯ / More / detail — never peer chrome |
| **How peers do it** | **Laminar:** SQL Editor, Chat with trace, Metadata, Timeline toggle sit in **trace view toolbar / Trace dropdown** — not on the list tab row. **LangSmith:** Filter Shortcuts in a **sidebar panel**, not a third header band. **Braintrust:** Display menu hides columns/layout/row-type. |
| **Eden gap** | Legacy Inspector/Replay/Debugger/Time-Travel/Query historically competed on tab row; now in More — **keep them there**. CrossLinkBars on Agents/Improve still add bands. Studio/Guardrails pack controls into peer rows. |
| **Steal move** | **Overflow policy:** ≤5 primary toolbar actions visible; rest → `DropdownMenu` / detail `CrossLinkBar`. Facets = filter presets (`?facet=`), never a chip runway band. |
| **Eden mapping** | Toolbar `More` · detail `CrossLinkBar` · `ViewsMenu` · future `DisplayMenu`. |

### P0-3 — One identity signal (no dual titles / dual org)

| Field | Detail |
|---|---|
| **Name** | Title once · org once |
| **How peers do it** | Laminar/Stripe: settings is one leaf + tabs; org/project switcher lives in **shell**. |
| **Eden gap (live)** | Settings `dual_title` = **N** (fixed). Org Select removed. Remaining Settings overload = **19-tab / 6-group rail** (Helicone lesson: ~9–10 tabs). Collapse-safe org when sidebar collapsed still a shell concern if not fully landed. |
| **Steal move** | Keep single identity. **Hide** Advanced Settings groups by default. Cap visible Settings rail groups. |
| **Eden mapping** | `AppShell` org only · Settings rail collapse Advanced · no page title echo. |

### P0-4 — Progressive disclosure inside detail (not hub)

| Field | Detail |
|---|---|
| **Name** | Transcript-first; Tree/Timeline/Metadata one click away |
| **How peers do it** | **Laminar Viewing Traces:** Transcript default; Tree via view-mode **dropdown**; Timeline = **toggle**; Metadata / Chat = toolbar buttons; SQL = Trace dropdown. Subagents = **collapsed cards** until expanded. |
| **Eden gap** | `TranscriptView` densest instrument (tokenizeize, don’t undensify). Mode switching not consistently one detail toolbar. Hub chrome still competes for attention. Card-nest depth ~5 on Observe path (W2). |
| **Steal move** | **Hide** Tree/Timeline/Metadata/SQL behind detail controls. Collapse subagent/tool cards by default. Flatten nested borders. |
| **Eden mapping** | `DetailPanelShell` + `ui/tabs` or view-mode dropdown · `TranscriptView` / transcript-v2 · no hub mode toggles. |

### P0-5 — Filter OS without a third band

| Field | Detail |
|---|---|
| **Name** | Dual editor, one toolbar slot |
| **How peers do it** | **Langfuse Filter Search Bar:** query string ↔ sidebar filters, **one shared state**, URL-serializable; Saved Views stay compatible. Time range sits **beside** the bar — not a new page band. **Laminar:** full-text + filters in the **same** table toolbar. |
| **Eden gap** | `QueryFilterBar` is already band 3 under tabs. Facets previously duplicated filters. Evals hub lacks filter OS. |
| **Steal move** | Keep dual editor **inside** the single toolbar. Do **not** add a Langfuse-style permanent left filter rail on Eden hubs (layout can stay toolbar). |
| **Eden mapping** | `QueryFilterBar` basic\|query · `useResourceUrlState` · facets as chips **inside** bar. |

### P0-6 — Table views OS (hide columns via views, not extra chrome)

| Field | Detail |
|---|---|
| **Name** | Named views = filters + search + sort + **column layout** |
| **How peers do it** | **Laminar Table views:** amber dirty · Save / Save as / Discard; scoped per table (Traces ≠ Spans). Columns you don’t need are **hidden into the view**, not shown as always-on chrome. **Braintrust:** Display + Views + personal/project/org defaults. |
| **Eden gap** | `ViewsMenu` + dirty trigger exist; column+sort+filter bundle incomplete; Display menu missing; not universal on Issues/Alerts. |
| **Steal move** | Prefer **hiding columns in views** over adding column-picker chrome rows. Dirty amber must cover full ViewState. |
| **Eden mapping** | `ViewsMenu` / `useSavedViews` · `InfiniteDataTable` column APIs · optional `DisplayMenu` (P1) inside toolbar overflow. |

### P0-7 — Master–detail without navigate-away

| Field | Detail |
|---|---|
| **Name** | List stays mounted |
| **How peers do it** | Laminar/Braintrust/Helicone: row → side panel / drawer; Esc clears. |
| **Eden gap** | `DetailPanelShell` + `?traceId=` present; contract uneven across hubs. |
| **Steal move** | Primary open never replaces hub. Deep links redirect into hub+panel. |
| **Eden mapping** | `ResourcePageShell` `detail=` · URL id params. |

### P0-8 — Empty / loading that don’t flash chaos

| Field | Detail |
|---|---|
| **Name** | State stack |
| **How peers do it** | Distinguish never-ingested vs filter-empty vs error+retry; skeletons match table. |
| **Eden gap (W2)** | QueryState ×**6**; `fallback={null}` ×**2** (down from 7). Settings uses `SettingsLoading`. Dual Skeleton systems remain. |
| **Steal move** | Default async = `QueryState`. Never blank Suspense on hubs. |
| **Eden mapping** | `QueryState` · `EmptyState` · `ErrorState` · `LoadingSkeleton variant="table"`. |

### P0-9 — Cap simultaneous noise (CTA · KPI · Settings groups)

| Field | Detail |
|---|---|
| **Name** | Numeric caps from anti-clutter doctrine |
| **How peers do it** | Helicone lean Settings (~9–10 tabs). Braintrust Display hides layout options. Datadog: overview KPIs breathe; analysis densifies **in content**. |
| **Eden gap** | Top clutter: Artifacts **6.5**, Alerts **5.5**, Audit **5.0**. Settings 19 visible tabs. Home KPIs OK (Dashboard 0.0) but other hubs over-chip. |
| **Steal move** | Toolbar primary ≤**5**; hub KPI 5–7 desktop / 3–4 mobile; Settings Advanced **collapsed**; CrossLinkBars → overflow on hubs. |
| **Eden mapping** | Lint/acceptance gates (Wave 5+) · `ResourceOsToolbar` · Settings IA groups. |

### P0-10 — Role density (calm chrome / dense instruments)

| Field | Detail |
|---|---|
| **Name** | Overview breathes; analysis densifies via tokens |
| **How peers do it** | Datadog/Linear: calm shell; dense trace/span panels. Laminar: micro-density **inside** transcript/tree, not in project header. |
| **Eden gap (W2)** | Crowding TOP-5 includes `portal-chrome`, guardrails, alerts (wrong-role hub micro-type) **and** TranscriptView (tokenize). Micro **371** / half-step **301**. |
| **Steal move** | Ban casual `text-[9–11px]` on shell/hub chrome. Instrument micro only via `--font-size-2xs/3xs`. |
| **Eden mapping** | `globals.css` tokens · density lint · TranscriptView tokenize program. |

---

## 2. P0 continued — table / filter depth (after bands collapse)

| ID | Name | Peer | Eden steal |
|---|---|---|---|
| P0-T1 | Infinite virtualized table | Laminar `InfiniteDataTable` | Adopt on Observe core; don’t invent per-page tables |
| P0-T2 | URL ↔ filters ↔ views | Langfuse + Laminar | Shareable `?q=`/`?filter=`/`?viewId=` |
| P0-T3 | Canonical hub Tabs | All peers | `ui/tabs` already on core hubs — finish leaves; no hand-rolled tablists |
| P0-T4 | Button / CTA one system | Linear/Stripe | Purge raw accent CTAs (~28 lines; ratchet 25) |

---

## 3. P1 steal-list

| ID | Name | Peer cue | Eden note |
|---|---|---|---|
| P1-1 | Display menu (columns · density · row type) | Braintrust Display | Inside toolbar overflow — **not** a new band |
| P1-2 | Live tail as one control | Laminar Live / Helicone feed | Toolbar Live ▾ → `LiveTailPanel`; never a band |
| P1-3 | Chat-with-trace citations | Laminar span chips | Wire AI rail when `?traceId=` — keep rail moat |
| P1-4 | Bulk bar from selection | Laminar/Braintrust | Sticky bottom only when selection > 0 |
| P1-5 | CrossLink overflow everywhere | Peers: related in ⋯ | Kill hub CrossLinkBar bands (Agents/Improve) |
| P1-6 | Evals progressive tabs | Laminar eval groups | Keep mega-hub; filter OS without third band |
| P1-7 | Settings tab collapse | Helicone ~9–10 | Group + collapse Advanced |
| P1-8 | Phoenix in-tree search | Quiet search replaces loud header | Detail tree search, not hub chrome |

---

## 4. P2 steal-list

| ID | Name | Note |
|---|---|---|
| P2-1 | Laminar SQL Editor depth | Escape hatch only; not P0 chrome |
| P2-2 | Render templates / Loop custom views | Product moat features ≠ chrome |
| P2-3 | Defaults hierarchy personal→project→org | After dirty/save solid |
| P2-4 | Langfuse permanent filter sidebar | Contract yes; Eden layout stays toolbar |
| P2-5 | Sessions analytics extras | Sessions tab already |
| P2-6 | Filter undo/redo | Nice-to-have |

---

## 5. Anti-patterns (do not steal)

| Anti-pattern | Why |
|---|---|
| Competitor skins / light themes / purple glow | Brand moat is dark-terminal |
| Expanding core nav >12 | U12 hard cap |
| Third+ chrome bands | Primary user complaint |
| Navigate-away as primary detail | Breaks master–detail |
| Blank Suspense | Confusion flash |
| Page-by-page peer clones | Inconsistent OS debt |
| Cloning Braintrust Loop / Laminar Agent as chrome requirements | Out of Wave 3–6 chrome scope |
| “Declutter” by deleting Improve/governance | Moat keep |
| Packing more controls into header to “match feature parity” | Fails band budget |

---

## 6. Mapping — peer pattern → Eden components

| Peer pattern | Eden component(s) |
|---|---|
| ≤2 chrome bands | `ResourcePageShell`, `PageHeader`, single `toolbar` |
| Overflow / More | `DropdownMenu`, detail `CrossLinkBar` |
| Hub tabs | `ui/tabs` |
| Filters + search | `QueryFilterBar`, `FilterBar`, `useResourceUrlState` |
| Saved views | `ViewsMenu`, `useSavedViews` |
| Columns hide via views | `InfiniteDataTable` + view payload |
| Master–detail | `DetailPanelShell` |
| Transcript-first | `TranscriptView`, transcript-v2 |
| States | `QueryState`, `EmptyState`, `ErrorState`, `LoadingSkeleton` |
| Shell org | `portal-chrome` Clerk switcher |
| AI rail | `ChatSidebar` (moat) |
| CTAs | `Button` |

---

## 7. Top steal-list for declutter (executive)

Ordered by impact on W1 Top-20 / Traces archetype:

1. **Collapse Traces to ≤2 bands** (tabs inside toolbar or merge identity).  
2. **Overflow everything non-primary** (legacy, facets-as-presets, CrossLinks, SQL, Live extras).  
3. **Views hide columns** — don’t add chrome rows for column pickers.  
4. **Cap toolbar ≤5 primary / KPI ≤7 / Settings Advanced collapsed**.  
5. **Detail progressive disclosure** — Transcript default; Tree/Timeline/Metadata/SQL hidden until asked.  
6. **QueryState + no blank flash** on remaining hubs.  
7. **Calm shell / hub type** — tokenize instrument density; stop micro-typing chrome.  
8. **Satellite hubs copy Trace grammar** (Alerts/Agents/Issues band collapse).

---

## 8. Research index (Wave 3 jobs)

| Job | Artifact |
|---|---|
| `w3-laminar-shell` | [`w2-laminar-shell-oss.md`](./w2-laminar-shell-oss.md) |
| `w3-laminar-traces` | [`w2-laminar-traces-oss.md`](./w2-laminar-traces-oss.md) |
| `w3-laminar-table` | [`w2-laminar-table-os.md`](./w2-laminar-table-os.md) |
| `w3-laminar-states` | [`w2-laminar-empty-loading.md`](./w2-laminar-empty-loading.md) |
| `w3-laminar-contracts` | [`w2-laminar-contracts.md`](./w2-laminar-contracts.md) |
| `w3-langfuse` | [`w2-langfuse-patterns.md`](./w2-langfuse-patterns.md) |
| `w3-phoenix` | [`w2-phoenix-patterns.md`](./w2-phoenix-patterns.md) |
| `w3-braintrust` | [`w2-braintrust-patterns.md`](./w2-braintrust-patterns.md) |
| `w3-langsmith-weave` | [`w2-langsmith-weave.md`](./w2-langsmith-weave.md) |
| `w3-helicone` | [`w2-helicone-ia.md`](./w2-helicone-ia.md) |
| `w3-gap-matrix` | [`w2-gap-matrix.md`](./w2-gap-matrix.md) |
| `w3-pattern-library` | this file |

Wave 4 (separate) owns Design Brief / hierarchy / anti-clutter contract synthesis — do not fork ticket IDs here.

---

## 9. Wave 3 exit

- [x] Pattern Library prioritizes **hide/overflow/band-budget** as P0 (not P2 polish)  
- [x] Eden gaps re-baselined to W1 Top-20 + W2 systems (Traces still 3 bands; Settings dual-title fixed)  
- [x] Peer docs refreshed with calm chrome / progressive disclosure  
- [x] Laminar contracts carry **declutter acceptance lines**  
- [x] **No product UI code**

*End of w2-competitor-pattern-library (Wave 3 refresh).*
