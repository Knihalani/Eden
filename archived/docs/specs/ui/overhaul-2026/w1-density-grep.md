<!-- Wave 2 agent `w2-density-grep` — refresh of Wave 1 density artifact (anti-clutter doctrine). -->

# Density / crowding recount — `clients/portal/src` (Wave 2 refresh)

**Scope:** 512 source files (`.tsx/.ts/.jsx/.js/.css`, excluding `__tests__` / `*.test.*`)  
**Date:** 2026-07-20 (Wave 2 systems discovery)  
**Plan agent:** `w2-density-grep` → this file  
**Doctrine:** Crowding = micro-type + half-step spacing + `gap-1` packing + stacked chrome. **Chrome crowding is worse than instrument crowding.**

### Crowding score weights (Wave 2)

| Family | Patterns | Weight |
|---|---|---:|
| Extreme micro | `text-[8px]`, `text-[9px]` | ×4 |
| Micro | `text-[10px]` | ×3 |
| Near-micro | `text-[11px]` | ×2 |
| Half-step pack | `gap-0.5`, `p-0.5`, `px-0.5`, `space-y-0.5` | ×3 |
| Half-step pad | `py-0.5`, `mt-0.5`, `mb-0.5`, `pt/pb-0.5` | ×2 |
| Gap-1 packing | `gap-1`, `space-y-1` | ×2 |
| Soft pack | `gap-1.5`, `p-1` | ×1 |
| Touch-hostile rows | `h-5` | ×2 |
| Compact rows | `h-6` | ×1 |
| Collapsed leading | `leading-none` (+3 if same line as micro) | ×1 / ×3 |

Paths below are relative to `/Users/kaiavnihalani/Downloads/Eden/clients/portal/src/`.

---

## 1. Aggregate counts per pattern

| Pattern | Files | Hits |
|---|---:|---:|
| `text-[8px]` | 1 | **1** |
| `text-[9px]` | 4 | **5** |
| `text-[10px]` | 81 | **251** |
| `text-[11px]` | 49 | **114** |
| **Micro-text family (8+9+10+11)** | **102** | **371** |
| `gap-0.5` | 15 | **17** |
| `p-0.5` | 11 | **12** |
| `px-0.5` | 0 | **0** |
| `py-0.5` | 74 | **147** |
| `space-y-0.5` | 6 | **7** |
| `mt-0.5` | 59 | **101** |
| `mb-0.5` | 6 | **13** |
| `ml-0.5` / `mr-0.5` | 1 / 1 | 1 / 1 |
| `pt-0.5` / `pb-0.5` | 1 / 1 | 1 / 1 |
| `mx-0.5` / `my-0.5` / `pl-0.5` / `pr-0.5` | 0 | **0** |
| **Half-step family** | **121** | **301** |
| `gap-1` | 92 | **166** |
| `gap-1.5` | 58 | **101** |
| `p-1` (exact token) | 29 | **42** |
| `space-y-1` | 33 | **52** |
| **Gap-1 packing family** | **150** | **361** |
| `leading-none` | 3 | **3** |
| `leading-none` + micro (same line) | 0 | **0** |
| `h-5` | 65 | **121** |
| `h-6` | 39 | **54** |
| **Touch-hostile / compact rows (`h-5`+`h-6`)** | — | **175** |
| Files with ≥1 crowding hit | **220** | — |

**Only `text-[8px]` hit:** `app/(marketing)/_components/Pillars.tsx` (decorative step index).

**Dominant drivers:** `text-[10px]` (251) + `gap-1` (166) + `py-0.5` (147) + `mt-0.5` (101) + `h-5` (121).

---

## 2. Top-40 crowding hotspots

Ranked by Wave 2 crowding score (micro + half-step + gap-1 packing + compact row heights).

