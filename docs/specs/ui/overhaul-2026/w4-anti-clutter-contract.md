# Wave 4 — Anti-Clutter Contract (Binding)

**Status:** **Approved-ready** — binding for Waves 5–10  
**Agent:** `w4-anti-clutter-contract`  
**Date:** 2026-07-20  
**Scope:** Docs only. No product UI.  
**Audience:** All Wave 5–10 implementers + Wave 10 clutter verifier  
**Baseline:** [`w1-consolidated-inventory.md`](./w1-consolidated-inventory.md) §5–§6 · Wave 2 crowding / card-nest append  
**Siblings:** [`w3-hierarchy-spec.md`](./w3-hierarchy-spec.md) · [`w3-density-rules.md`](./w3-density-rules.md) · [`w3-design-brief.md`](./w3-design-brief.md) · [`w3-industry-acceptance.md`](./w3-industry-acceptance.md)

**Authority:** A PR that ships features but **increases** simultaneous chrome, dual identity, card nests, or toolbar sprawl **fails** this contract — even if Pattern Library items otherwise pass.

---

## 0. One-liner

**Calm = ≤2 page bands · ≤5 primary toolbar actions · no dual title · no card-in-card-in-panel · clutter score drops vs Wave 1 baseline.**

---

## 1. Clutter score formula (normative)

Score **0–10** (higher = more overwhelming). Same formula Wave 1 Jobs 4–6 locked; Wave 10 re-scores Top-20 with this exact recipe.

| Factor | Penalty | Notes |
|---|---|---|
| Chrome bands beyond **2** | **+1.5** each | Identity + Toolbar = 2. Optional thin KPI does **not** add a band if it is severity/status chips only (see §3). A third nav/filter/legacy row **does**. |
| Visible primary CTAs above **5** | **+0.5** each | Count Identity actions + Toolbar primary controls (not overflow menu items, not table row actions). |
| KPI chips above **7** (desktop) / **4** (mobile) | **+0.3** each over cap | Home/hub Status strips only. |
| Duplicate titles / dual identity | **+2** | Two H1-class titles, or two org switchers, or rail heading + PageHeader echo. |
| Micro-controls packed in header | **+1** | ≥4 icon-only or `h-5`/`h-6` controls in Identity or Toolbar without overflow. |
| Nested cards in chrome / detail compose | **+1** | Card-in-card in page chrome, or detail nest depth ≥4 bordered boxes (see §5). |

### Scoring rules

1. **Exclude** AppShell sidebar and shell sticky breadcrumb header from band count (location, not page chrome).
2. Count bands by **stacked chrome purpose** — tabs + filters in one wrap = **1** Toolbar; tabs then a second purpose row = **2** bands toward Identity+Toolbar budget (third purpose row fails).
3. Score **steady-state** (org present; non-empty data where that unlocks KPI strips).
4. Prefer **effective bands after embed** when leaf chrome leaks under a hub (Studio / Fleet / Memory / Retrieval).
5. **Tier map** (for “drop ≥1 clutter tier” ship metric):

| Score | Tier |
|---:|---|
| 0–1.4 | T0 calm |
| 1.5–2.9 | T1 mild |
| 3.0–4.9 | T2 crowded |
| 5.0–6.9 | T3 overwhelm |
| 7.0–10 | T4 critical |

**Ship target:** Each W1 Top-20 surface drops **≥1 tier** vs baseline, **or** documents `WAIVE` with owner + reason in Wave 10 evidence. Core hubs must also hit hard caps in §3 regardless of score.

---

## 2. Wave 1 baseline (locked)

### 2.1 Hub clutter scores

| Hub | Baseline score | band_count | dual_title |
|---|---:|---:|:---:|
| Artifacts | 6.5 | 5 | N |
| Alerts | 5.5 | 4 | N |
| Audit trail | 5.0 | 4 | N |
| Issues | 4.0 | 4 | N |
| Promotions | 4.0 | 4 | N |
| Agents | 4.0 | 4 | N |
| Settings | 2.5 | 3 | **N** |
| Traces | 2.5 | **3** ⚠ | N |
| Improve | 1.5 | 3 | N |
| Connect | 0.5 | 2 | N |
| Dashboard | 0.0 | 1 | N |
| Evals | 0.0 | 2 | N |
| Ledger | 0.0 | 2 | N |

### 2.2 Top-20 overwhelm (locked)

Cite [`w1-consolidated-inventory.md`](./w1-consolidated-inventory.md) §6. Every row gets a backlog P0 (or explicit P1 with anti-clutter acceptance) in [`w3-p0-p3-backlog.md`](./w3-p0-p3-backlog.md) §2.5.

