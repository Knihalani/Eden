<!-- Wave 1 Job 11 — w1-embed-surfaces (+ Job 10 prep) (read-only discovery, 2026-07-20). -->

# Job 11 — EmbeddedSurface / hub embeds vs standalone dual chrome

**Primitive:** `clients/portal/src/components/layout/embedded-surface.tsx`  
- Context `true` under `EmbeddedSurface` (`:11-16`)  
- `useEmbeddedSurface()` (`:19-21`)  
- Consumers: `PageHeader` hides title chrome, keeps actions (`page-header.tsx:30-56`)  
- `PageContent` skips outer padding/max-width when embedded (`page-content.tsx:40-65`)

**Pattern:** Hub `dynamic(() => import(leaf/page))` + wrap in `<EmbeddedSurface>`; leaf URL usually **redirects** to hub `?tab=` / `?view=` / `?facet=` so users rarely see dual chrome — unless deep-link GAP or Soft-nest broken.

---

## 1. Hub → leaf embed matrix

| Hub | Leaf module imported | Embed wrap | Leaf URL | Standalone dual chrome? |
|---|---|---|---|---|
| **Traces** `traces/page.tsx:103-138,768-779` | inspector, replay, debugger, query, time-travel, mcp, decisions, memory, retrieval | Yes | Redirected to `?view=` / `?facet=` | Suppressed when via hub; modules still full-shell codepaths |
| **Traces** | **cohorts** | **NO** | Redirect → `?view=cohorts` | Soft-nest **broken** — falls back to list |
| **Evals** `evals/page.tsx:64-88,172-204` | datasets, playgrounds, experiments, observability/eval, labeling, studio, synthetic | Yes (per tab) | Redirected `?tab=` | Header suppressed; Studio/Labeling keep nested tabs/forms |
| **Agents** `agents/page.tsx:40,221-223` | fleet | Yes | `/fleet` → `?tab=fleet` | Fleet also uses `useEmbeddedSurface` to drop CrossLinkBar (`fleet/page.tsx:69,162`) |
| **Alerts** `alerts/page.tsx:44,376-378` | signals | Yes | `/signals` → `?tab=signals` | Header suppressed |
| **Issues** `issues/page.tsx:52,334-336` | incidents (list) | Yes | `/incidents` → `?tab=incidents` | Detail `/incidents/[id]` stays full leaf |
| **Analytics** `analytics/page.tsx:51-66,301-319` | insights, insights/topics, tools, users | Yes | Redirected | Nested tabs inside leaf remain |
| **Optimization** `optimization/page.tsx:19-57,90-124` | finops-explorer, budget, outcomes, predict, model-advisor | Yes | **Children NOT redirected** | **Dual chrome if deep-linked** |
| **Guardrails** `guardrails/page.tsx:27-34,353-356` | redteam | Yes | `/redteam` redirected | Thin page |
| **Improve** `improve/page.tsx:43-47,344-351` | plans, runs | Yes | plans/runs list redirected | scorecard/change-impact/online-scoring **not** embedded |
| **Settings** `settings/page.tsx:100,423-425` | profile as AccountTab | Yes | `/profile` redirected | Tab rail owns identity |

---

## 2. Leaves that embed into hubs (vs own full chrome stack)

### Embed-primary (redirect + EmbeddedSurface)

Users hitting legacy URLs get hub chrome; leaf `PageHeader` hidden:

- Studio, Synthetic, Labeling list, Datasets list, Playgrounds, Experiments → **Evals**  
- Fleet → **Agents**  
- Signals → **Alerts**  
- Incidents list → **Issues**  
- Tools, Users, Insights, Topics → **Analytics**  
- Redteam → **Guardrails**  
- Inspector, Replay, Debugger, Query, Time-Travel, facets → **Traces**  
- Profile → **Settings** account tab  
- Improve plans/runs lists → **Improve**

### Full chrome stack (no hub parent / not embedded)

| Surface | Why full stack |
|---|---|
| `/prompts` | Advanced standalone; no embed parent |
| `/debugger-sessions` (+ `[id]`) | Advanced standalone (≠ legacy debugger) |
| `/guardrails` | **Is** the hub |
| `/analytics` | **Is** the hub |
| `/optimization` | **Is** the hub |
| `/traces` `/agents` `/evals` `/alerts` `/issues` `/improve` `/settings` | Core hubs |
| `/improve/scorecard`, `change-impact`, `online-scoring` | Live orphans; CrossLink only |
| `/labeling/queues/[id]`, `/datasets/[id]`, `/incidents/[cluster_id]` | Detail workstations |
| `/agents/connect`, `/sessions/[sessionId]` | Flows / deep links |
| `/optimization/{budget,outcomes,predict,model-advisor}` | **Embed when via hub; full chrome when deep-linked (GAP)** |

### Hybrid: respects embed context in code

| Leaf | Behavior |
|---|---|
| `fleet/page.tsx` | `useEmbeddedSurface()` — CrossLinkBar off when embedded |
| `playgrounds/page.tsx` | Conditional chrome via `useEmbeddedSurface()` (`:54`, `:224+`) |
| `sidebar-settings-view.tsx` | `embedded` prop for settings tab vs standalone `/settings/sidebar` |

Most other leaves rely solely on `PageHeader`/`PageContent` context — they do **not** hide local Tabs, StatCards, or toolbars when embedded → **nested chrome leak**.

