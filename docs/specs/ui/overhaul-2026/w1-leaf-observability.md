<!-- Wave 1 Job 7 — w1-leaf-observability (read-only discovery, 2026-07-20). -->

# Job 7 — Observability leaves (Inspector · Replay · Time-Travel · Query · facets)

**Scope:** `/observability/*`, Inspector, Replay, Debugger (legacy), Time-Travel, Query.  
**Chrome band convention:** stacked identity / nav / filter rows *above* primary content (AppShell sidebar/topbar excluded).  
**Code refs:** `clients/portal/src/app/(portal)/{traces,inspector,replay,debugger,observability}/**`.

---

## 0. Competing-UI flag (Traces hub job, separate chrome)

These surfaces do the **same Observe job** as `/traces` (inspect one run, replay timeline, fork/replay state, DSL query, MCP/decision/memory/retrieval facets) but ship as **standalone `PageContent` + `PageHeader` + local toolbars** with their own title chrome (`eyebrow="Observe"`).

| Surface | Standalone chrome | Hub soft-nest | Competing? |
|---|---|---|---|
| Inspector | Full B-shell | `/traces?view=inspect` + `EmbeddedSurface` | **Yes** — dual title + own filter/view toggles |
| Replay | Full B-shell + StatCards + local tablist | `/traces?view=replay` | **Yes** — densest Observe leaf |
| Debugger (legacy) | Full B-shell + Cards | `/traces?view=debug` | **Yes** — distinct from Advanced `/debugger-sessions` |
| Query | Full B-shell + Cards + raw accent CTAs | `/traces?view=query` | **Yes** |
| Time-Travel | Full B-shell + stepper + Cards | `/traces?view=time-travel` | **Yes** |
| Facets mcp/decisions/memory/retrieval | Full B-shell each | `/traces?facet=…` | **Yes** when deep-linked (redirected; module still full-chrome capable) |
| Cohorts | Full B-shell | Redirect claims `/traces?view=cohorts` | **Broken nest** — hub does not register `cohorts` view (see §4) |

When mounted under Traces `EmbeddedSurface`, `PageHeader` hides title chrome (`page-header.tsx:30-56`) and `PageContent` drops outer padding — but **local toolbars / StatCards / nested tabs remain**, so embedded legacy views still feel like a second product inside the hub.

---

## 1. Traces hub shell (parent for embeds)

| Field | Evidence |
|---|---|
| File | `traces/page.tsx` |
| Layout | `PageContent size="wide"` + `ResourcePageShell` (`:722-784`) |
| Hub tabs | `HUB_VIEWS` = traces \| spans \| sessions (`:61`, TabsList `:471-486`) |
| Legacy views | `LEGACY_VIEWS` = inspect \| replay \| debug \| query \| time-travel (`:62`) |
| Facets | `FACET_VIEWS` = mcp \| decisions \| memory \| retrieval (`:63`) |
| Tools overflow | `LEGACY_TOOL_LINKS` in **More** dropdown (`:66-72`, `:574-603`) — *not* a third full band |
| Filter plane | `QueryFilterBar` + agent chip + `ViewsMenu` + Refresh in same toolbar row (`:464-605`) |
| Embeds | `EmbeddedSurface` wraps Inspect/Replay/Debug/Query/TimeTravel + facet pages (`:768-779`) |

### Band counts (Traces)

| Mode | Bands | Notes |
|---|---|---|
| Default list (traces/spans/sessions) | **2** | (1) PageHeader Observe/Traces `:726-730` · (2) tabs + QueryFilterBar + ViewsMenu + More `:464-605` |
| Facet mode | **2** | (1) PageHeader · (2) “← Traces · Facets” + facet chips `:733-762` (no QueryFilterBar) |
| Legacy view mode | **1** (+ child chrome suppressed) | Toolbar `undefined` when `isLegacyView` (`:733`); child PageHeader hidden via embed |

