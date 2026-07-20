# Wave 2/4 — Datadog LLM Observability density calibration

**Agent:** `w4-datadog-density` (refresh of `w2-datadog-llm`)  
**Date:** 2026-07-20  
**Status:** Wave 4 refresh — role density without header packing  
**Mode:** Research + docs only (no product UI)  
**Peer:** Datadog Agent Observability (formerly LLM Observability)  
**Eden baseline:** [`w1-consolidated-inventory.md`](./w1-consolidated-inventory.md), [`w1-density-grep.md`](./w1-density-grep.md), [`w1-hub-surfaces.md`](./w1-hub-surfaces.md)  
**Binding peers:** [`w3-density-rules.md`](./w3-density-rules.md) · [`w4-anti-clutter-contract.md`](./w4-anti-clutter-contract.md)

**Job:** Enterprise density calibration — when dense is OK vs when it fails. Inform Eden **overview vs analysis** surface rules. **Do not** pack more controls into hub headers to “match” instrument density.

---

## 0. Verdict (one line)

Datadog treats density as a **surface role**, not a global skin: **overview/monitor breathes**; **trace/span instrument panels stay dense**. Eden’s Wave 1 hotspot list is mostly correct micro-counts, but **mis-applies instrument density to hubs** and has **no role-based density contract**.

---

## 1. Sources

### Primary docs (docs.datadoghq.com)

| Source | URL | What it shows (density-relevant) |
|---|---|---|
| Agent Observability overview | https://docs.datadoghq.com/llm_observability/ | Trace list (prompt–response rows); Operational Insights dashboard; Patterns topic detail; Insights banner; span error/side-panel tabs |
| Monitoring | https://docs.datadoghq.com/llm_observability/monitoring.md | OOTB dashboard sections (Overview KPIs + LLM Calls charts); trace detail with flame graph + I/O; Evaluations tab; Trace Explorer query + result table |
| Querying spans/traces | https://docs.datadoghq.com/llm_observability/monitoring/querying.md | Trace Explorer = APM-class query bar + dense result list; Traces vs Spans mode |
| Metrics | https://docs.datadoghq.com/llm_observability/monitoring/metrics.md | Metrics roll up for **dashboards/monitors**; raw per-span data stays in Traces explorer |
| Terms & concepts | https://docs.datadoghq.com/llm_observability/terms/ | Span kinds (LLM / Workflow / Agent / Tool / Task / Embedding / Retrieval); inference vs workflow vs agent trace shapes |
| APM Trace View (shared DNA) | https://docs.datadoghq.com/tracing/trace_explorer/trace_view/ | Flame / Waterfall / Span List / Map; focus-on-span; Trace Preview for huge traces; height-adjustable detail tabs |

### Product / blog (screenshots + UX framing)

| Source | URL | Density signal |
|---|---|---|
| GA announcement | https://www.datadoghq.com/blog/datadog-llm-observability/ | Trace list for errors/latency; **OOTB dashboards = consolidated overhead view** (explicit overview language) |
| Chain tracing | https://www.datadoghq.com/blog/llm-observability-chain-tracing/ | Full agent trace screenshot; span hierarchy for debugging |
| Azure OpenAI + Agent Obs | https://www.datadoghq.com/blog/monitor-azure-openai-service-datadog-llm-observability/ | Operational Insights dashboard as org-scale health; span side panel for quality checks |
| LangGraph monitoring | https://www.datadoghq.com/blog/langgraph-agent-monitoring/ | Flame graphs for step latency; correlate to APM/infra without dumping infra into overview |
| Product marketing | https://www.datadoghq.com/product/ai/llm-observability/2/ | Role split: ship/eval vs monitor vs unify — different jobs, not one dense page |
| DASH 2026 Trace Patterns | https://www.datadoghq.com/blog/dash-2026-new-feature-roundup-observability/ | Clustered patterns ranked by volume/error/latency — aggregate surface, not raw span dump |

### Eden Wave 1 anchors

| Finding | Evidence |
|---|---|
| Top density file = `TranscriptView.tsx` (score ~84–86) | `w1-density-grep.md` §2, §5; inventory §6 |
| Micro-type dominated by `text-[10px]`×256, `py-0.5`×148 | inventory §0, §6 |
| Dashboard hub = **1 chrome band**, widget grid | `w1-hub-surfaces.md` §1 |
| Traces hub = **3 chrome bands** (critical overload) | inventory §7.1; hub-surfaces §2 |
| Density is attribute-only (`comfortable` \| `compact`); **0** `--density-*` tokens; U19 program MISSING | inventory §5.1, §10; `w1-specs-gap.md` |
| Instrument-class leaves also dense: `TraceDetailPanel`, `ParallelToolLane`, query/time-travel | density-grep top 30 |