| # | Score | Hits | Micro | Half | Gap1 | h5/h6 | Class | File | Why crowded |
|---:|---:|---:|---:|---:|---:|---:|---|---|---|
| 1 | **126** | 53 | 27 | 8 | 17 | 1 | instrument | `components/observability/TranscriptView.tsx` | `10px`×21 + `9px`×2 + `space-y-1`×7 + half pads; densest analysis surface |
| 2 | **89** | 38 | 14 | 17 | 6 | 1 | **hub (wrong role)** | `app/(portal)/guardrails/page.tsx` | `10px`×14 + `py-0.5`×9 + `mt-0.5`×8 — instrument skin on hub |
| 3 | **79** | 40 | 6 | 14 | 13 | **7** | **shell/hub-chrome** | `app/(portal)/portal-chrome.tsx` | Stacked chrome: `h-5`×5, `mt-0.5`×7, `gap-1.5`×7, micro nav meta |
| 4 | **74** | 31 | 16 | 6 | 9 | 0 | **hub (wrong role)** | `app/(portal)/alerts/page.tsx` | `10px`×15 + `gap-1`×6 + `py-0.5`×4 |
| 5 | **67** | 25 | 23 | 0 | 2 | 0 | overview-adjacent | `components/ai-insights/ApprovalCard.tsx` | Pure micro stack: `10px`×17 + `11px`×6 |
| 6 | **53** | 25 | 13 | 3 | 7 | 2 | instrument | `app/(portal)/replay/page.tsx` | Micro + gap packing + `h-6`×2 |
| 7 | **48** | 19 | 10 | 6 | 3 | 0 | **hub (wrong role)** | `app/(portal)/fleet/page.tsx` | `10px`×10 + `py-0.5`×5 + `gap-0.5` |
| 8 | **46** | 21 | 7 | 9 | 5 | 0 | hub/leaf | `app/(portal)/studio/page.tsx` | `py-0.5`×4 + `mb-0.5`×5 + micro |
| 9 | **42** | 20 | 13 | 4 | 3 | 0 | instrument | `app/(portal)/observability/query/page.tsx` | `11px`×8 + `10px`×5 |
| 10 | **42** | 20 | 4 | 4 | 7 | 5 | settings | `app/(portal)/settings/_components/autonomous-tab.tsx` | `space-y-1`×7 + `h-5`×5 + `mt-0.5`×4 |
| 11 | **37** | 17 | 11 | 3 | 2 | 1 | instrument | `app/(portal)/observability/time-travel/page.tsx` | `11px`×6 + `10px`×5 |
| 12 | **35** | 14 | 6 | 3 | 2 | 3 | other | `app/(portal)/optimization/model-advisor/page.tsx` | Micro + `gap-0.5` + `h-5`×3 |
| 13 | **34** | 15 | 6 | 5 | 4 | 0 | other | `app/(portal)/issues/[id]/page.tsx` | `py-0.5`×4 + micro mix |
| 14 | **33** | 14 | 5 | 4 | 4 | 1 | instrument | `components/traces/TraceDetailPanel.tsx` | Panel micro + half pad |
| 15 | **31** | 14 | 8 | 3 | 3 | 0 | marketing | `app/(marketing)/_components/TracesExplorerMock.tsx` | Mock explorer micro + `gap-0.5`×2 |
| 16 | **30** | 12 | 6 | 2 | 4 | 0 | instrument | `components/transcript-v2/ParallelToolLane.tsx` | `10px`×6 + `gap-1`×4 |
| 17 | **28** | 13 | 5 | 3 | 5 | 0 | instrument | `app/(portal)/observability/_components/SelectedTraceCard.tsx` | Micro card + gap pack |
| 18 | **27** | 14 | 1 | 6 | 6 | 1 | primitive | `components/ui/status-badge.tsx` | `py-0.5`×6 + `gap-1`×4 (propagates density) |
| 19 | **25** | 12 | 6 | 2 | 4 | 0 | marketing | `app/(marketing)/status/page.tsx` | Micro status chrome |
| 20 | **25** | 12 | 2 | 1 | 9 | 0 | **shell/hub-chrome** | `app/(portal)/settings/_components/sidebar-settings-view.tsx` | `gap-1`/`space-y-1` pack + `9px` |
| 21 | **24** | 11 | 10 | 0 | 1 | 0 | instrument | `app/(portal)/traces/_components/SpanSearchBar.tsx` | `11px`×8 + `10px`×2 |
| 22 | **23** | 14 | 4 | 0 | 8 | 2 | instrument | `components/ai/ai-chart-renderer.tsx` | `p-1`×7 packing |
| 23 | **23** | 12 | 3 | 2 | 5 | 2 | hub | `app/(portal)/agents/page.tsx` | Gap pack + `h-5` |
| 24 | **23** | 11 | 2 | 7 | 2 | 0 | hub | `app/(portal)/insights/page.tsx` | `py-0.5`×7 |
| 25 | **22** | 13 | 0 | 1 | 5 | **7** | settings | `app/(portal)/settings/_components/security-tab.tsx` | Touch-hostile: `h-5`×4 + `h-6`×3 |
| 26 | **22** | 12 | 0 | 6 | 0 | 6 | settings | `app/(portal)/settings/_components/scim-tab.tsx` | `py-0.5`×5 + `h-5`/`h-6` |
| 27 | **22** | 11 | 6 | 0 | 5 | 0 | marketing | `app/(marketing)/_components/MarketingFooter.tsx` | `11px`×5 + `gap-1` |
| 28 | **22** | 10 | 3 | 0 | 7 | 0 | leaf | `app/(portal)/agents/[id]/page.tsx` | `gap-1`×6 |
| 29 | **21** | 9 | 4 | 2 | 3 | 0 | other | `components/ai-insights/MessageList.tsx` | Micro list density |
| 30 | **21** | 9 | 3 | 3 | 3 | 0 | instrument | `components/observability/JobGantt.tsx` | Half + gap pack |
| 31 | **20** | 11 | 1 | 4 | 3 | 3 | settings | `app/(portal)/settings/_components/retention-policy-tab.tsx` | `mt-0.5` + compact rows |
| 32 | **19** | 9 | 5 | 2 | 2 | 0 | hub | `app/(portal)/improve/page.tsx` | `11px`×4 |
| 33 | **19** | 9 | 1 | 1 | 4 | 3 | instrument | `app/(portal)/inspector/page.tsx` | `gap-1`×4 + `h-5`×3 |
| 34 | **19** | 9 | 2 | 2 | 5 | 0 | instrument | `app/(portal)/observability/_components/TracesTab.tsx` | Gap pack + `gap-0.5` |
| 35 | **19** | 8 | 4 | 0 | 4 | 0 | instrument | `app/(portal)/observability/ScoresTab.tsx` | Micro + `gap-1` |
| 36 | **18** | 10 | 0 | 4 | 1 | 5 | settings | `app/(portal)/settings/_components/pii-policy-tab.tsx` | `mt-0.5`×4 + `h-5`/`h-6` |
| 37 | **18** | 9 | 0 | 0 | 4 | 5 | other | `app/(portal)/profile/page.tsx` | `h-5`×5 packing |
| 38 | **18** | 9 | 1 | 6 | 1 | 1 | other | `app/(portal)/prompts/page.tsx` | `py-0.5`×5 |
| 39 | **18** | 7 | 2 | 4 | 1 | 0 | instrument | `app/(portal)/analytics/page.tsx` | Half-step mix |
| 40 | **18** | 7 | 6 | 0 | 1 | 0 | other | `components/ai-insights/ToolCallCard.tsx` | `10px`×4 + `11px`×2 |

