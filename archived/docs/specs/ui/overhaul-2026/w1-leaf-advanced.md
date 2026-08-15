<!-- Wave 1 Job 8 — w1-leaf-advanced (read-only discovery, 2026-07-20). -->

# Job 8 — Advanced / Intelligence leaves

**Scope:** Fleet, Signals, Incidents, Tools, Users, Analytics, Insights, Guardrails, Optimization/*, Prompts, Redteam, Studio.  
**Band convention:** identity / tabs / KPI / filter rows above primary content (AppShell excluded).  
**Hotspots called out:** **Studio**, **Guardrails**.

---

## 1. Per-surface map

### 1.1 Studio — **HOTSPOT**

| Field | Detail |
|---|---|
| Route | `/studio` → redirect `/evals?tab=studio` (`next.config.ts:171`) |
| File | `studio/page.tsx` (~906 LOC) |
| Layout | B: `PageContent size="wide"` + `PageHeader` eyebrow Eval (`:91-97`) + local `Tabs` templates/examples/metrics (`:123-140`) |
| Hub | Embed+redirect into Evals (`evals/page.tsx` StudioView + `EmbeddedSurface`) |
| **Bands (standalone)** | **2** = Header + tab pill strip |
| **Bands (embedded)** | **1** = local tabs only (header suppressed) |
| Form density | **Very high** — multi-field example rows, generate/save, dirty-tab confirm, Dialogs |
| Tables | `DataTable` templates + my-metrics (`:221`, `:771`) |
| Clutter | `text-[10px]`×7; Cards×3; density-grep score **54** (top-5); historically **6** raw accent CTAs |
| Notes | Nested form labels at 10px (`:572,:588`); detail Dialog metadata at 10px (`:854-872`) |

### 1.2 Fleet

| Field | Detail |
|---|---|
| Route | `/fleet` → `/agents?tab=fleet` (`next.config.ts:159`) |
| File | `fleet/page.tsx` (~460 LOC) |
| Layout | A: `CoreResourcePage` / `ResourcePageShell`; `useEmbeddedSurface()` hides CrossLinkBar (`:69`, `:162-172`) |
| Hub | Agents tab embed (`agents/page.tsx:40,221-223`) |
| **Bands (standalone)** | **3** = PageHeader · CrossLinkBar · KPI strip (5 Cards) + local tablist agents/heatmap/delegation |
| **Bands (embedded)** | **2** = KPI + local tabs (no CrossLinkBar) |
| Clutter | `text-[10px]`×10 on KPI labels; card grid not DataTable; density score **43** |
| Competing-UI | Fleet health vs Agents list — same “agent estate” job, second chrome stack when deep-linked |

### 1.3 Signals

| Field | Detail |
|---|---|
| Route | `/signals` → `/alerts?tab=signals` (`next.config.ts:168`) |
| File | `signals/page.tsx` (~315 LOC) |
| Layout | B + DataTable |
| Hub | Alerts embed (`alerts/page.tsx:44,376-378`) |
| **Bands** | **2** standalone; **1** embedded |
| Sidebar | Advanced still lists Signals → `/alerts?tab=signals` (`sidebar-config.ts:121-126`) — canonical OK, but duplicates Alerts entry point |
| Clutter | Low micro; table-forward |

### 1.4 Incidents

| Field | Detail |
|---|---|
| List | `/incidents` → `/issues?tab=incidents` (`next.config.ts:173`) |
| File | `incidents/page.tsx` (~239 LOC) |
| Detail | `/incidents/[cluster_id]` **live KEEP** (no list redirect for detail) |
| Hub | Issues embed (`issues/page.tsx:52,334-336`) |
| **Bands (list)** | **2** Header + table |
| Competing-UI | Incidents vs Agent Issues — Issues hub already dual-tabs |

### 1.5 Tools

| Field | Detail |
|---|---|
| Route | `/tools` → `/analytics?tab=tools` (`next.config.ts:167`) |
| File | `tools/page.tsx` (~768 LOC) |
| Layout | B + local Tabs attribution/compare/recommender/taxonomy |
| Hub | Analytics embed (`analytics/page.tsx:59-61,312-314`) |
| **Bands** | **2–3** = Header + tab strip + action forms before DataTable |
| Clutter | Cards≈8; raw accent×1; action→result pattern |

### 1.6 Users

| Field | Detail |
|---|---|
| Route | `/users` → `/analytics?tab=users` (`next.config.ts:164`) |
| File | `users/page.tsx` (~799 LOC) |
| Layout | B wide + Tabs sessions/goals/satisfaction/cohorts/segments |
| Hub | Analytics embed |
| **Bands** | **2–3** Header + tabs + per-tab DataTables/Cards |
| Clutter | Cards≈9; `text-[10px]`×3; multi-table surface |

### 1.7 Analytics (Advanced hub)

| Field | Detail |
|---|---|
| Route | `/analytics` — Advanced sidebar (`sidebar-config.ts:113-118`) |
| File | `analytics/page.tsx` (~450 LOC) |
| Layout | B + `useQueryTab` overview/insights/topics/tools/users (`:41,:149`) + underline `TabsList` (`:284-299`) |
| Embeds | Insights, Topics, Tools, Users under `EmbeddedSurface` (`:301-319`) |
| **Bands** | **2** = PageHeader (+ day-range actions) + tab strip; overview adds **KPI Panel strip** → effective **3** |
| Clutter | KPI `Panel`s with `text-[10px]` trend/sublabel (`:107,:124`); day toggles raw accent (`:257`) |
| Gap | Not on `CoreResourcePage` (unlike Agents/Evals) — hub chrome inconsistency |

### 1.8 Insights (+ topics)

| Field | Detail |
|---|---|
| Routes | `/insights` → analytics?tab=insights; `/insights/topics` → ?tab=topics (`next.config.ts:165-166`) |
| Files | `insights/page.tsx` (~648), `insights/topics/page.tsx` |
| Layout | Insights: nested Tabs overview/insights/closed-loop; Topics: facet chips |
| **Bands (standalone)** | **2–3** with nested tabs |
| Clutter | Cards≈6; density hits in insights (w1-density tight-spacing top) |

### 1.9 Guardrails — **HOTSPOT**

| Field | Detail |
|---|---|
| Route | `/guardrails` — Advanced sidebar (`sidebar-config.ts:192-193`) — **no list redirect** (true hub) |
| File | `guardrails/page.tsx` (~1155 LOC) |
| Layout | B wide + PageHeader (`:288-305`) + **4 StatCards** (`:308-313`) + 5 underline tabs test/policies/injections/pii/redteam (`:316-344`) |
| Embed | Redteam under `EmbeddedSurface` (`:353-356`) |
| **Bands** | **3** = Header · StatCard KPI strip · Tabs (+ Dialog for AddPolicy) |
| Form density | **Very high** on Test tab — large Textarea, evaluate/scan/redact, result Panels; AddPolicyDialog JSON Textarea |
| Tables | Multiple DataTables (policies, injection/PII history) |
| Clutter | Cards/StatCard/Panel hits≈**20**; `text-[10px]`×**14**; density-grep score **70** (#2 overall after TranscriptView) |
| Competing-UI | Redteam tab vs redirected `/redteam` standalone module |

### 1.10 Optimization / Cost `/*`

| Route | File | Redirect? | Bands | Notes |
|---|---|---|---|---|
| `/optimization` | `optimization/page.tsx` (~143) | Hub (Advanced) | **2** Header + 5 tabs (`:70-87`) | Embeds all children |
| `/optimization/budget` | `budget/page.tsx` (~459) | **None — live dual** | **2** own PageHeader+forms | Soft-nest only via hub tab |
| `/optimization/outcomes` | `outcomes/page.tsx` (~474) | **None** | **2–3** Header + Tabs + DataTable | |
| `/optimization/predict` | `predict/page.tsx` (~529) | **None** | **2–3** | |
| `/optimization/model-advisor` | `model-advisor/page.tsx` (~1020) | **None** | **2** + dense Inputs | density score **34**; Cards≈6; 10px×6; raw accent×3 |
| FinOps (cost tab) | `_components/finops-explorer.tsx` | n/a | dense selectors + DataTable | |

**GAP:** Cost children remain deep-linkable with **full dual chrome** (own `PageContent`+`PageHeader`) even though hub wraps them in `EmbeddedSurface`. No `next.config` / hub-redirect rules for `/optimization/{budget,outcomes,predict,model-advisor}`.

### 1.11 Prompts

| Field | Detail |
|---|---|
| Route | `/prompts` — Advanced standalone (`sidebar-config.ts:200-201`) |
| File | `prompts/page.tsx` (~637 LOC) |
| Layout | B wide + create forms + Cards |
| **Bands** | **1–2** Header + form/list (no hub tabs) |
| Clutter | Cards≈9; create flow medium density |
| Hub relation | **Standalone** — no embed parent |

### 1.12 Redteam

| Field | Detail |
|---|---|
| Route | `/redteam` → `/guardrails?tab=redteam` (`next.config.ts:174`) |
| File | `redteam/page.tsx` (~180 LOC) |
| Layout | B + endpoint Input + findings DataTable |
| **Bands** | **2** standalone; **0–1** embedded (header hidden) |
| Hub | Guardrails redteam tab |

---

## 2. Band counts rollup

| Surface | Standalone bands | Embedded bands | Overwhelm |
|---|---|---|---|
| Guardrails | **3** | n/a (hub) | **P0 hotspot** |
| Studio | 2 (+ dense forms) | 1 | **P0 hotspot** |
| Fleet | 3 | 2 | P1 |
| Analytics overview | 3 (w/ KPIs) | n/a | P1 |
| Tools / Users / Insights | 2–3 | 1–2 | P1 |
| Model Advisor | 2 (dense) | 1 | P1 |
| Optimization hub | 2 | — | P2 |
| Signals / Incidents list / Redteam | 2 | 1 | P2 |
| Prompts | 1–2 | — | P2 |

---

## 3. Density / clutter notes (Advanced)

1. **Guardrails** = Stat strip always on + 5 tabs + testbench hero + history tables — classic triple-band + nested panels.  
2. **Studio** = form sprawl inside Evals mega-hub (7 peer tabs already) — double IA tax.  
3. **Fleet KPI strip** (5 Cards) + local tabs duplicates Agents hub identity when not embedded.  
4. **Optimization children** without redirects = bookmarkable dual UIs under Cost.  
5. **Analytics** hand-rolled KPI `Panel`s + day chips mirror Traces filter density without ResourceOsToolbar.

**Evidence:** `guardrails/page.tsx:288-356` · `studio/page.tsx:91-140` · `fleet/page.tsx:162-207` · `analytics/page.tsx:93-126,280-319` · `optimization/page.tsx:69-125` · `sidebar-config.ts:110-201` · `next.config.ts:159-174`.
