<!-- Auto-captured from Wave 1 agent `w1-leaf-surfaces` (read-only discovery). -->

# Leaf / Advanced Surfaces Inventory

Source of truth: `clients/portal/src/app/(portal)/**`, `lib/sidebar-config.ts` (Advanced category), `lib/portal-hub-redirect.ts`, `next.config.ts` redirects, hub `EmbeddedSurface` + `dynamic()` imports.

**Layout templates in use**
| Template | Contract |
|---|---|
| **A. CoreResourcePage** | `PageContent` + `ResourcePageShell` slots (`header` / `toolbar` / `kpiStrip` / `table`) |
| **B. PageContent + PageHeader** | Wide/default content; local tabs; no ResourcePageShell |
| **C. Traces hub shell** | `PageContent` + `ResourcePageShell` + `QueryFilterBar` / `ViewsMenu` / facets |

**Hub relation legend**
- **Embed+redirect** — list URL 301/redirects to hub `?tab=` / `?view=`; same module `dynamic()`-imported under `EmbeddedSurface`
- **Embed-only** — reachable nested path; also embedded in a hub
- **Live orphan** — filesystem route still served; not sidebar-primary; weak/no hub embed

---

## 1. Studio

| Field | Detail |
|---|---|
| **Routes / files** | `/studio` → `studio/page.tsx` (redirect → `/evals?tab=studio`) |
| **Layout** | **B** — `PageContent size="wide"` + `PageHeader` (eyebrow Eval); inner `Tabs` (`templates` / `examples` / `metrics`) |
| **Form density** | High: multi-field example rows (`space-y-2` cards, `grid-cols-2`), generate/save flows, dirty-tab confirm; detail/seed **Dialogs** |
| **Table patterns** | `DataTable` for templates + my-metrics |
| **Hub relation** | **Embed+redirect** into `/evals` (`StudioView`) |
| **Shared-template opportunity** | Same B-shell as Synthetic/Labeling list; already on Evals tab rail — could drop duplicate header chrome when only used embedded (already partially via `EmbeddedSurface`) |

---

## 2. Fleet

| Field | Detail |
|---|---|
| **Routes / files** | `/fleet` → `fleet/page.tsx` (redirect → `/agents?tab=fleet`) |
| **Layout** | **A** — `CoreResourcePage` + `PageHeader`; respects `useEmbeddedSurface()` (hides `CrossLinkBar` when embedded) |
| **Form density** | Low — no create forms; local tab pill (`agents` / `heatmap` / `delegation`); KPI `Card` strip |
| **Table patterns** | **Not DataTable** — agent **card grid**; custom heatmap matrix; delegation edge list |
| **Hub relation** | **Embed+redirect** into `/agents` (`FleetView`) |
| **Shared-template opportunity** | KPI strip + segmented tabs match Agents hub / Observability KPI tiles; card-grid vs Agents’ card list already parallel |

---

## 3. Observability / `observability/*`

| Route | File | Redirect? | Also embedded? |
|---|---|---|---|
| `/observability` | `observability/page.tsx` | → `/traces` | Landing only (dead URL) |
| `/observability/query` | `query/page.tsx` | → `/traces?view=query` | Traces `view=query` |
| `/observability/eval` | `eval/page.tsx` | → `/evals?tab=eval` | Evals hub |
| `/observability/mcp` | `mcp/page.tsx` | → `/traces?facet=mcp` | Traces facet embed |
| `/observability/decisions` | `decisions/page.tsx` | → `/traces?facet=decisions` | Traces facet embed |
| `/observability/memory` | `memory/page.tsx` | → `/traces?facet=memory` | Traces facet embed |
| `/observability/retrieval` | `retrieval/page.tsx` | → `/traces?facet=retrieval` | Traces facet embed |
| `/observability/time-travel` | `time-travel/page.tsx` | → `/traces?view=time-travel` | Traces legacy embed |
| `/observability/cohorts` | `cohorts/page.tsx` | → `/traces?view=cohorts` | **Redirect shipped; hub embed MISSING** (falls back to list) |

> Deeper band counts / competing-UI: [`w1-leaf-observability.md`](./w1-leaf-observability.md) · Advanced: [`w1-leaf-advanced.md`](./w1-leaf-advanced.md) · Redirects: [`w1-redirect-audit.md`](./w1-redirect-audit.md) · Embeds: [`w1-embed-surfaces.md`](./w1-embed-surfaces.md).