**Clutter notes:** List still stacks hub tabs *and* QueryFilterBar in one wrap row (`flex-wrap`, `:465`) — visually one band but high micro-control density. `SpanSearchBar` + `LiveTailPanel` add in-body chrome (`:685-704`). Prior W1 “triple band” inventory is **partially stale** after More-menu consolidation; remaining overload is **control count**, not three full identity rows.

---

## 2. Leaf inventory

### 2.1 `/observability` (landing — redirected)

| | |
|---|---|
| File | `observability/page.tsx` (~499 LOC) |
| Redirect | `next.config.ts:142` → `/traces`; also `HUB_REDIRECT_RULES` (`portal-hub-redirect.ts:32`) |
| Standalone bands | Would be **2** (PageHeader + KPI/subpage cards) — never reached in prod if redirects fire |
| Notes | Still contains `SUBPAGES` linking `/observability/cohorts` (`:66`) — dead for nav once redirect ships |

### 2.2 Inspector `/inspector` → `/traces?view=inspect`

| | |
|---|---|
| File | `inspector/page.tsx` (~454 LOC) |
| Redirect | `next.config.ts:145`; hub embed `traces/page.tsx:103-106,770` |
| Layout | B: `PageContent` + `PageHeader` eyebrow Observe (`:275-281`) |
| **Bands (standalone)** | **2** = Header + local toolbar (ID input, type filters, tree/transcript toggles) `:283-338` |
| Micro-controls | 5 type filter chips + 2 view-mode chips; raw accent selected state `:309,331` |
| Nested cards | Low (tree/transcript, not Card grid) |
| Competing-UI | Same job as Trace detail / transcript — separate “Trace Inspector” title |

### 2.3 Replay `/replay` → `/traces?view=replay`

| | |
|---|---|
| File | `replay/page.tsx` (~735 LOC) |
| Redirect | `next.config.ts:146`; also hub-redirect `defaultParams.view=replay` (`portal-hub-redirect.ts:30`) |
| Layout | B: PageHeader + picker + StatCard strip + `role="tablist"` timeline/events (`:277-377`) |
| **Bands (standalone)** | **3** = Header · session/trace picker chrome · StatCards + local tabs |
| Density | `text-[10px]`×9; StatCard×4; raw accent×2 |
| Competing-UI | Overlaps Traces detail + Time-Travel “replay” language |

### 2.4 Debugger (legacy) `/debugger` → `/traces?view=debug`

| | |
|---|---|
| File | `debugger/page.tsx` (~273 LOC) |
| Redirect | `next.config.ts:147` |
| **Bands** | **2** = Header + Card-wrapped filter/table |
| Competing-UI | Name collision with Advanced `/debugger-sessions` (KEEP leaf, different product) |

### 2.5 Query `/observability/query` → `/traces?view=query`

| | |
|---|---|
| File | `observability/query/page.tsx` (~635 LOC) |
| Redirect | `next.config.ts:148` |
| Layout | B wide; PageHeader `:289-290`; multi-Card ops (parse/lint/resolve/run + alerts) |
| **Bands** | **2** = Header + action Card stack (no hub tabs) |
| Clutter | Raw accent CTAs `:356,:505`; `text-[10px]`×5; still links to `/observability/cohorts` (`:362`) — redirect-hop |

### 2.6 Time-Travel `/observability/time-travel` → `/traces?view=time-travel`

| | |
|---|---|
| File | `observability/time-travel/page.tsx` (~457 LOC) |
| Redirect | `next.config.ts:155` + hub-redirect `:47-49` |
| Hub embed | `TimeTravelView` in LEGACY_VIEWS (`traces/page.tsx:62,119-122,774`) |
| Layout | B: PageHeader `:181-198` + info banner `:200-203` + stepper + record/fork/replay Cards |
| **Bands** | **3** = Header · info banner · stepper/forms |
| Density | Cards≈7; `text-[10px]`×5; known density hotspot (w1-density-grep score ~43) |
| Competing-UI | “Replay” naming vs Replay page |

