# IMPROVE V3 OBSERVATIONS — Wave 0.2 Peer capture

**Date:** 2026-07-21  
**Workspace:** `clients/portal`  
**Mode:** Research-only (no product UI edits)  
**Inputs:** `.research-wave0.md` (R3/R4/R6/R9), `.research-r4-ux-checklist.md`, `.cursor/visual-research/ai-portals/`, `.cursor/visual-research/evals-v3/`

---

## Method & auth gaps

| Source | Role |
|--------|------|
| `.research-wave0.md` | R3 Langfuse/Phoenix · R4 Helicone/Braintrust · R6 clutter · R9 Promptfoo/Traceloop |
| `.research-r4-ux-checklist.md` | Master–detail SHOULD; Improve empty → Start plan |
| `ai-portals/OBSERVATIONS.md` + `OBSERVATIONS-R10.md` | Density + product grammar from PNG corpus |
| `evals-v3/OBSERVATIONS.md` + peer notes | Diff/Summary, dataset actions, red-team matrix |

| Surface | Capture status |
|---------|----------------|
| Braintrust Diff / Summary / grades | **Blocked** — app login |
| Helicone Improve / Prompts | **Blocked** — marketing sidebar IA only |
| Langfuse Datasets → Experiment | **Blocked** — docs + public traces |
| Promptfoo red-team report | **Docs-only** |
| Traceloop prompt lifecycle | **Docs-only** |
| Laminar density | Marketing product mocks |

**Rule:** Prefer docs-canonical wireframes + marketing embeds for Improve flows. Do not invent pixel chrome from unauthenticated screenshots.

---

## Steal / don’t steal (Improve IA)

### Braintrust — Plan Diff / decide

| Steal | Don’t steal |
|-------|-------------|
| Baseline as noun; green/red deltas; Diff mode | Observe dark logs as Improve default |
| Grades: Improve / Regress / Tradeoff / Tie | Diff as a separate product/route |
| Layout: Summary \| List \| Grid | Card-wall Summary as only engineer surface |
| Playground mutable · Experiment immutable · promote | Overwriting plans like playground runs |

### Helicone — Improve nav + Cost strip

| Steal | Don’t steal |
|-------|-------------|
| Improve groups iterate tools (Prompts with act path) | Light SaaS card-grid as queue grammar |
| 3–5 hero KPI strip above work | Metric collage as plan/queue canvas |
| Monitor separate from Improve | Helicone-as-eval-compare |

**Eden adaptation:** Helicone puts Datasets/Playground under Improve; Eden keeps those in **Evaluate** (DESIGN.md: Evaluate=compare). Steal **Prompts → core Improve** only.

### Langfuse / Phoenix — closed-loop actions

| Steal | Don’t steal |
|-------|-------------|
| Prompts as first-class pillar | Flat mega-sidebar of every entity |
| Annotate → dataset → experiment scent | Executive pretty-dashboard as primary |
| Item × run compare; explanations beside scores | Marketing glow as Improve chrome |

### Promptfoo — Guardrails / red-team

| Steal | Don’t steal |
|-------|-------------|
| Summary → category → case → raw I/O | Promptfoo as long-lived ops shell |
| Failures-first; Failures ≠ Errors | Burying red-team as equal first-paint tab |

### Traceloop — Prompts lifecycle

| Steal | Don’t steal |
|-------|-------------|
| Draft → playground test → publish → env pin / rollback | Free-edit production without version pin |
| Hard publish/deploy boundary | Mega Prompt Hub catalog sprawl |

### Laminar — density bar (not IA nouns)

| Steal | Don’t steal |
|-------|-------------|
| H-density rows; meta on same line | Marketing hero emptiness |
| Callout above list; collapse I/O | Kanban as default (not in Laminar) |
| One accent; thin separators | Chat-with-trace as separate product |

**Tier-A PNGs:** `lmnr-home-scroll1.png`, `lmnr-home-scroll2.png` under `.cursor/visual-research/ai-portals/`.