| Field | Detail |
|---|---|
| **Layout** | Children: **B** (`PageContent size="wide"` + `PageHeader` eyebrow Observe). Landing: KPI tiles + subpage cards (redirected away). Parent observe hub: **C** (`/traces`) |
| **Form density** | Medium–high on query/cohorts (SQL / DSL editors); eval has deploy form fields; decisions/memory/retrieval: filter + action cards; mcp: server select + tool panels |
| **Table patterns** | `DataTable` (memory, retrieval, eval); mcp custom panels; cohorts result cards; traces list uses `InfiniteDataTable` via `TracesTab` |
| **Hub relation** | Bare hub **redirected**. Facet + time-travel soft-nested under Traces (redirect+embed). **cohorts** redirect exists but Traces does not register `view=cohorts` — soft-nest GAP |
| **Shared-template opportunity** | All 8 children share B + ErrorState + `loading.tsx` skeletons (enforced by `w5-4-hub-children.test.ts`). Strong candidate for one “Observe leaf” shell (header + Card + DataTable + retry) |

---

## 4. Guardrails / Redteam

| Field | Detail |
|---|---|
| **Routes / files** | `/guardrails` → `guardrails/page.tsx` (Advanced sidebar “Guardrails”). `/redteam` → `redteam/page.tsx` (redirect → `/guardrails?tab=redteam`) |
| **Layout** | Guardrails: **B** + local `useQueryTab` (`test` / `policies` / `injections` / `pii` / `redteam`). Redteam: **B** standalone (embedded under redteam tab) |
| **Form density** | High on test tab: large mono `Textarea`, scan/evaluate actions; **AddPolicyDialog** (name + kind + JSON `Textarea`). Redteam: single endpoint `Input` + submit |
| **Table patterns** | Guardrails: multiple `DataTable`s (policies, injection/PII history). Redteam: findings `DataTable` + `SeverityBadge` |
| **Hub relation** | Guardrails = **Advanced nav hub**. Redteam = **Embed+redirect** |
| **Shared-template opportunity** | Same B + underline/query tabs as Optimization; policy/scan history tables share DataTable column patterns with Signals |

---

## 5. Optimization (Cost)

| Field | Detail |
|---|---|
| **Routes / files** | Hub: `/optimization` → `optimization/page.tsx` (Advanced “Cost”). Children (filesystem, **no redirect**): `budget/page.tsx`, `outcomes/page.tsx`, `predict/page.tsx`, `model-advisor/page.tsx`; cost tab = `_components/finops-explorer.tsx` |
| **Layout** | Hub: **B** + Radix `Tabs` underline + `EmbeddedSurface`. Children: own **B** headers (budget/outcomes use default `PageContent`; predict/advisor `wide` inconsistently) |
| **Form density** | Budget: guardrail controls; model-advisor: dense multi-`Input` pricing/constraints; predict: mostly read + tables; finops: dimension selectors |
| **Table patterns** | `DataTable` in finops-explorer, outcomes, predict (×2) |
| **Hub relation** | Hub = Advanced nav. Children = **Embed-only nested orphans** (still deep-linkable as full pages) |
| **Shared-template opportunity** | Unify child `PageContent` size; extract shared Cost leaf shell (header suppressed when embedded) — same pattern as Evals embeds |

---

## 6. Insights / Analytics

| Field | Detail |
|---|---|
| **Routes / files** | Hub: `/analytics` → `analytics/page.tsx` (Advanced). Embeds: `insights/page.tsx`, `insights/topics/page.tsx`, `tools/page.tsx`, `users/page.tsx`. Redirects: `/insights`, `/insights/topics`, `/tools`, `/users` → analytics tabs |
| **Layout** | Analytics hub: **B** + custom tablist (`overview` / `insights` / `topics` / `tools` / `users`). Insights: nested Tabs (`overview` / `insights` / `closed-loop`). Topics: facet chips + list/scatter (no PageHeader when? — check: topics has no PageHeader import in first 80 lines — lean body). Users: **B** wide |
| **Form density** | Low–medium: insights = actions (Run Detectors); topics = generate/act menus; overview = day-range toggles only |
| **Table patterns** | Insights: `DataTable` + cards; Users: many `DataTable`s; Topics: custom list (not DataTable); Overview: charts + `DataTable` in `overview-charts.tsx` |
| **Hub relation** | **Embed+redirect** for all four leaf URLs; Analytics = Advanced sidebar |
| **Shared-template opportunity** | Analytics hub still uses raw `PageContent` (not CoreResourcePage) unlike Evals/Agents — factual gap for consistent hub chrome |