### Per-hotspot pattern breakdown (Top 10)

| File | 8/9px | 10px | 11px | gap-0.5 | gap-1 | gap-1.5 | py-0.5 | mt/mb-0.5 | space-y-1 | p-1 | h-5 | h-6 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| TranscriptView | 2 | 21 | 4 | 0 | 4 | 5 | 3 | 4 | 7 | 1 | 1 | 0 |
| guardrails | 0 | 14 | 0 | 0 | 4 | 1 | 9 | 8 | 1 | 0 | 1 | 0 |
| portal-chrome | 1 | 5 | 0 | 0 | 3 | 7 | 3 | 7 | 1 | 2 | **5** | **2** |
| alerts | 0 | 15 | 1 | 0 | 6 | 1 | 4 | 2 | 0 | 2 | 0 | 0 |
| ApprovalCard | 0 | 17 | 6 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| replay | 0 | 9 | 4 | 0 | 2 | 3 | 1 | 2 | 1 | 1 | 0 | 2 |
| fleet | 0 | 10 | 0 | 1 | 2 | 0 | 5 | 0 | 0 | 1 | 0 | 0 |
| studio | 0 | 7 | 0 | 0 | 2 | 2 | 4 | 5 | 0 | 1 | 0 | 0 |
| query | 0 | 5 | 8 | 0 | 0 | 3 | 2 | 2 | 0 | 0 | 0 | 0 |
| autonomous-tab | 0 | 2 | 2 | 0 | 0 | 0 | 0 | 4 | 7 | 0 | 5 | 0 |

Absolute top paths:
- `/Users/kaiavnihalani/Downloads/Eden/clients/portal/src/components/observability/TranscriptView.tsx`
- `/Users/kaiavnihalani/Downloads/Eden/clients/portal/src/app/(portal)/guardrails/page.tsx`
- `/Users/kaiavnihalani/Downloads/Eden/clients/portal/src/app/(portal)/portal-chrome.tsx`
- `/Users/kaiavnihalani/Downloads/Eden/clients/portal/src/app/(portal)/alerts/page.tsx`
- `/Users/kaiavnihalani/Downloads/Eden/clients/portal/src/components/ai-insights/ApprovalCard.tsx`