### 2.7 Facets (soft-nested under Traces)

| Route | File | Redirect dest | LOC | Bands (standalone) | Clutter |
|---|---|---|---|---|---|
| `/observability/mcp` | `mcp/page.tsx` | `?facet=mcp` (`next.config.ts:151`) | ~313 | **2** Header + panels | micro×1 |
| `/observability/decisions` | `decisions/page.tsx` | `?facet=decisions` (`:152`) | ~293 | **2** + action Cards | raw accent×3 |
| `/observability/memory` | `memory/page.tsx` | `?facet=memory` (`:153`) | ~488 | **3** Header + underline Tabs + Card/DataTable stack | Cards≈9; TabsList; raw accent×4 |
| `/observability/retrieval` | `retrieval/page.tsx` | `?facet=retrieval` (`:154`) | ~493 | **3** same as memory | Cards≈9; TabsList |

Facet hub chrome when embedded: Traces facet chip band only (`traces/page.tsx:733-762`); nested leaf tabs (memory/retrieval) still show → **bands ≈ 2 hub + 1 nested tab = 3 effective**.

### 2.8 Cohorts `/observability/cohorts` → `/traces?view=cohorts` ⚠️

| | |
|---|---|
| File | `observability/cohorts/page.tsx` (~271 LOC) |
| Redirect | `next.config.ts:156`; `HUB_REDIRECT_RULES` (`portal-hub-redirect.ts:51-54`) |
| Hub embed | **MISSING** — `LEGACY_VIEWS` / `ALL_VIEWS` omit `cohorts` (`traces/page.tsx:61-64`); no `CohortsView` dynamic import |
| Behavior | `useQueryTab("view", ALL_VIEWS, "traces")` falls back invalid `view=cohorts` → **`traces`** (`use-query-tab.ts:15-16`) |
| **Bands (if page reached without redirect)** | **2** Header + SQL/result Cards |
| Status | **Redirect SHIPPED, soft-nest GAP** — users land on Traces list, not Columnar Engine |

### 2.9 Eval leaf `/observability/eval` → Evals hub

Redirect `next.config.ts:157` → `/evals?tab=eval`; embed in `evals/page.tsx` (not Traces). Out of Observe competing set but same filesystem family.

---

## 3. Band + clutter summary (Observe leaves)

| Surface | Standalone bands | Nested cards / tables | Micro / accent | Overwhelm tier |
|---|---|---|---|---|
| Traces hub (list) | 2 | LiveTail + SpanSearch + table | high filters | **P0 hub** |
| Replay | 3 | StatCards×4 + event list | 10px×9 | **P0 leaf** |
| Time-Travel | 3 | Cards×7 + stepper | 10px×5 | **P0 leaf** |
| Memory / Retrieval | 3 (w/ tabs) | Cards×9 + DataTable | accent CTAs | **P1** |
| Query | 2 | Cards×3 + alert list | accent×2 | **P1** |
| Inspector | 2 | tree/transcript | accent chips | **P1** |
| MCP / Decisions | 2 | panels/Cards | low–med | P2 |
| Cohorts | 2 (orphan) | Cards | low | **P0 nest bug** |

---

## 4. Gaps / follow-ups for Wave 4

1. **Embed CohortsView** under Traces (`view=cohorts`) or change redirect target — today redirect is a no-op soft-nest.  
2. Retire competing titles: Inspector / Replay / Time-Travel should inherit hub identity only (already partially via `EmbeddedSurface`).  
3. Fix in-app hrefs still pointing at redirect sources (`query/page.tsx:362` → `/observability/cohorts`; observability landing SUBPAGES).  
4. Memory/Retrieval nested tabs under facet mode create **effective 3-band** stack — collapse or move tabs into content.

**Evidence anchors:** `traces/page.tsx:61-138,464-779` · `portal-hub-redirect.ts:14-58` · `next.config.ts:128-157` · `proxy.ts:148-150` · `page-header.tsx:30-56` · `use-query-tab.ts:7-16`.