---

## 7. Labeling

| Field | Detail |
|---|---|
| **Routes / files** | `/labeling` → `labeling/page.tsx` (redirect → `/evals?tab=labeling`). Detail: `/labeling/queues/[id]` → `labeling/queues/[id]/page.tsx` (**live**, not redirected) |
| **Layout** | List: **B**. Queue board: **B** + kanban/workstation (`FormField`, hotkeys) |
| **Form density** | List: review **Dialog** (Select label + Textarea notes). Board: annotation notes + dataset push `Input` — medium density |
| **Table patterns** | List: `DataTable` + `DataTableSearch` for items; queues as cards/list. Board: **kanban columns** (not DataTable) |
| **Hub relation** | List = **Embed+redirect** into Evals. Queue detail = **live orphan detail** (linked from labeling list / evals) |
| **Shared-template opportunity** | List aligns with Datasets/Experiments InfiniteDataTable hubs; board is a unique workstation pattern (shared only with Improve queue kanban conceptually) |

---

## 8. Tools

| Field | Detail |
|---|---|
| **Routes / files** | `/tools` → `tools/page.tsx` (redirect → `/analytics?tab=tools`) |
| **Layout** | **B** + local Tabs (`attribution` / `compare` / `recommender` / `taxonomy`) |
| **Form density** | Medium: tool_id / A-B selects, window pickers, task-type input — action-then-result, not dense CRUD |
| **Table patterns** | `DataTable` + metric cards |
| **Hub relation** | **Embed+redirect** into Analytics |
| **Shared-template opportunity** | Same “action form → DataTable result” as Observability memory/retrieval and Redteam scan |

---

## 9. Other Advanced / orphan leaves under `(portal)`

| Surface | Route(s) | Files | Layout | Hub relation |
|---|---|---|---|---|
| **Prompts** | `/prompts` | `prompts/page.tsx` | B + create forms | Advanced sidebar; **standalone** |
| **Debug sessions** | `/debugger-sessions`, `/debugger-sessions/[id]` | `debugger-sessions/page.tsx`, `[id]/page.tsx` | A (list) | Advanced sidebar; **standalone** |
| **Synthetic** | `/synthetic` | `synthetic/page.tsx` | B + 2× DataTable | **Embed+redirect** → Evals |
| **Inspector / Replay / Debugger** | `/inspector`, `/replay`, `/debugger` | matching `page.tsx` | B (legacy) | **Redirect** → `/traces?view=…` + embed |
| **Signals** | `/signals` | `signals/page.tsx` | B + DataTable | **Embed+redirect** → Alerts |
| **Incidents list** | `/incidents` | `incidents/page.tsx` | DataTable | **Redirect** → Issues; detail `/incidents/[cluster_id]` live |
| **Improve leaves** | `/improve/scorecard`, `change-impact`, `online-scoring` | under `improve/` | A or B | **Live orphans** (CrossLinkBar only; not Improve tabs). Plans/runs list redirect into Improve tabs; `/improve/plans/[id]` detail live |
| **Onboarding loop** | `/onboarding/improvement-loop` | `onboarding/improvement-loop` | — | Live utility; `/onboarding` redirects to dashboard |
| **Agents connect** | `/agents/connect` | `agents/connect/page.tsx` | flow | Detail leaf off Agents |
| **Sessions detail** | `/sessions/[sessionId]` | — | — | Deep link (not Advanced nav) |
| **Settings advanced** | `/settings/webhooks-dlq` | settings tabs | — | Advanced child under Settings |

---

# Orphan route list (COMPLETE)

**Definition:** filesystem route still meaningful as a leaf, and either (a) redirected list URL whose module only lives for hub embed, or (b) live nested URL with no Advanced/core sidebar entry.

### A. Redirected list shells (module kept for hub embed)