---

## 2. Density calibration rules (peer → Eden)

### Rule R1 — Surface role before type size

| Role | Datadog exemplar | Dense OK? | Failure mode |
|---|---|---|---|
| **Overview / monitor** | Operational Insights dashboard; Monitor page + Insights banner | **No** — KPI cards, sectioned charts, sparse chrome | Wall of micro-stats, stacked toolbars, card spam |
| **Explorer / list** | Trace Explorer (query + rows) | **Yes, calibrated** — row density for scan; chrome stays thin | Triple chrome + micro filters (Eden Traces) |
| **Instrument panel** | Trace side panel: flame/waterfall + I/O + Errors/Evals tabs | **Yes** — maximum info for RCA | Same density on Home/Alerts hubs |
| **Aggregate / patterns** | Patterns topics; Trace Patterns clusters | **Medium** — table + KPI strip, not span I/O | Dumping full transcripts into hub body |

**Eden mapping:**

| Eden surface | Target role | Wave 1 gap |
|---|---|---|
| `/dashboard` (Home) | Overview — **must breathe** | 1 band OK structurally; no explicit breathe contract; risk of widget micro-type creep |
| Traces hub list | Explorer | **P0:** 3 bands overload before content |
| `TranscriptView` / transcript-v2 / `TraceDetailPanel` | Instrument | Dense OK **if** confined to analysis; score 86 is not automatically a bug |
| `observability/query`, time-travel, replay | Instrument / analysis | Dense OK; still avoid raw accent-button drift |
| Alerts / fleet / guardrails hubs | Overview-ish / ops hubs | **P0:** instrument micro applied to hub (`text-[10px]` + tight `py-0.5`) |
| Evals / Improve / Agents hubs | Hub chrome + domain body | Body may densify; chrome must stay ≤2 bands |

### Rule R2 — Overview breathes; instrument panels pack

Datadog docs/screenshots consistently show:

1. **Dashboard:** Overview section (totals, success/error rates) + LLM Calls section (donut, token averages) — **sectioned**, chart-led, not 10px label forests.
2. **Insights banner:** One horizontal anomaly strip (“8 insights” + View Insights → **side panel**). Density deferred to a panel, not the overview canvas.
3. **Trace detail:** Flame graph + selected span I/O + tabbed Errors / Evaluations — **instrument density by design**.

**Calibration test for Eden:**

> If removing micro-type (`text-[10px]`) and `py-0.5` would make RCA harder → surface is **instrument** (keep density, use tokens).  
> If removing them improves scan/orientation → surface is **overview/hub** (breathe; ban instrument density).

### Rule R3 — Dense fails when chrome eats the viewport

Datadog Trace Explorer keeps identity + query as a **thin** top stack; detail density lives in the panel. APM Trace View further offers Focus / Preview so large traces do not force full-tree density.

Eden Wave 1: Traces = PageHeader + tabs/legacy + facets/filters (**3 bands**) → density fails **before** the list, even if list density is peer-correct.

### Rule R4 — Metrics on overview; payloads on instrument

Datadog separates `ml_obs.*` metrics (dashboards/monitors, 15-month retention) from per-span I/O (Traces explorer, shorter retention). Overview never inlines full prompt/completion walls.

Eden: Dashboard/RecentTraces should stay **summary**; full prompt/tool lanes belong in TranscriptView / detail panel.

### Rule R5 — Progressive disclosure beats always-on density

Peer patterns: Insights → side panel; Patterns topic → detail table; Trace Preview → critical spans first; Expand/Collapse / Focus on span.

Eden anti-gap: hubs that show every control (legacy links + facets + filters) at once without progressive disclosure.

### Rule R6 — Global density toggle ≠ surface role

Eden `DensityProvider` (`comfortable` \| `compact`) is shell-wide. Datadog effectively has **role-local** density (dashboard vs explorer vs panel) independent of a single skin.

**Wave 2 implication:** U19 should define **surface density classes** (`overview` | `explorer` | `instrument`), not only comfort/compact.

---

## 3. Pattern library (name · peer · Eden gap · priority)

Each pattern: **Name**, **Peer (Datadog)**, **Eden gap (Wave 1)**, **P0–P2**.

### P-DD-01 · Overview breathes (sectioned KPI + charts)