---

## Queue: master–detail vs kanban

- **No peer** ships Improve-as-multi-column kanban as the default act surface.
- Closest: LangSmith annotation queues (list + focused review) + Linear master–detail (R4 S3).
- Eden debt (R6): `/improve` ~713 LOC shell with permanent column walls + More path links competing with act.

**V3 recommendation**

| Default | Opt-in / overflow |
|---------|-------------------|
| Prioritized queue list + master–detail (≥1280 split / drawer) | Kanban as Views option if cheap |
| Column states → Views: Needs you / In progress / Verify | Issues · Artifacts · Ledger · Prompts related strip |
| One primary CTA per selected item | Advanced leaves stay ⌘K / Advanced |

---

## Plan Diff / Summary grammar (docs wireframe)

```
Plan compare                    [Diff ▾] [Summary | List]
Baseline · Candidate
────────────────────────────────────────────────────────
SUMMARY — Grade: Improve | Regress | Tradeoff | Tie
  Δ scores · latency · cost · errors · risk
────────────────────────────────────────────────────────
DIFF (engineer) — unified | split; regressions first
```

Eden already has `DiffViewer` — add Summary panel (change / evidence / risk); preserve approve-toast honesty.

---

## Prompts lifecycle (docs wireframe)

```
draft → playground iterate (/evals?tab=playgrounds) → publish → env pin
                                                              ↕ rollback
```

Helicone grouping + Traceloop state machine. Do **not** merge with Studio.

---

## Guardrails report drill (docs wireframe)

```
Guardrails
├── Policies (primary)
├── Test (one progressive result)
└── More → Red team → Report
                      ├─ Severity / category rollup
                      ├─ Case list (failing first)
                      └─ Case detail: I/O + asserts
```

---

## Cost KPI + Model Advisor

| Layer | Pattern |
|-------|---------|
| Cost hub first paint | 3–5 KPI strip (Helicone) + one primary table |
| Model Advisor | Advanced side-by-side cost/latency/tokens (OpenLIT OpenGround) |
| Predict | Overflow modes — not a second underline tab wall |

Kill Outcomes StatCard soup; keep FinOps KpiCell grammar.

---

## Cross-cutting steal map

| Need | Primary peer | Grammar |
|------|--------------|---------|
| Act queue | LangSmith + R4 | List → detail; kanban opt-in |
| Plan decide | Braintrust | Diff + Summary + grade |
| Fail / security | Promptfoo | Failures-first report drill |
| Prompt ship | Traceloop | Draft → playground → publish → pin/rollback |
| Improve grouping | Helicone (adapted) | Prompts in core Improve; Datasets stay Evaluate |
| Cost glance | Helicone | KPI strip; Advisor advanced |
| Row density | Laminar | H-density transcript grammar |

Align with Evaluate V3: Curate → Run → Judge → Decide. Improve owns **Decide + Act**.

---

## Auth capture backlog (Wave 0.2b when unlocked)

- [ ] Braintrust: Compare · Diff · Summary grade · `+ Experiment`
- [ ] Helicone app: Improve sidebar · Prompts · Playground
- [ ] Langfuse: Dataset Start Experiment · multi-run Compare
- [ ] Promptfoo: Failures matrix · red-team drill
- [ ] Traceloop: publish / env deploy / rollback

Until then: plan from docs + this synthesis.

---

## Evidence index

```
clients/portal/.research-wave0.md
clients/portal/.research-r4-ux-checklist.md
.cursor/visual-research/ai-portals/OBSERVATIONS.md
.cursor/visual-research/ai-portals/OBSERVATIONS-R10.md
.cursor/visual-research/evals-v3/OBSERVATIONS.md
.cursor/visual-research/evals-v3/braintrust-notes.md
.cursor/visual-research/evals-v3/langfuse-phoenix-notes.md
.cursor/visual-research/evals-v3/promptfoo-langsmith-notes.md
```