| # | Surface | Baseline bands |
|---:|---|---|
| 1 | Traces | 3 |
| 2 | Guardrails | 3 |
| 3 | Alerts | 4–5 |
| 4 | Studio | 2+forms |
| 5 | Replay | 3 |
| 6 | Fleet | 3 |
| 7 | Time-Travel | 3 |
| 8 | Settings | 2–3 (19-tab rail) |
| 9 | Model Advisor | 2 |
| 10 | Users | 2–3 |
| 11 | Tools | 2–3 |
| 12 | Memory facet | 3 |
| 13 | Retrieval facet | 3 |
| 14 | Query DSL | 2 |
| 15 | Analytics | 3 |
| 16 | Insights | 2–3 |
| 17 | Prompts | 2 |
| 18 | Agents | 4 |
| 19 | Issues | 4 |
| 20 | FinOps / Improve queue | 2–3 |

**Component watchlist (not routes):** `portal-chrome`, `TranscriptView`, `ApprovalCard` — crowding TOP-5 from Wave 2.

---

## 3. Hard caps (must PASS)

| Cap | Rule | Fail example |
|---|---|---|
| **Page bands** | ≤ **2** on core hubs (Traces, Issues, Alerts, Evals, Improve, Agents, Settings content). Identity + ≤1 Toolbar. Optional thin KPI only. | Traces today: PageHeader + Tabs + QueryFilterBar = **3** |
| **Toolbar primary actions** | ≤ **5** visible primary controls; rest → overflow (`More` / `DropdownMenu`) | Live + Refresh + Export + Display + Bulk + SQL + Replay as peers |
| **PageHeader actions** | ≤ **3** primary in Identity slot | Six icon buttons in header |
| **KPI desktop** | **5–7** primary glance metrics | Home default **8** widgets as peer glance tiles |
| **KPI mobile** | **3–4** above the fold | Same 8 widgets crammed |
| **Settings rail** | Grouped; **Advanced collapsed by default**; no dual title | 19 equal-loud tabs + rail `h2` + PageHeader |
| **Dual identity** | **0** pages with two titles or two org switchers | Rail Settings + PageHeader Settings (fixed baseline = N; must stay N) |
| **Card nest** | No card-in-card-in-panel in chrome; detail compose ≤ **3** bordered frames | Traces detail ~5 deep |
| **Shell amplify** | Do not add page bands to “match” shell; banners must not permanently stack with triple page chrome | Worst-case ~7 main-column bands |

### Core hub band targets

| Hub | Target bands | Notes |
|---|---|---|
| Traces | **2** | Tabs + filters/views **one** Toolbar; facets/legacy in filters/More |
| Issues | **2** (+ thin KPI OK) | Status filters inside toolbar |
| Alerts | **2** (+ thin KPI OK) | Severity strip thin or in toolbar |
| Evals | **2** | Already count-OK; no new CrossLinkBar band |
| Improve | **2** | CrossLinkBar → More / detail |
| Agents | **2** | CrossLinkBar → More / Advanced |
| Settings | Rail + **1** identity | One title; grouped tabs |
| Dashboard | **1** | Identity only; KPI capped |

---

## 4. Overflow policy (progressive disclosure)

Secondary tools **never** sit as peer chrome to primary filters/tabs.

| Kind | Placement | Examples |
|---|---|---|
| **Primary** | Identity actions or first Toolbar controls (≤5 total visible) | Live · Refresh · New · Connect · Views |
| **Lens navigation** | `ui/tabs` inside Toolbar | traces \| spans \| sessions |
| **Filter / sort / columns** | `QueryFilterBar` + `ViewsMenu` inside **same** Toolbar | facets as chips / `?facet=` |
| **Related product surfaces** | Header `More▾` **or** detail `CrossLinkBar` | Inspector, Replay, Debugger, Time-Travel, Query |
| **Rare / power** | Advanced menu / ⌘K / Advanced sidebar | SQL escape, export formats, open-in-leaf |
| **Never** | Extra horizontal band; tab-row sibling links; permanent hub CrossLinkBar between Identity and Tabs | Wave 1 Traces / Agents / Improve |

**Decision tree:**

```
1. Changes primary table lens?     → Tabs (Toolbar)
2. Filters/sorts current lens?     → QueryFilterBar / Views (Toolbar)
3. Related product surface?        → More▾ or detail CrossLinkBar
4. Legacy / Advanced?              → Dropdown · Advanced nav · ⌘K
5. Never                           → Third band · peer tab-row tools
```

---

## 5. Card-nest ban

| Ban | Why | W2 evidence |
|---|---|---|
| Card wrapping another Card/Panel that itself wraps a bordered well | Boxes-on-boxes; scan fails | SettingsCard + inner wells |
| Card wrapping `DataTable` / `InfiniteDataTable` with its own full frame | Double frame | ≥10 files |
| Detail compose depth ≥4 bordered expandables | Instrument becomes lasagna | Traces: DetailPanelShell → TraceDetailPanel → TranscriptV2 → ParallelToolLane → TranscriptView (~5) |
| Hub chrome using Card for toolbar/KPI | Chrome must be flat separators + spacing | Guardrails StatCards as chrome |

**Allowed:** One surface frame (page or panel) + hairline row separators; instrument **internal** expandables OK if not each a full Card chrome clone; prefer tokens over nested `border rounded` stacks.