---

## 3. Explicit TOP-5 density hotspots for Wave 10

Priority = **chrome/wrong-role first**, then absolute density (aligns with [`w3-density-rules.md`](./w3-density-rules.md) §7 + anti-clutter doctrine).

| Wave 10 # | File | Score | Role | Why Wave 10 |
|---:|---|---:|---|---|
| **1** | `app/(portal)/portal-chrome.tsx` | **79** | **shell/hub-chrome** | Worst chrome file: stacked nav/meta micro + `h-5`×5/`h-6`×2 + `mt-0.5`×7. Crowding here taxes every route. |
| **2** | `app/(portal)/guardrails/page.tsx` | **89** | **hub (wrong role)** | Highest half-step count in Top-40 (`half`×17). Instrument micro on an ops hub. |
| **3** | `app/(portal)/alerts/page.tsx` | **74** | **hub (wrong role)** | `10px`×15 on alerts hub; breathe to ≥`text-xs`, drop `py-0.5`. |
| **4** | `components/observability/TranscriptView.tsx` | **126** | **instrument (keep density)** | Densest absolute — **tokenize** `9/10/11px` → `text-3xs/2xs/xs`; do **not** undensify to hub spacing. |
| **5** | `components/ai-insights/ApprovalCard.tsx` | **67** | **overview-adjacent** | Pure micro stack (`10px`×17 + `11px`×6) with almost no spacing cushion — demote off instrument floors. |

