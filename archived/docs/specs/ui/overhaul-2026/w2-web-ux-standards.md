# Wave 2/4 — Cross-Cutting Web UX Standards

**Agent:** `w4-web-ux-standards` (refresh of `w2-web-ux-standards`)  
**Date:** 2026-07-20  
**Status:** Wave 4 refresh — binding input to Design Brief + [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md)  
**Scope:** Research + docs only (no product UI).  
**Eden baseline:** [`w1-consolidated-inventory.md`](./w1-consolidated-inventory.md), [`w1-mobile-shell.md`](./w1-mobile-shell.md), [`w1-token-audit.md`](./w1-token-audit.md).

**Wave 4 addendum:** Progressive disclosure + scan paths are **enforced** by anti-clutter hard caps (bands ≤2, toolbar ≤5 primary, KPI 5–7/3–4, dual-title ban). Implementers treat S1–S6 below as normative alongside the anti-clutter contract.

---

## 0. P0 summary

| # | Standard | Eden gap (Wave 1) | Priority |
|---|---|---|---|
| 1 | **8px spacing grid** with full token ladder | Only `--space-2/3/4`; no `@theme` spacing; ad-hoc `py-0.5` / `gap-0.5` / micro-type | **P0** |
| 2 | **5–7 primary KPIs** on overview (desktop) | Home ships **8** default widgets; hubs add dense tile strips without a KPI budget | **P0** |
| 3 | **Status → Diagnosis → Action** page architecture | Traces = **3 chrome bands** before content; KPI walls without next-action; Improve/Alerts micro-UI | **P0** |
| 4 | **WCAG 2.2 AA** (esp. 2.5.8 target size, 2.4.11 focus not obscured) | Bottom nav ≥44px, but `Button sm` 32px, Improve actions **h-7 (28px)**, dense hubs; sticky header risk | **P0** |
| 5 | **Sticky filters + applied-filter overview** | `FilterBar` / `QueryFilterBar` exist but are **not sticky**; Traces stacks facets + filters as band #3 | **P0** |
| 6 | **Mobile: 3–4 metrics max** above the fold | Shell chrome (header + bottom nav) eats viewport; no mobile KPI budget; Improve stacks 5 columns | **P0** |

**Deliverable path:** `docs/specs/ui/overhaul-2026/w2-web-ux-standards.md`

---

## 1. Sources

### 1.1 Accessibility (normative)