| Orphan path | Canonical hub |
|---|---|
| `/studio` | `/evals?tab=studio` |
| `/fleet` | `/agents?tab=fleet` |
| `/labeling` | `/evals?tab=labeling` |
| `/synthetic` | `/evals?tab=synthetic` |
| `/tools` | `/analytics?tab=tools` |
| `/insights` | `/analytics?tab=insights` |
| `/insights/topics` | `/analytics?tab=topics` |
| `/users` | `/analytics?tab=users` |
| `/redteam` | `/guardrails?tab=redteam` |
| `/observability` | `/traces` |
| `/observability/query` | `/traces?view=query` |
| `/observability/eval` | `/evals?tab=eval` |
| `/inspector` | `/traces?view=inspect` |
| `/replay` | `/traces?view=replay` |
| `/debugger` | `/traces?view=debug` |
| `/signals` | `/alerts?tab=signals` |
| `/datasets` | `/evals?tab=datasets` |
| `/playgrounds` | `/evals?tab=playgrounds` |
| `/experiments` | `/evals?tab=experiments` |
| `/incidents` | `/issues?tab=incidents` |
| `/improve/plans` | `/improve?tab=plans` |
| `/improve/runs` | `/improve?tab=history` |
| `/observability/mcp` | `/traces?facet=mcp` (module = facet embed) |
| `/observability/decisions` | `/traces?facet=decisions` |
| `/observability/memory` | `/traces?facet=memory` |
| `/observability/retrieval` | `/traces?facet=retrieval` |
| `/observability/time-travel` | `/traces?view=time-travel` |
| `/observability/cohorts` | `/traces?view=cohorts` — **redirect OK; hub embed GAP** |

### B. Live nested orphans (no redirect; weak/no sidebar)

| Orphan path | Notes |
|---|---|
| `/optimization/budget` | Embedded in Cost hub; **deep-link dual chrome** |
| `/optimization/outcomes` | Embedded in Cost hub |
| `/optimization/predict` | Embedded in Cost hub |
| `/optimization/model-advisor` | Embedded in Cost hub |
| `/labeling/queues/[id]` | Labeling workstation detail |
| `/improve/scorecard` | Cross-linked only |
| `/improve/change-impact` | Cross-linked only |
| `/improve/online-scoring` | Cross-linked only |
| `/improve/plans/[id]` | Plan detail |
| `/incidents/[cluster_id]` | Incident detail |
| `/onboarding/improvement-loop` | Improve onboarding utility |
| `/debugger-sessions/[id]` | Detail under Advanced list |
| `/agents/connect` | Connect flow |
| `/sessions/[sessionId]` | Session deep link |
| `/settings/webhooks-dlq` | Advanced settings leaf |

### C. Advanced sidebar hubs (not orphans — listed for completeness)

`/agents`, `/analytics`, `/optimization`, `/guardrails`, `/prompts`, `/debugger-sessions`, `/alerts?tab=signals` (via Advanced Signals item).

---

## Cross-cutting shared-template opportunity (factual)

1. **Observe leaf shell** — 6–8 `observability/*` pages already share B + ErrorState + loading skeleton; dual facet vs dedicated URLs are the main inconsistency.
2. **Cost child shell** — 4 optimization children + finops: same B/DataTable family; `PageContent` size and header-when-embedded not unified.
3. **Analytics hub vs Evals/Agents** — Analytics still **B-only**; Evals/Agents/Fleet/Debugger-sessions use **CoreResourcePage (A)**.
4. **Action→DataTable leaves** — Tools, Redteam, Observability memory/retrieval, Guardrails scan history: same interaction shape, different wrappers.
5. **EmbeddedSurface** already suppresses `PageHeader` chrome — opportunity is structural (one leaf component), not a new visual system.

---

**Evidence to look at**
- Redirects: `clients/portal/next.config.ts` (~109–171), `clients/portal/src/lib/portal-hub-redirect.ts`
- Advanced nav: `clients/portal/src/lib/sidebar-config.ts` (`category: "advanced"`)
- Hub embeds: `evals/page.tsx`, `agents/page.tsx`, `analytics/page.tsx`, `optimization/page.tsx`, `guardrails/page.tsx`, `traces/page.tsx` (`FACET_VIEWS` / `LEGACY_VIEWS`)
- Page inventory: 75 `page.tsx` under `app/(portal)`