**Wave 10 parallel batch (same wave):** `fleet/page.tsx` (hub breathe), `studio/page.tsx` (hub + CTA), `sidebar-settings-view.tsx` (chrome #2), `replay` / `query` / `time-travel` / `TraceDetailPanel` (instrument tokenize only).

---

## 4. Shell/hub chrome vs instrument-analysis classification

### Doctrine

| Surface class | Density allowed? | Crowding severity |
|---|---|---|
| **Shell / hub chrome** (nav, sidebar, filter bars, page header, bottom nav) | Comfortable only (`text-xs`+, `gap-2`+, touch ≥`h-8` / 44px mobile) | **Worst** — leaks onto every page |
| **Hub / ops pages** (alerts, guardrails, fleet, studio, agents list) | Calm hub skin | **High** when instrument micro is misapplied |
| **Instrument / analysis** (TranscriptView, TraceDetail, query, time-travel, replay, Gantt) | Dense OK after token migrate | Expected; fix tokens not air |
| **Settings tabs** | Comfortable forms | Medium — `h-5`/`h-6` + `mt-0.5` common |
| **Marketing / auth** | Brand, not instrument | Out of portal polish path unless shared primitives |

### Class rollup (all files with crowding hits)

| Class | Files | Score sum | Micro hits | Half hits | Gap1 hits |
|---|---:|---:|---:|---:|---:|
| instrument-analysis (path heuristic) | 36 | 910 | 193 | 80 | 106 |
| other (includes many hubs/leaves) | 112 | 932 | 103 | 135 | 140 |
| settings-surface | 33 | 284 | 12 | 44 | 51 |
| marketing/auth | 26 | 200 | 46 | 16 | 22 |
| **shell/hub-chrome** | **12** | **184** | **17** | **22** | **42** |

> Note: path heuristic tags `guardrails`/`alerts`/`fleet` under “instrument” because of folder affinity — **role truth** (Wave 3) is **hub**. Treat those three as wrong-role hub crowding, not legitimate instrument density.

### Chrome file ranking (all shell hits)

| Score | Micro | Half | Gap1 | File |
|---:|---:|---:|---:|---|
| **77** | 6 | 13 | 13 | `app/(portal)/portal-chrome.tsx` |
| **25** | 2 | 1 | 9 | `app/(portal)/settings/_components/sidebar-settings-view.tsx` |
| **15** | 0 | 3 | 4 | `components/ui/command-palette.tsx` |
| **15** | 1 | 0 | 3 | `components/portal-os/MobileBottomNav.tsx` |
| **11** | 2 | 0 | 3 | `components/portal-os/ViewsMenu.tsx` |
| **9** | 1 | 1 | 1 | `components/ai-insights/ChatSidebar.tsx` |
| **8** | 0 | 3 | 2 | `components/layout/page-header.tsx` |
| **5** | 1 | 0 | 1 | `components/portal-os/CrossLinkBar.tsx` |
| **3** | 1 | 0 | 0 | `components/layout/sidebar-search.tsx` |
| **2** | 0 | 0 | 2 | `components/portal-os/DetailPanelShell.tsx` |

**Clean / zero crowding hits (notable vs Wave 1):**  
`components/portal-os/AppShell.tsx`, `QueryFilterBar.tsx`, `ResourceOsToolbar.tsx`, `ResourcePageShell.tsx`, `components/ui/filter-bar.tsx`, `components/layout/page-content.tsx` — shell primitives already stripped of micro/half-step classes in current tree (in-progress overhaul).

### Top-40 by corrected role

| Role | Count in Top-40 | Implication |
|---|---:|---|
| Instrument (legitimate dense) | ~15 | Tokenize; keep density |
| Hub wrong-role / hub-leaf | ~8 | **Breathe** (alerts, guardrails, fleet, studio, agents, insights, improve) |
| Shell chrome | 2 | **portal-chrome** + sidebar-settings — Wave 10 #1 priority |
| Settings | 5 | Touch targets + half-step forms |
| Marketing / primitive / other | ~10 | Lower portal priority except shared `status-badge` |

**Verdict:** Absolute hit volume lives in instrument panels, but **user-facing harm** concentrates in **portal-chrome** + **hub pages wearing instrument micro**. Chrome file count is small (12) yet `portal-chrome` alone is Top-3 by score.

---

## 5. Comparison to Wave 1 (`w1-density-grep.md`)

| Metric | Wave 1 | Wave 2 (this) | Δ |
|---|---:|---:|---|
| Scope files | 512 | 512 | 0 |
| `text-[9px]` | 5 | 5 | 0 |
| `text-[10px]` | 256 | **251** | **−5** |
| `text-[11px]` | 115 | **114** | **−1** |
| Micro family | 376 | **371** | **−5** |
| `gap-0.5` | 17 | 17 | 0 |
| `py-0.5` | 148 | **147** | **−1** |
| `p-1` | 42 | 42 | 0 |
| `leading-none` | 3 | 3 | 0 |
| `leading-none`+micro | 0 | 0 | 0 |
| `h-5` | 121 | 121 | 0 |
| `h-6` | 55 | **54** | **−1** |
| Files with hits | 200 (combined score) | **220** (broader pattern set) | +20 method |

### Ranking / method deltas

| Topic | Wave 1 | Wave 2 |
|---|---|---|
| Scoring | Micro + tight + accent buttons + h5/h6 | Micro + **half-steps** (`mt-0.5`…) + **gap-1 packing** + h5/h6; **no** accent-button weight |
| Top file | TranscriptView **86** | TranscriptView **126** (same king; higher score from gap-1/space-y-1) |
| #2 | guardrails **70** | guardrails **89** (stable) |
| portal-chrome | #10 @ **40** | **#3 @ 79** — half-step/`gap-1` recount surfaces stacked chrome |
| QueryFilterBar | Top-30 @ 19 | **0 crowding hits** — cleaned in current working tree |
| New patterns measured | — | `gap-1`×166, `gap-1.5`×101, `mt-0.5`×101, `space-y-1`×52, `text-[8px]`×1 |
| Top-N | Top 30 + Top 10 P0 | **Top 40** + **Wave 10 TOP-5** (chrome-first) |

### Stable P0 cluster (unchanged cast)

Still the same core cast as Wave 1: **TranscriptView, guardrails, ApprovalCard, alerts, studio, replay, fleet, query, time-travel, portal-chrome**. Wave 2 elevates **portal-chrome** (chrome doctrine) and demotes accent-button-driven studio ranking (studio remains Top-8 on pure crowding).

### What improved since Wave 1 capture

- Micro-text −5 hits (`10px` primary).
- Portal-OS shells (`AppShell`, `QueryFilterBar`, `ResourceOsToolbar`, `ResourcePageShell`, `filter-bar`) show **zero** measured crowding classes — shell work already underway.
- Residual pain is concentrated: **one chrome file** (`portal-chrome`) + **hub wrong-role pages** + **instrument tokenize backlog**.

---

## 6. Evidence notes

- Recount via token-aware regex over `clients/portal/src` (512 files, 2026-07-20).
- `gap-1` / `p-1` / `space-y-1` / `h-5` / `h-6` use word-boundary guards so `gap-1.5` / `p-1.5` / `h-56` are not double-counted.
- Absolute repo root: `/Users/kaiavnihalani/Downloads/Eden`.