| | |
|---|---|
| **Name** | Overview / Operational Insights canvas |
| **Peer** | OOTB Operational Insights dashboard: Overview + LLM Calls sections; chart/KPI layout with breathing room ([monitoring.md](https://docs.datadoghq.com/llm_observability/monitoring.md), GA blog) |
| **Eden gap** | Dashboard is structurally 1-band (`w1-hub-surfaces` §1) but **no documented breathe rule**; micro-type tokens unused while arbitrary `text-[10px]` dominates portal-wide; U19 MISSING |
| **Priority** | **P0** |

### P-DD-02 · Insights as banner → panel (not hub clutter)

| | |
|---|---|
| **Name** | Anomaly Insights strip |
| **Peer** | Insights banner on Monitor page; details in side panel ([llm_observability/](https://docs.datadoghq.com/llm_observability/)) |
| **Eden gap** | Home/insights surfaces mix cards and micro UI; no single “anomaly strip → panel” contract; ApprovalCard / insights micro-type (density top 30) |
| **Priority** | **P1** |

### P-DD-03 · Trace Explorer = thin chrome + dense rows

| | |
|---|---|
| **Name** | Explorer density split |
| **Peer** | Query bar + Traces/Spans toggle + dense result table; shared APM query syntax ([querying.md](https://docs.datadoghq.com/llm_observability/monitoring/querying.md)) |
| **Eden gap** | Traces hub **3 chrome bands** + facet chips + legacy links (`w1-hub-surfaces` §2; inventory §7.1) — explorer density drowned by chrome |
| **Priority** | **P0** |

### P-DD-04 · Instrument panel OK-dense (flame + I/O + tabs)

| | |
|---|---|
| **Name** | Analysis / instrument panel |
| **Peer** | Trace detail: flame graph, selected span I/O, Errors / Evaluations tabs; APM Waterfall/Flame/Focus |
| **Eden gap** | `TranscriptView` #1 hotspot (score 86) treated as global density failure; should be **classified instrument** and tokenized (`--font-size-2xs/3xs`) rather than “undensified into overview” |
| **Priority** | **P0** (classify + confine; do not flatten instrument to hub spacing) |

### P-DD-05 · Hub ≠ instrument skin

| | |
|---|---|
| **Name** | Surface-role density gate |
| **Peer** | Dashboards/monitors stay chart-led; span I/O stays in panels |
| **Eden gap** | Alerts (score 62), guardrails (70), fleet (43), studio (54) apply instrument micro-type to hub/ops pages (`w1-density-grep` §5) |
| **Priority** | **P0** |

### P-DD-06 · Aggregate Patterns surface (medium density)

| | |
|---|---|
| **Name** | Topic / pattern clustering view |
| **Peer** | Patterns hierarchical topics + KPI strip + interaction table; Trace Patterns clusters ([docs](https://docs.datadoghq.com/llm_observability/), DASH 2026) |
| **Eden gap** | Topics/insights/analytics leaves exist (`w1-leaf-surfaces`) without a shared medium-density recipe; risk of TranscriptView-level packing on aggregate pages |
| **Priority** | **P1** |

### P-DD-07 · Progressive disclosure for large traces

| | |
|---|---|
| **Name** | Focus / Preview / expand |
| **Peer** | Focus-on-span; Trace Preview for >100MB; expand/collapse waterfall ([trace_view](https://docs.datadoghq.com/tracing/trace_explorer/trace_view/)) |
| **Eden gap** | Nested interactive risk still open on TranscriptView (`w1-specs-gap` AUDIT H2); no Preview-equivalent for huge agent runs |
| **Priority** | **P1** |

### P-DD-08 · Metrics vs payload separation

| | |
|---|---|
| **Name** | Rollup on overview, payload on analysis |
| **Peer** | `ml_obs.*` metrics for dashboards; span I/O in explorer ([metrics.md](https://docs.datadoghq.com/llm_observability/monitoring/metrics.md)) |
| **Eden gap** | Dashboard RecentTraces / widgets can drift toward detail density; no written rule tying overview widgets to rollups only |
| **Priority** | **P1** |

### P-DD-09 · Role-local density > global compact toggle

| | |
|---|---|
| **Name** | Density classes by surface |
| **Peer** | Implicit: dashboard vs explorer vs panel use different packing regardless of one theme |
| **Eden gap** | `data-density` comfortable/compact only; `data-density="dense"` touch opt-out unused (`w1-specs-gap` H3); no `--density-*` tokens |
| **Priority** | **P0** (U19 foundation) |

### P-DD-10 · Correlate out, don’t inline foreign density

| | |
|---|---|
| **Name** | Cross-product correlate links |
| **Peer** | APM ↔ Agent Observability links; infra/logs in tabs, not overview body ([monitoring.md](https://docs.datadoghq.com/llm_observability/monitoring.md)) |
| **Eden gap** | CrossLinkBar uneven (absent on Traces hub chrome); legacy deep-links inflate Traces toolbar instead of correlate-out |
| **Priority** | **P2** |

---

## 4. Eden mappings (concrete)

### 4.1 OK to stay dense (instrument / analysis)

| Surface | Why (peer) | Wave 1 note |
|---|---|---|
| `components/observability/TranscriptView.tsx` | Span I/O + step tree = instrument panel | Highest score — **reclassify**, tokenize, a11y-fix; do not “breathe” into hub spacing |
| `components/transcript-v2/*` (e.g. `ParallelToolLane`) | Tool/agent lanes | Dense OK |
| `components/traces/TraceDetailPanel.tsx` | Peer trace side panel | Dense OK |
| `observability/query`, `time-travel`, `replay`, `debugger` | Analysis leaves | Dense OK; fix accent-btn drift separately |
| Span search / facet bodies **inside** detail | Explorer secondary | Dense OK once chrome thinned |

### 4.2 Must breathe (overview / hubs)

| Surface | Why (peer) | Wave 1 note |
|---|---|---|
| `/dashboard` Home | Operational Insights analogue | Keep 1-band; ban micro-type KPI forests |
| Traces **hub chrome** | Explorer chrome must be thin | Collapse to ≤2 bands (P0) |
| Alerts / Issues / Agents / Evals / Improve hub chrome | Ops hubs, not flame panels | Strip `text-[10px]` / `py-0.5` from chrome & primary lists |
| Guardrails / fleet **as hub-facing** | Not span I/O | Currently P0 density files — wrong role |
| Settings identity chrome | Not instrument | Double title / dual org already P0 chrome bugs |

### 4.3 Decision matrix (copy into U19)

| Question | Overview | Explorer | Instrument |
|---|---|---|---|
| `text-[10px]` / `2xs` | Forbidden on primary chrome | Allowed on table secondary meta | Allowed |
| `py-0.5` / `p-1` | Forbidden | Row padding may be compact | Allowed |
| Stacked chrome bands | ≤1–2 | ≤2 | Panel-local only |
| Full prompt/completion body | Never | Preview snippet only | Yes |
| Charts / KPI cards | Primary | Optional summary strip | Secondary |
| Touch `h-5`/`h-6` controls | Forbidden | Prefer ≥`h-8` for primary actions | Opt-out via explicit dense attr |

---

## 5. Anti-patterns (Datadog contrast → Eden risks)

| Anti-pattern | Why it fails | Eden Wave 1 evidence |
|---|---|---|
| **AP-1 Instrument skin on overview** | Users cannot orient; everything looks like a debugger | Alerts/guardrails/fleet micro-type hubs |
| **AP-2 Chrome density before content density** | Peer explorers pack rows, not identity bands | Traces 3 bands |
| **AP-3 Undifferentiating “fix density”** | Flattening TranscriptView to dashboard spacing destroys RCA | Treating score-86 as pure defect |
| **AP-4 Always-on facets + legacy links** | Progressive disclosure inverted | Traces toolbar: tabs + Inspector/Replay/Debugger/Time-Travel/Query + facets |
| **AP-5 Payload on Home** | Breaks metrics-vs-payload split | Risk on RecentTraces / widget detail creep |
| **AP-6 Global compact as only lever** | Wrong surfaces densify together | `DensityProvider` only; unused `dense` opt-out |
| **AP-7 Nested interactive micro-controls** | Accessibility + misclick | AUDIT H2 TranscriptView still open |
| **AP-8 Hub card/stat forests with 10px labels** | Fake “enterprise density” | portal-wide `text-[10px]`×256 without role gate |

---

## 6. P0 summary

| ID | Action for later waves (not implementing now) |
|---|---|
| **P0-1** | Adopt **surface density classes**: `overview` (breathe) · `explorer` (thin chrome + dense rows) · `instrument` (OK-dense panels). Wire into U19. |
| **P0-2** | **Dashboard / hubs must breathe** — ban instrument micro-type on Home, Alerts, Agents, Evals, Improve chrome + primary lists. |
| **P0-3** | **TranscriptView / TraceDetailPanel stay instrument** — keep density; migrate arbitrary `text-[9/10px]` → type tokens; fix nested interactive. |
| **P0-4** | **Traces hub chrome ≤2 bands** — peer explorer pattern; move legacy to correlate-out / overflow. |
| **P0-5** | Stop scoring density as a single portal-wide hotspot list without **role tags** — Wave 1 list is input, not the fix order. |

**Non-P0 (carry):** Insights banner→panel (P1), Patterns medium recipe (P1), Trace Preview/Focus (P1), metrics-vs-payload widget rule (P1), CrossLinkBar on Traces (P2).

---

## 7. Deliverable path

**Write path:** `docs/specs/ui/overhaul-2026/w2-datadog-llm.md`

**Consumers:** Wave 2 pattern library merge; U19 Density program; hub vs leaf spacing gates; TranscriptView remediation scoping.