**Fix pattern:** Flatten to Panel / open sections; one chrome owner per region; Transcript tokenize density without adding frames.

---

## 6. Dual-title / dual-identity ban

| Smell | Status / fix |
|---|---|
| Rail `<h2>Settings</h2>` + `PageHeader title="Settings"` | **Banned** — baseline fixed to N; lint/acceptance must keep N |
| In-page org Select + shell Clerk switcher | **Banned** — shell only; collapse-safe |
| Breadcrumb leaf + H1 + toolbar title restating same string | Toolbar must not restate H1 |
| Embedded child PageHeader under hub | `EmbeddedSurface` suppresses nested headers |
| Subtitle that repeats H1 | Ban; subtitle = job sentence only |

**Settings remaining risk:** 19-tab / 6-group rail density (not dual title). Contract: group + collapse Advanced; search remains primary find path.

---

## 7. Type & breathing (anti-soup)

| Rule | Contract |
|---|---|
| Shell / hub chrome | No raw `text-[9px]` / `text-[10px]` / `text-[11px]` |
| Instrument micro | Only via `--font-size-2xs` / `3xs` under density-rules gate |
| Overview / hub spacing | Prefer `--space-3+` / `--space-4+` gutters; ban `py-0.5` on chrome |
| Empty space | First paint: “where am I / what can I do / what’s the data?” Home &lt;5s; hub &lt;3s after load |

Not marketing whitespace on Transcript / triage — **hide** secondary chrome; keep instrument density via tokens ([`w3-density-rules.md`](./w3-density-rules.md)).

---

## 8. Confusion = dual routes

Orphans that look like separate apps **redirect or embed**. Never leave two competing UIs for the same job.

Normative map: [`w3-redirect-ia.md`](./w3-redirect-ia.md). Acceptance: competing dual closed for Observability facets, Fleet, Signals, Incidents, optimization deep-links (GAP list).

---

## 9. Lint / verify hooks (Wave 5 + Wave 10)

| Gate | When | Check |
|---|---|---|
| Band budget | W5 shells + W6–W9 hubs | Manual + vitest band asserts on core hubs |
| Dual-title | W5 Settings + W10 verifier | Grep / visual: one Settings title; one org |
| Toolbar ≤5 | W6–W9 | Manual count primary controls; overflow for rest |
| Nested-card | W5–W10 | Grep Card-in-Card; detail depth spot-check Traces |
| Micro-type chrome | W5 lint ratchets + W10 | `text-[9\|10\|11px]` → 0 on shell/hub chrome |
| Clutter re-score | **W10** `w10-clutter-verifier` | Re-run §1 formula on Top-20; tier drop or WAIVE |
| Anti-clutter checklist | W10 + industry acceptance §AC | All boxes PASS on core hubs |

---

## 10. Acceptance checkboxes (copy into industry SoT)

Normative copies live in [`w3-industry-acceptance.md`](./w3-industry-acceptance.md) §AC. Summary:

- [ ] Core hubs chrome bands ≤2
- [ ] Dual identity = 0 (titles + org)
- [ ] Toolbar primary actions ≤5; overflow for secondary
- [ ] KPI 5–7 desktop / 3–4 mobile on Home/hub Status
- [ ] No card-in-card-in-panel in chrome; Traces detail nest ≤3 frames
- [ ] Progressive disclosure: legacy Observe tools not peer chrome
- [ ] Top-20 each drop ≥1 clutter tier (or WAIVE)
- [ ] Home Status→Action &lt;5s; hub scan &lt;3s after load
- [ ] Settings Advanced collapsed by default; rail search works
- [ ] No competing dual UI for same job (redirect map)

---

## 11. Refs

| Doc | Role |
|---|---|
| [`w3-hierarchy-spec.md`](./w3-hierarchy-spec.md) | Band budget detail + hub targets |
| [`w3-density-rules.md`](./w3-density-rules.md) | Role density (overview calm / instrument tokenized) |
| [`w3-component-contract.md`](./w3-component-contract.md) | R10 chrome budget; shells slot order |
| [`w3-design-brief.md`](./w3-design-brief.md) | Binding must-ship; declutter = success ¶1 |
| [`w3-p0-p3-backlog.md`](./w3-p0-p3-backlog.md) | Top-20 P0 mapping §2.5 |
| [`w2-web-ux-standards.md`](./w2-web-ux-standards.md) | Cognitive load / progressive disclosure |
| [`w2-linear-stripe-chrome.md`](./w2-linear-stripe-chrome.md) | Single identity · quiet chrome |
| [`w2-datadog-llm.md`](./w2-datadog-llm.md) | Role density without header packing |

---

## 12. Wave 4 exit

| Gate | Status |
|---|---|
| Anti-clutter contract written | **Complete — Approved-ready** |
| Formula + caps + bans normative | **Yes** |
| Cross-linked from Design Brief + industry acceptance + backlog | **Required in same wave** |
| Product UI | **Not started** (Wave 5+) |

*End of `w4-anti-clutter-contract`.*