| Source | Why it matters |
|---|---|
| [WCAG 2.2](https://www.w3.org/TR/WCAG22/) (W3C Recommendation) | Conformance target: **Level AA** (55 Level A+AA criteria). New AA criteria vs 2.1: **2.4.11** Focus Not Obscured, **2.5.7** Dragging Movements, **2.5.8** Target Size (Minimum 24×24 CSS px), **3.2.6** Consistent Help, **3.3.7** Redundant Entry, **3.3.8** Accessible Authentication. |
| [Understanding WCAG 2.2 — Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) | Legal floor 24×24; product UX should still aim **44×44** for primary touch chrome (Apple HIG / Material / NN/g). |
| [Understanding Focus Not Obscured (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html) | Sticky headers, bottom nav, and filter bars must not fully hide focused controls. |

### 1.2 Spacing & density

| Source | Why it matters |
|---|---|
| [Android / Material — Grids and units](https://developer.android.com/design/ui/mobile/guides/layout-and-content/grids-and-units) | **8 dp layout grid**; **4 dp** sub-grid for icons/type. Industry default for product UI. |
| [Material Design — Using density on the web](https://medium.com/google-design/using-material-density-on-the-web-59d85f1918f0) | Density scale 0 / −1 / −2…; **4px height steps**; denser components need **larger** margins/gutters (equilibrium). |
| [@material/density](https://www.npmjs.com/package/@material/density) | Formal density interval = **4px**; compact ≠ shrink touch targets below usable size. |
| Industry 8px scale practice (IBM Carbon, Atlassian, common design-system ladders) | Canonical ladder: **4 / 8 / 12 / 16 / 24 / 32 / 48 / 64** (4px base, 8px primary). |

### 1.3 Dashboard / KPI cognitive load

| Source | Why it matters |
|---|---|
| Working-memory literature (Miller → Cowan **4±1**; NN/g popularization of ≤7 focal points) | Caps primary competing elements on a glance surface. |
| Dashboard UX practice (Status / Diagnosis / Action layering; 5–7 KPI rule) | Primary view answers “is it OK?” in &lt;5s; diagnosis and action are progressive disclosure. See e.g. [dashboard decision-layer patterns](https://webdesignerindia.medium.com/ux-design-for-dashboards-best-practices-663767ff19c1), [SaaS dashboard decision UX](https://designpixil.com/blog/saas-dashboard-ux-best-practices), [Rework “5 metrics rule”](https://resources.rework.com/guides/data-analyst-playbooks/dashboard-design-drives-decisions). |
| [Setproduct — Dashboard UI design](https://www.setproduct.com/blog/dashboard-ui-design) | 3–7 KPIs above the fold; sticky filter/context on mobile; 44px touch. |

### 1.4 Filters & persistence

| Source | Why it matters |
|---|---|
| [Baymard — Display “Applied Filters” in an Overview](https://baymard.com/blog/how-to-design-applied-filters) | Applied-filter overview orients users; ~32% of sites miss best practice (ecommerce research; transfers to ops dashboards). |
| [Baymard — Persist search queries](https://baymard.com/blog/persist-search-queries) | Persistence speeds re-finding; resets on nav are a known productivity killer. |
| [Baymard — Product lists & filtering research hub](https://baymard.com/research/ecommerce-product-lists) | Combine filters without reload thrash; promote top filters; show applied state. |
| Dashboard filter UX guides (sticky context, mobile sheet + Apply) | Sticky filter trigger / chips; mobile = drawer, not horizontal cram. |

### 1.5 Touch & mobile

| Source | Why it matters |
|---|---|
| [NN/g — Touch Targets](https://www.nngroup.com/articles/touch-target-size/) | Physical floor ~**1 cm × 1 cm**; pixel targets are device-density dependent. |
| Apple HIG / Material touch guidance | Practical product floor **44–48 CSS px** for primary chrome. |
| [Smashing — Accessible target sizes](https://www.smashingmagazine.com/2023/04/accessible-tap-target-sizes-rage-taps-clicks/) | WCAG AA 24px vs AAA/HIG 44px; sticky top/bottom chrome needs the larger size. |
| Mobile dashboard patterns | Progressive disclosure; **3–4** headline metrics on narrow viewports; hide secondary filters behind sheet. |

---

## 2. Standards checklist (with Eden gaps)

Each standard: **name · industry practice · Eden gap (Wave 1) · priority**.

### S1. 8px (4px-sub) spacing grid

| Field | Content |
|---|---|
| **Name** | 8px baseline grid / spacing token ladder |
| **Industry practice** | Layout spacing on **8px** multiples; icons/type/compact gaps on **4px** sub-grid. Full ladder typically `4, 8, 12, 16, 24, 32, 40, 48, 64`. Density modes adjust **component height** by 4px steps, not by inventing odd paddings (`py-0.5` = 2px off-grid). |
| **Eden gap (Wave 1)** | Token audit: only `--space-2/3/4` (8/12/16); **missing** `--space-1` and `--space-5+`; **0** `@theme` spacing utilities; **0** component `var(--space-*)` usages outside `globals.css`. Density is `data-density` attribute only — **0** `--density-*` vars. Density grep: `py-0.5`×148, `gap-0.5`×17, `text-[10px]`×256 — off-grid micro-rhythm concentrated in TranscriptView, ApprovalCard, alerts, guardrails, fleet, portal-chrome. |
| **Priority** | **P0** |

### S2. Overview KPI budget (desktop): 5–7

| Field | Content |
|---|---|
| **Name** | Primary KPI overview budget |
| **Industry practice** | Default overview surfaces **5–7** decision-driving KPIs (exec: often 3–5; analyst: up to ~7). Each KPI needs value + context (delta/target/sparkline) + path to diagnosis. Extra metrics go to drill-down, secondary rows, or editable “more widgets” — not the default glance set. |
| **Eden gap (Wave 1)** | `/dashboard` `DEFAULT_WIDGETS` = **8** items (`throughput`, `latency`, `cost`, `anomalies`, `failures`, `agentic`, `traces`, `links`) — at/over the 5–7 primary budget if all render as peer glance tiles. Leaf/hub surfaces (Agents, observability, analytics) reuse KPI strips without a documented cap. U09 “editable KPI home” is PARTIAL — edit exists, budget rule does not. |
| **Priority** | **P0** |

### S3. Status → Diagnosis → Action (SDA)

| Field | Content |
|---|---|
| **Name** | Three-layer dashboard information architecture |
| **Industry practice** | **Status** (what’s happening — glance, &lt;5s) → **Diagnosis** (why — trends, facets, tables) → **Action** (what to do — CTA, escalate, open detail, export). Do not put diagnosis chrome (tabs + legacy links + facets) above Status. One primary decision question per view. |
| **Eden gap (Wave 1)** | **Traces hub:** 3 chrome bands (PageHeader + tabs/legacy + facets/filters) before list/detail — diagnosis chrome crowds Status. Settings: double title + dual org switcher. Hubs hand-roll tabs (0 use `ui/tabs`). Improve/Alerts: dense controls without clear Action tier. QueryState underused (~22 refs) vs ErrorState (~393) — async Status often inconsistent. |
| **Priority** | **P0** |

### S4. WCAG 2.2 Level AA

| Field | Content |
|---|---|
| **Name** | WCAG 2.2 AA portal conformance |
| **Industry practice** | Meet all A+AA criteria. Portal-critical AA deltas from 2.1: **2.5.8** Target Size ≥24×24 (prefer 44×44 for chrome); **2.4.11** Focus Not Obscured by sticky UI; **2.5.7** drag alternatives (kanban/reorder); contrast 4.5:1 text / 3:1 UI; keyboard operability; visible focus. |
| **Eden gap (Wave 1)** | Mobile bottom nav / More rows: **≥44px** (good). Failures: `Button sm` **h-8 (32px)**; Improve Approve/Reject **h-7 (28px)**; DataTable checkbox **h-4**; sidebar `NavItem`/`NavSubItem` without min-h; sticky `h-11` header + fixed bottom nav → **2.4.11** risk when focus scrolls under chrome. U20 polish / axe CI not a full AA program on all core routes (W1 specs gap). |
| **Priority** | **P0** (targets + focus-obscured); **P1** (full AA audit sweep); **P2** (AAA enhancements e.g. 2.5.5 44×44 as normative) |

### S5. Sticky filters + applied-filter overview

| Field | Content |
|---|---|
| **Name** | Sticky filter context & applied-filter visibility |
| **Industry practice** | Filters that reshape the primary dataset should remain **visible or one tap away** while scrolling (sticky bar or sticky “Filters (n)” trigger). Always show **applied filters** as chips/overview with clear-all. Persist filter/query state across in-session navigation where the same resource context continues (Baymard). Mobile: sheet + batch Apply; don’t mirror desktop horizontal filter walls. |
| **Eden gap (Wave 1)** | Canonical `FilterBar` / `QueryFilterBar` exist and clear-all works — but **no sticky positioning** on the primitive (scrolls away). Traces places filters in band 3 of a 3-band stack (overload, not sticky context). Many tables lack sticky first column (only ~8 call sites). No Wave 1 evidence of cross-route filter persistence contract. Issues hub uses dual status filters + VirtualizedList — separate pattern. |
| **Priority** | **P0** (Traces + list hubs sticky applied chips); **P1** (session persistence / URL sync contract); **P2** (saved views polish beyond `ViewsMenu`) |

### S6. Mobile metric budget: 3–4

| Field | Content |
|---|---|
| **Name** | Narrow-viewport metric & chrome budget |
| **Industry practice** | On phone widths, show **3–4** headline metrics max; rest behind “More metrics” / horizontal snap / drill-in. Touch targets 44–48px. Prefer list/card fallbacks over wide tables. Progressive disclosure for filters. |
| **Eden gap (Wave 1)** | Shell: sticky header `h-11` + `MobileBottomNav` + `main pb-20` — viewport already taxed. No documented mobile KPI cap on Home/hubs. Improve: 5 columns → single-column stack &lt;lg (long scroll), actions 28px. Tables: optional sticky col only; **no card/list mobile fallback**. Agents absent from bottom nav **and** More sheet (discoverability). Breakpoint shell switch at **lg (1024)** — tablet gap. |
| **Priority** | **P0** (metric cap + touch on Improve/core CTAs); **P1** (Agents in More; table card fallbacks); **P2** (md tablet IA refinement) |

### S7. Density modes with equilibrium

| Field | Content |
|---|---|
| **Name** | Comfortable / Compact density without illegible micro-type |
| **Industry practice** | Material: increase density via controlled height scale (−4px steps), **increase** gutters when components densify. Floor readable type (~12px+ for body; avoid 9–10px as default UI). Compact is for data tables/lists, not for primary CTAs or touch chrome. |
| **Eden gap (Wave 1)** | Comfortable/Compact exist via `DensityProvider`, but density is attribute CSS only — no tokenized density scale. Micro-type (`text-[9px]`/`[10px]`/`[11px]`) used as fake density in product surfaces (TranscriptView score 84, etc.). U19 Density program still open. |
| **Priority** | **P0** (ban 9–10px as default UI chrome; migrate to tokens); **P1** (`--density-*` vars + Material-like steps); **P2** (per-surface density overrides) |

### S8. One chrome band for identity; filters as sticky context

| Field | Content |
|---|---|
| **Name** | Hub chrome band budget |
| **Industry practice** | Shell header + at most **one** page identity band (title/tabs) + **one** sticky filter/context band. Avoid legacy link rows competing with tabs. Cross-links belong in detail or secondary nav, not a third primary band. |
| **Eden gap (Wave 1)** | Traces = **3** bands (confirmed P0 foreshadow). Agents/Improve ≈ PageHeader + CrossLinkBar + tabs. Settings ~21 rail tabs + double “Settings” title. |
| **Priority** | **P0** (Traces collapse to ≤2 bands); **P1** (hub CrossLinkBar policy); **P2** (Settings rail IA) |

---

## 3. Priority rollup

### P0 — Wave 3 brief must require

1. Complete **8px/4px spacing token ladder** + `@theme` utilities; eliminate off-grid `py-0.5` / 9–10px type as default density.  
2. **KPI budget:** desktop overview ≤7 primary metrics (prefer 5); Home default widget set trimmed/ranked to match.  
3. **SDA layout rule** on Home, Traces, Issues, Alerts, Improve: Status first, diagnosis second, action always present on KPI/issue rows.  
4. **WCAG 2.2 AA floor** for touch: primary actions ≥24px absolute / **≥44px** on mobile chrome and Improve board actions; sticky chrome must not fully obscure focus (2.4.11).  
5. **Sticky applied-filter** pattern on Traces and other filtered list hubs; clear-all + chip overview.  
6. **Mobile:** ≤4 headline metrics; no 5-column kanban as the only Improve layout without a dedicated narrow pattern.

### P1 — Same wave or immediate follow-on

- Filter/query **URL or session persistence** within Observe / Issues / Alerts.  
- Agents discoverability in mobile **More** sheet.  
- DataTable **card/list fallback** for top mobile routes.  
- Adopt shared `Tabs` + `Button` (kill CTA/tabs drift).  
- Full axe/WCAG AA sweep on U18 core routes; retire `fallback={null}` blanks.  
- Tokenize density (`--density-*`) aligned to Material 4px steps.

### P2 — Later polish

- Saved views / promoted filters (Baymard “promote important filters”).  
- Tablet (md–lg) shell IA.  
- AAA target size (44×44) as hard lint everywhere.  
- Settings rail consolidation beyond dual-title fix.

---

## 4. Recommended rules for Wave 3 Design Brief

Copy/adapt these as normative brief rules (not optional inspiration):

1. **Grid:** All new spacing uses the token ladder `space-1…space-8` (4px base). Odd values (`2px`, `10px` type) require an exception tag in PR.  
2. **Home KPIs:** Default visible primary metrics **≤7** (target **5**). `traces`/`links` widgets count against the budget unless demoted to “utility” row below Status.  
3. **SDA:** Every hub page wireframe labels three zones. No diagnosis controls above Status metrics. Every Status tile links to Diagnosis or Action.  
4. **Chrome bands:** Max **2** page-level bands under AppShell (identity/tabs + sticky filters). Traces legacy destinations move into overflow / command palette / detail CrossLinkBar.  
5. **Filters:** `QueryFilterBar` gains `sticky` variant + applied-chip row; filters persist while scrolling the table; Clear all required.  
6. **A11y:** Ship checklist item “WCAG 2.2 AA” with explicit tests for **2.5.8** and **2.4.11** on sticky header + bottom nav. Mobile primary CTAs **min 44×44**.  
7. **Mobile metrics:** At `&lt;lg`, Home and hub KPI strips show **3–4** metrics; overflow in “More”. Improve ships a narrow-width queue pattern (list or snap columns), not a tall 5-stack only.  
8. **Density:** Compact mode may reduce row height by 4/8px; it may **not** reduce type below `text-xs` (12px) for readable UI or shrink touch chrome.  
9. **Anti-drift:** New hub tabs use `@/components/ui/tabs`; new accent CTAs use `Button`.  

---

## 5. Anti-patterns (do not ship)

| Anti-pattern | Why it fails | Eden watch-out |
|---|---|---|
| **KPI wall** | &gt;7 peer tiles → choice overload; nothing is Status | Home 8-widget default; analytics/observability tile strips |
| **Chrome lasagna** | 3+ bands before content | Traces tabs + legacy + facets |
| **Fake density via 9–10px type** | Illegible; fails readability; not a density system | TranscriptView, ApprovalCard, alerts, guardrails |
| **Off-grid 2px padding** | Breaks 8px rhythm; compounds inconsistency | `py-0.5` ×148 |
| **Filter amnesia** | Re-entry cost; Baymard/dashboard research | Non-sticky FilterBar; nav resets |
| **Hidden applied filters** | Users lose trust in the dataset | Facet chips without sticky applied overview |
| **Touch-hostile compact** | Misses WCAG 2.5.8 / HIG | Improve `h-7`, Button `sm` on mobile-critical paths |
| **Desktop table on phone** | Horizontal scroll only, no card fallback | Most DataTable call sites |
| **Status without Action** | Metrics become vanity | Tiles with no drill-in / CTA |
| **Suspense `fallback={null}`** | Blank Status — worse than skeleton | Settings and others (W1) |
| **Dual identity chrome** | Competing titles / org switchers | Settings double title + dual org |
| **Advanced-only mobile dead-ends** | Core workflows unreachable from bottom IA | Agents missing from More |

---

## 6. Mapping: standards → Wave 1 evidence

| Standard | Primary W1 evidence |
|---|---|
| S1 Grid | `w1-token-audit.md` §2; consolidated §5; density grep top-10 |
| S2 KPI 5–7 | `dashboard/page.tsx` `DEFAULT_WIDGETS` (8); hub KPI strips in leaf/hub inventories |
| S3 SDA | consolidated §7 Traces 3 bands; foreshadow #1–5 |
| S4 WCAG 2.2 AA | `w1-mobile-shell.md` §5 touch &lt;44px; U20 gap; sticky header + bottom nav |
| S5 Sticky filters | `filter-bar.tsx` (no sticky); Traces toolbar stack; Baymard applied-filter gap |
| S6 Mobile 3–4 | mobile shell §3/§6; Improve kanban; Agents discoverability |
| S7 Density | `data-density` only; U19 open; micro-type hotspot list |
| S8 Chrome bands | `w1-hub-surfaces.md` Traces/Agents/Improve/Settings |

---

## 7. Wave 3 handoff

Wave 3 Design Brief authors should:

- [ ] Treat §4 rules as **acceptance criteria**, not suggestions.  
- [ ] Cite this file + W1 inventory for every layout decision on Home / Traces / Improve / mobile.  
- [ ] Pair competitor gap agents (e.g. Laminar) against **S2/S3/S5/S8** — not invent parallel chrome.  
- [ ] Defer implementation to later waves; this doc does not change product code.

---

*End of Wave 2 web UX standards.*