---

## 3. Dual-chrome failure modes

1. **Nested tabs under hub tabs** — Studio (3 tabs) inside Evals (7 tabs); Memory/Retrieval (tabs) inside Traces facet mode; Users (5 tabs) inside Analytics (5 tabs).  
2. **KPI strips survive embed** — Fleet 5-Card KPI; Guardrails StatCards always (hub itself).  
3. **Optimization deep links** — `/optimization/budget` serves full PageContent+PageHeader outside hub.  
4. **Cohorts redirect without embed** — lands on Traces list, not Columnar UI.  
5. **In-app hrefs to redirect sources** — e.g. Query → `/observability/cohorts` (`query/page.tsx:362`).

---

## 4. EmbeddedSurface adoption (code inventory)

| File | Role |
|---|---|
| `components/layout/embedded-surface.tsx` | Provider |
| `components/layout/page-header.tsx` | Suppress title |
| `components/layout/page-content.tsx` | Suppress padding |
| `components/layout/index.ts` | Re-export |
| Hubs listed in §1 | Providers |
| `fleet/page.tsx`, `playgrounds/page.tsx` | Consumers of hook |
| Tests | `agents/__tests__/w4-1-agents-pages.test.ts` (fleet CrossLink suppress) |

Settings tabs mostly use dedicated `*-tab.tsx` components (not page modules) — Account is the page-module embed exception (`profile/page`).

---

# Job 10 prep — Top-20 overwhelming page candidates

Rough score ≈ **(chrome bands) × (micro-controls + raw accents) × (nested Card/Panel/StatCard density)**.  
Inputs: this discovery’s band counts + `w1-density-grep.md` scores + LOC / Card counts from Job 7–8.

| Rank | Page | Bands | Rationale (bands × micro × nested) |
|---|---|---|---|
| 1 | **Traces hub** (`traces/page.tsx`) | 2–3 | Hub tabs + QueryFilterBar + ViewsMenu + More + SpanSearch + LiveTail + detail panel — highest **control** product |
| 2 | **Guardrails** (`guardrails/page.tsx`) | 3 | Density score **70**; StatCards×4; 5 tabs; testbench + history tables; Cards≈20 |
| 3 | **Alerts feed** (`alerts/page.tsx`) | 4–5 | Density **62**; ResourceOsToolbar + severity + ack + rules; 10px×15 |
| 4 | **Studio** (`studio/page.tsx`) | 2+forms | Density **54**; nested in 7-tab Evals; example-row sprawl; accent CTA history |
| 5 | **Replay** (`replay/page.tsx`) | 3 | Density **44**; StatCards + picker + local tabs; 10px×9 |
| 6 | **Fleet** (`fleet/page.tsx`) | 3 | Density **43**; KPI×5 + heatmap/delegation; 10px×10 |
| 7 | **Time-Travel** (`time-travel/page.tsx`) | 3 | Density **43**; stepper + 3 workflows + Cards |
| 8 | **Settings hub** (`settings/page.tsx` + rail) | 2–3 | 21 tabs / 19 visible / 6 groups; `dual_title` **N** (rail h2 gone); overload = tab IA |
| 9 | **Model Advisor** (`model-advisor/page.tsx`) | 2 | ~1020 LOC; dense Inputs; Cards×6; 10px×6 |
| 10 | **Users** (`users/page.tsx`) | 2–3 | 5 nested tabs + many DataTables; Cards×9 |
| 11 | **Tools** (`tools/page.tsx`) | 2–3 | 4 tabs + action forms + Cards×8 |
| 12 | **Memory facet** (`memory/page.tsx`) | 3 | Nested tabs + Cards×9 under Traces facet chrome |
| 13 | **Retrieval facet** (`retrieval/page.tsx`) | 3 | Same shape as memory |
| 14 | **Query DSL** (`query/page.tsx`) | 2 | Multi-op Cards + alert compiler; raw accents |
| 15 | **Analytics overview** (`analytics/page.tsx`) | 3 | KPI Panels + day chips + charts |
| 16 | **Insights** (`insights/page.tsx`) | 2–3 | Nested tabs + detector actions; density tight-spacing |
| 17 | **Prompts** (`prompts/page.tsx`) | 2 | Create forms + Cards×9 |
| 18 | **Agents hub** (`agents/page.tsx`) | 3 | Header + CrossLinkBar + tabs + card grid filters |
| 19 | **Issues hub** (`issues/page.tsx`) | 3 | Top tabs + status filters + ResourceOsToolbar + bulk |
| 20 | **FinOps explorer** (`finops-explorer.tsx`) / **Improve queue** | 2–3 | Dimension selectors / kanban + CrossLinkBar |

### Also watch (component-level, not routes)

- `components/observability/transcript-view.tsx` — density #1 micro-text  
- `components/ai-insights/ApprovalCard.tsx` — density #3  
- `portal-chrome.tsx` — shell micro + org switcher  

### Job 10 scoring hint

Prefer measuring **effective bands after embed** (hub + leaked leaf chrome) for Studio/Fleet/Memory — standalone band count understates hub overload.

---

**Evidence anchors:** embed matrix §1 file:lines · `embedded-surface.tsx` · `page-header.tsx:30-56` · `w1-density-grep.md` top ranks · Jobs 7–9 docs in this folder.
