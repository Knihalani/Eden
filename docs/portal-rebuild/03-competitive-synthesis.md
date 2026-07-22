# 03 — Competitive Synthesis (Portal Rebuild)

> **Status:** Authoritative for rebuild UI grammar.  
> **Decision date:** 2026-07-21  
> **North-star UI:** Laminar (`laminar.sh`) — steal almost everything UX.  
> **Wedge:** Closed-loop **failure → artifact → PR** + **gateway + observe + improve**.  
> **Brand:** Dark-terminal Eden (Terminal Blue `#5B9EFF`, Phosphor Green running-only, Geist, dense instrument panel).

**Evidence corpus (do not modify):**

| Source | Path |
|--------|------|
| Wave 0 product captures | `.cursor/visual-research/ai-portals/OBSERVATIONS.md` (+ 78 PNGs) |
| Wave 0b visual grammar | `.cursor/visual-research/ai-portals-wave0b/OBSERVATIONS.md` |
| Wave R10 product-UI notes | `.cursor/visual-research/ai-portals/OBSERVATIONS-R10.md` |
| Evals peer grammar | `.cursor/visual-research/evals-v3/OBSERVATIONS.md` |
| Prior design (superseded) | `clients/portal/DESIGN.md` |
| Brand tokens | `.impeccable.md` |
| Locked decisions | `docs/portal-rebuild/README.md`, `04-interview-log.md` |

**How to use this doc:** For each competitor, tables are **Steal** (copy interaction grammar), **Adapt** (keep idea, re-skin to Eden tokens / closed-loop), **Skip** (conflicts with wedge, brand, or density). Pixel grammar = layout proportions, chrome budget, type hierarchy, border language — not competitor brand colors.

---

## 0. Synthesis thesis

Trace/debug leaders converge on one grammar: **high density + adjacent context** (list/tree + inspector, or transcript accordion) on a **near-black or paper** canvas, **one accent**, semantic colors only for fail/success/cost/tokens, **slim chrome** (≤~56px header), Filter/Search/time/LIVE inside the **list pane**, not a second global bar.

Eden’s job is not to invent a new grammar. Eden’s job is:

1. **Copy Laminar’s product feel wholesale** (agent-first, transcript, Signals, clusters → evals, chat-with-trace, debugger sessions, density).
2. **Bolt TraceRoot’s Improve loop** (detectors → findings → RCA → Show Code/git → PR) onto that grammar.
3. **Borrow Langfuse inspector mechanics** (tree+detail, pills, I/O split, public share) where Laminar is inline-only.
4. **Borrow Braintrust for Evals compare** and dense fleet logs.
5. **Borrow Helicone only for Cost/gateway dashboard cards** — never as Traces grammar.
6. **Differentiate** by composing **gateway + observe + improve + PR** as one product OS — peers specialize in observe *or* eval *or* gateway *or* self-heal; Eden owns the closed loop.

User hate list (interview): clutter, wrong placement, bad components, broken mobile. Competitive synthesis must therefore also encode **anti-clutter** and **mobile drawer** rules — see Design System V2.

---

## 1. Laminar — PRIMARY (steal almost everything UX)

**Product:** [laminar.sh](https://laminar.sh/) (formerly lmnr.ai)  
**Evidence:** `lmnr-home-scroll1.png`, `lmnr-home-scroll2.png`, `lmnr-docs-scroll0.png`, R10 §1, Wave0b §1  
**Access note:** App is login-walled; product grammar from marketing embeds + docs. Docs are full-dark with orange active underline + ⌘K.

### 1.1 Mental model

| Concept | Laminar pattern | Eden mapping |
|---------|-----------------|--------------|
| Primary object | **Agent / project** as first-class home | Dashboard + Agents hub land first (D4/D5) |
| Trace reading | Chronological **transcript** of steps (not equal-weight span tree) | Traces default = Transcript; Tree/Timeline = Mode |
| Diagnosis | **Signals** callout above transcript (blue box in mock) | Issues / Alerts / detector findings strip |
| Clustering | Signals → clusters of related failures | Issues clusters; “Create eval from cluster” |
| Conversation | **Chat with trace** overlay on dense UI | AI Agent page + floating bubble (D6); overlay/rail, not separate product |
| Iteration | Debugger **sessions** / multi-run playground | Debugger sessions / replay / time-travel (must-ship) |
| Docs = product | Full dark brand (marketing ≈ product) | Portal dark-only; docs site separate but token-aligned |

### 1.2 Nav mental model

- Marketing/docs: slim top bar; product mocks emphasize **pane-local tabs** (`Trace` / `Chat` / `Signals`) over fat IA.
- Docs: ~20% left tree, orange active, ⌘K search, Dashboard link.
- **Eden steal:** Flat sidebar groups (Observe / Evaluate / Improve / Workspace); **pane-local Mode tabs** on the work surface (`Transcript` | `Tree` | `Timeline` | `Meta` | `Scores`). Do not invent a second “Observe” hub.

### 1.3 Transcript grammar (pixel-level)

| Element | Spec to copy |
|---------|--------------|
| Row anatomy | Icon (span kind) + step name left; **duration · tokens · cost** right-aligned on **same row** |
| Separators | Hairline 1px rules; **no card-per-step** |
| Expand | Inline In/Out with “… more” collapse — accordion, not full-page hop |
| Meta line | One summary strip above list: total duration / tokens / $ |
| Signals | Diagnosis callout **above** transcript, not buried in sidebar |
| Density | High — metadata rides the row; collapse I/O by default |
| Type | Geometric sans for chrome; **mono for span names / code chips** |
| Color (their brand) | Near-black + muted orange CTA + typed row tints (LLM purple / bash gold) + red Failure |
| Color (Eden remaps) | Near-black ladder + `--accent` `#5B9EFF` CTA + span semantic tokens + `--error` Failure — **never** Laminar orange as Eden brand |

### 1.4 Signals / clusters / evals-from-clusters

| Laminar behavior | Eden steal |
|------------------|------------|
| Signals box flags failures worth attention | Issues + Alerts share the same “attention strip” grammar |
| Cluster related bad runs | Issues = cluster object; Evidence links preserve time/filters |
| Path from cluster → dataset / eval | **Create eval / add to dataset** from cluster selection (closed loop into Evaluate) |
| Noise filtered, signal prioritized | Detectors/findings feed Issues; raw traces stay Triage |

### 1.5 Debugger sessions

| Laminar behavior | Eden steal |
|------------------|------------|
| Multi-run debug sessions as first-class objects | `/debugger` (or Sessions-adjacent) with replay / time-travel |
| Session = saved investigation context | Persist selected spans, notes, linked artifacts/PRs |
| Compare runs inside session | Side-by-side or Diff mode borrowed from Braintrust compare grammar |

### 1.6 Chat-with-trace

| Laminar behavior | Eden steal / adapt |
|------------------|--------------------|
| Floating overlay on **dense** dashboard | Overlay or right rail; **data stays visible underneath** |
| Not a separate “Ask product” | Eden: **one surface** — Agent page + bubble + ⌘K/⌘J open same stack (D6) |
| Cited to the open trace | Citations must deep-link `?traceId=` / `?spanId=` |

### 1.7 Density & chrome

| Rule | Laminar | Eden |
|------|---------|------|
| Product density | High | High (Comfortable default / Compact toggle) |
| Marketing density | Very low | N/A for portal |
| Accent | Single muted orange | Single Terminal Blue |
| Filter chrome | Pane tabs + meta line; no fat filter strip in transcript mock | ≤5 primary toolbar actions; rest Overflow / ⌘K |
| Shadows | Flat, hairline | Flat, hairline — no glow kits |

### 1.8 What Eden must copy (pixel-grammar checklist)

1. Transcript rows with **inline metrics** (latency · tokens · cost).
2. **Signals-style** diagnosis strip above the reader.
3. Pane-local **Mode** tabs, not equal-weight global nav for Trace/Chat/Signals.
4. Chat as **overlay on density**, not a second home.
5. Agent / project as **landing emotional center**.
6. Collapse I/O by default; expand on demand.
7. Mono chips for span identity; sans for prose/chrome.
8. Dark canvas end-to-end for product UI.
9. One accent + semantic fail/success only.
10. Clusters that **exit into evals** (not dead-end “insight cards”).

### 1.9 What Eden must NOT copy

| Laminar trait | Why skip / conflict |
|---------------|---------------------|
| Orange brand accent | Conflicts with Eden Terminal Blue / Phosphor Green contract |
| Inline-only detail (no persistent inspector) | Agents with deep trees need **Langfuse-style** master–detail ≥1280; Eden uses transcript **default** but Tree+inspector as Mode |
| Product without gateway Cost surface | Eden wedge includes gateway — Cost borrows Helicone, not Laminar |
| Product without first-class PR outcome | TraceRoot owns that steal; Laminar stops earlier in the loop |
| Marketing “orange CTA on black” hero language | Portal is instrument panel, not marketing |
| Treating Chat as peer tab equal to Trace forever | Eden elevates Agent page; work-surface Chat is overlay |

### 1.10 Steal / Adapt / Skip — Laminar

| Steal | Adapt | Skip |
|-------|-------|------|
| Transcript-first agent reading | Remap orange → Eden `--accent` | Laminar brand hues |
| Signals callout above list | Rename to Issues/Alerts/Findings strip | Blue “Signals” brand box styling |
| Pane-local Trace/Chat/Signals tabs | Mode = Transcript\|Tree\|Timeline\|Meta\|Scores; Chat = overlay | Chat as always-visible third column on mobile |
| Per-row duration/tokens/$ | Same metrics; Eden mono secondary type | Card wrappers around each step |
| Chat-with-trace overlay | Agent page + bubble + same surface | Separate Ask AI product family |
| Clusters → evals | Wire to Eden Evals datasets | Dead-end insight galleries |
| Debugger sessions | Replay / time-travel objects | Cloning Laminar session IA labels verbatim if they fight Sessions |
| Dark docs density language | Portal chrome only | Rebuilding docs site |
| Agent-as-home | Dashboard agent-centric OS | Forcing every user into project switcher ceremony on day-1 |

---

## 2. TraceRoot — steal for Improve / PR loop

**Product:** [traceroot.ai](https://traceroot.ai/) (YC S25) — “self-healing layer for AI agents”  
**Evidence:** Product docs/README/site (2026-07); not in Playwright corpus — treat as **interaction grammar**, not pixel-matched chrome.  
**Why here:** Closest peer to Eden’s **failure → RCA → fix → PR** wedge. Laminar wins Observe UI; TraceRoot wins Improve outcome UX.

### 2.1 Product loop (canonical)

```
Detectors (LLM-as-judge on ingest)
    → Findings (hallucination / tool failure / logic / safety / intent drift)
        → Auto RCA (+ Slack/Email)
            → Agentic Debugging (sandbox + prod source + GitHub history)
                → Show Code / git correlation
                    → Fix PR (+ resolve GH issues / Linear)
```

Live tracing: SSE + Redis span streaming; traces list auto-refresh; timeline view for span Gantt; Show Code ties failure line to repo.

### 2.2 Surfaces to steal

| Surface | TraceRoot pattern | Eden surface |
|---------|-------------------|--------------|
| Detectors | Continuous judges on incoming traces | Alerts / detector policies (not red-team UI) |
| Findings | First-class failure objects with severity | Issues (+ finding detail) |
| RCA | Auto-triggered investigation artifact | Improve plan / RCA artifact |
| Show Code | Jump to failing line in sandbox/repo | Improve detail: Code / Diff / Git tabs |
| Git correlation | Commits, PRs, open issues linked to failure | Ledger + Improve related strip |
| Live streaming | Spans append while agent runs | Display → LIVE opt-in (never always-on primary) |
| Timeline | Virtualized span Gantt synced to selection | Traces Mode = Timeline (power) |
| PR as outcome | Agent opens fix PR | **PRs first-class Improve outcome** (D7) |

### 2.3 Steal / Adapt / Skip — TraceRoot

| Steal | Adapt | Skip |
|-------|-------|------|
| Detectors → Findings → RCA pipeline | Fit Eden Issues / Alerts / Improve objects | Replacing Laminar transcript as default reader |
| Show Code + git blame context | Eden Code panel in Improve / Debugger | Requiring sandbox for every triage (optional power path) |
| Auto PR as success state | EvidenceGate / promote gates before ship | Silent auto-merge / false success toasts |
| Live span streaming | Opt-in LIVE under Display | Always-on LIVE as first-paint primary |
| Timeline Gantt | Power Mode synced to transcript selection | Timeline as default reader |
| Slack/Email on detector fire | Alerts channels | Building TraceRoot’s entire alert product chrome |
| BYOK for debug agent | Eden Agent AI model settings | Hosted-only model lock-in UX |
| “Self-healing” marketing framing | Voice: precise, dry (`.impeccable.md`) | Breathless “self-healing” copy in portal chrome |

### 2.4 Conflict rules (TraceRoot vs Laminar vs Eden)

- TraceRoot must **not** dictate Observe pixel grammar — Laminar does.
- TraceRoot **must** dictate Improve exit states: finding → artifact → **PR**.
- Detectors ≠ red-team surface (D3 kill red-team UI; policies may remain).
- Eden gateway Cost is out of TraceRoot’s scope — do not let Improve absorb FinOps.

---

## 3. Langfuse — master–detail tree + inspector

**Product:** [langfuse.com](https://langfuse.com)  
**Evidence:** Live public trace (best authenticated-free capture): `langfuse-public-trace-scroll0/1.png`, `langfuse-trace-wide-scroll0.png`, `langfuse-home-scroll1.png`

### 3.1 Grammar

| Element | Spec |
|---------|------|
| Layout | Split pane: left hierarchical **span tree** (~25–40%); right **inspector** (~60–75%) |
| Tree metrics | Per-node **latency · tokens (prompt→completion) · cost** in secondary (often pink/red) type |
| Inspector header | **Metadata pill strip** — timestamp, Latency, Env, $, token summary |
| I/O | Input = Path/Value or structured; Output = **toned wash** (green in Langfuse); Formatted ↔ JSON |
| Tabs | Preview / Log; actions Annotate / Add to datasets |
| Chrome | Slim top (~40px) + breadcrumb/ID row; work surface starts early |
| Share | **Public trace** deep-links without full app chrome — gold standard for share |

### 3.2 Steal / Adapt / Skip — Langfuse

| Steal | Adapt | Skip |
|-------|-------|------|
| Master–detail on one screen | Split ≥1280; drawer &lt;1280; `?traceId=` + `?spanId=` | Light paper theme for portal |
| Metadata pill strip above I/O | Eden Badge/pill kit; dark tonal pills | Yellow highlighter brand |
| I/O visual split + Formatted/JSON | Output wash via `--bg-inset` / success tint — not Langfuse green brand | Path/Value as only Input UI |
| Inline tree metrics | Same numbers on Tree Mode rows | Tree as **default** reader (Transcript wins) |
| Annotate / Add to dataset exits | Wire to Evals + Improve | Parallel “Ask AI” floating bar as second Ask product |
| Public share pattern | Share link + optional auth wall | Docs-as-homepage portal layout |
| Keyboard shortcut chips | Fit CommandPalette culture | Shortcut soup on every CTA |
| Hatch/diagonal textures | — | Decorative hatch patterns |

### 3.3 When to use Langfuse vs Laminar in Eden

| Situation | Prefer |
|-----------|--------|
| Agent narrative debugging | Laminar transcript |
| Deep nested tool graphs | Langfuse tree + inspector (Mode = Tree) |
| Fleet triage of many traces | Braintrust logs table |
| Share a single failure | Langfuse public-share pattern |

---

## 4. Braintrust — experiment compare + dense logs

**Product:** [braintrust.dev](https://www.braintrust.dev)  
**Evidence:** `braintrust-home-scroll1.png`, `braintrust-observe-scroll1.png`, `braintrust-platform-scroll0.png`; evals peer notes in `.cursor/visual-research/evals-v3/`

### 4.1 Observe grammar

| Element | Spec |
|---------|------|
| Layout | Dark **master–detail**: dense logs table left (~55–60%); inspector right (~40%) |
| Toolbar | `Default view \| Filter \| Display \| Search \| LIVE \| time range` — **one row**, inside master pane |
| Nav | Breadcrumb-first (`Org / Project / Logs`); utility icons |
| Inspector tabs | Trace / Timeline / Thread / Views |
| LIVE | Explicit badge; streaming scent |

### 4.2 Evals grammar (docs-dense; steal themes)

| Need | Steal |
|------|-------|
| “Did v2 beat v1?” | **Baseline** noun; Diff mode; grades **Improve / Regress / Tradeoff / Tie** |
| Layout | Summary \| List \| Grid switcher |
| Playground | Mutable → promote to immutable Experiment |
| Regression-first | Sort/filter regressions as default path |

### 4.3 Steal / Adapt / Skip — Braintrust

| Steal | Adapt | Skip |
|-------|-------|------|
| Dense logs table for fleet triage | Traces list Mode / Sessions table | Purple chat bubbles as brand |
| Toolbar: View·Filter·Display·Search·LIVE·time | Eden FilterBar + Display owns LIVE | Second global chrome band for filters |
| Thread tab for chat-shaped agents | Sessions lens turn cards | Thread as only reader |
| Experiment compare + baseline | Evals hub compare surface | Merging Evaluate into Improve |
| Diff / four-grade verdict | Cost+latency+errors in grade row | Marketing vivid blue fields in portal |
| Breadcrumb-first for log surfaces | Combine with Eden slim sidebar | Dropping sidebar entirely |

---

## 5. Helicone — gateway / cost dashboard only

**Product:** [helicone.ai](https://www.helicone.ai)  
**Evidence:** `helicone-home-product-scroll0.png`, `helicone-home-scroll0/1.png`

### 5.1 What it is good for

| Pattern | Spec |
|---------|------|
| Left rail | Narrow ~15–20% icon+label groups (Dashboard, Requests, Improve, Monitor) |
| Overview | **Metric card grid**: Requests, Errors donut, Top Models bars, Costs, Latency, Countries |
| Time | Segmented 24H / 7D / … inside cards or toolbar |
| Density | Medium — airy cards, readable KPIs |

### 5.2 Steal / Adapt / Skip — Helicone

| Steal | Adapt | Skip |
|-------|-------|------|
| Cost / gateway KPI cards on Cost + Dashboard | Dark tonal StatCard / Panel — interaction or click-through only | Light SaaS white canvas |
| Narrow rail proportion | Eden sidebar 240px / 64px collapsed | Card-grid as **Traces** grammar |
| Model / provider breakdown bars | Cost hub charts | Floating provider marketing cards |
| Clear Observe vs Monitor IA labels | Eden: Observe / Evaluate / Improve / Workspace | Dual `/observability` + `/traces` reopen |
| Weekly report scent | Later Analytics | Making Home a FinOps spreadsheet |

**Hard rule:** Helicone captured surface = **ops dashboard**, not span inspector. Eden Traces must never look like Helicone’s card collage.

---

## 6. Brief peers

### 6.1 LangSmith

| Steal | Adapt | Skip |
|-------|-------|------|
| Lifecycle IA: Observability · Evaluation · Prompt Eng | Eden Observe / Evaluate / Improve groups | Dense workspace sprawl as default |
| Annotation queues (single + pairwise) | Human review when auto-score insufficient | Pairwise as v1 must if capacity tight — later OK |
| Trace → Add to dataset (+ rules) | Closed loop into Evals | Chat assistant as competing Ask surface |
| Playground ↔ dataset ↔ experiment | Evals playground deep-links | Studio merge into Improve |

### 6.2 Maxim

| Steal | Adapt | Skip |
|-------|-------|------|
| Agent simulation / static env runs as eval flavor | Later: simulation under Evals Advanced | Making simulation the default Observe |
| Integration as “test in env” | Debugger sessions can host scenarios | Separate Maxim-like product chrome |

### 6.3 HoneyHive

| Steal | Adapt | Skip |
|-------|-------|------|
| Automations on filters/scores | Alerts + Improve automations | Virtual data planes UI in v1 |
| Online eval rules | Online scoring Advanced | Custom dashboard builder sprawl on day-1 |
| CI/CD hooks | CI eval action (engineering) | Portal CI console as primary nav |

### 6.4 AgentOps

| Steal | Adapt | Skip |
|-------|-------|------|
| Real-time anomaly scent on agent runs | Detectors / Alerts | AgentOps-specific session chrome |
| Tool failure emphasis | Tool span semantics + Issues | Another agent analytics island |

### 6.5 Galileo

| Steal | Adapt | Skip |
|-------|-------|------|
| Agentic metrics (Action Completion, Tool Selection, Reasoning Coherence) | Judges pack under Evals / Guardrails | Luna brand / CLHF as UI chrome |
| Eval → Guardrail lifecycle | Policies without red-team UI (D3) | Runtime protection as Home widgets |
| Insights clustering | Issues / Topics later | Insights as equal peer to Traces |

### 6.6 W&B Weave

| Steal | Adapt | Skip |
|-------|-------|------|
| Multi-lens traces (tree / flame / graph) via **view modes** | Mode control on Traces | Object sprawl (Calls/Threads/Evals/Datasets all peers in sidebar) |
| Agents: Conversations vs Spans | Sessions transcript vs Tree | W&B project chrome |
| Playground + leaderboards | Evals later | Leaderboard-first culture |

### 6.7 Portkey

| Steal | Adapt | Skip |
|-------|-------|------|
| Gateway routing / fallbacks / cost observability | Eden **gateway** pillar + Cost hub | Portkey’s full AI gateway admin as Observe |
| Provider attempt trails | Trace metadata / gateway spans | Making routing config the landing page |

### 6.8 Arize Phoenix (supporting)

| Steal | Adapt | Skip |
|-------|-------|------|
| 3-pane: tree \| I/O \| Trace Details KV | Optional Meta Mode / properties rail | Light docs chrome height (~88–100px dual bars) in product |
| Ask overlay on dense embed | Same as Laminar chat overlay | Marketing cyan/purple glow |
| Datasets & experiments | Evals | PXI modular card collage as Trace UI |

---

## 7. Cross-product pattern matrix

| Pattern | Best peer | Eden decision |
|---------|-----------|---------------|
| Full dark product brand | Laminar | Dark-only portal |
| Transcript agent reader | Laminar | Default Mode |
| Signals / diagnosis strip | Laminar | Issues/Alerts strip |
| Master–detail tree+inspector | Langfuse | Tree Mode ≥1280 |
| Metadata pills + I/O split | Langfuse | Inspector contract |
| Dense logs + LIVE toolbar | Braintrust | Traces list / Sessions |
| Experiment compare grades | Braintrust | Evals compare |
| Detectors → RCA → PR | TraceRoot | Improve loop |
| Show Code / git | TraceRoot | Improve Code tab |
| Gateway KPI cards | Helicone | Cost + Dashboard only |
| Public share | Langfuse | Share links |
| Annotation queues | LangSmith | Evals human path |
| Multi-lens via modes | Weave | Mode control, not nav sprawl |
| Chat-with-trace overlay | Laminar / Phoenix | Agent page + bubble |
| Slim chrome ≤56px | Wave0b consensus | ≤2 bands |
| Narrow rail 15–20% | Helicone / Laminar docs | Sidebar 240 / 64 |

---

## 8. Eden differentiated composition

Eden is not “Laminar clone” or “TraceRoot clone.” Composition:

```text
┌──────────────────────────────────────────────────────────────────────────┐
│  EDEN PORTAL OS (dark-terminal · Geist · Terminal Blue CTA)              │
│                                                                          │
│  LANDING: Dashboard (agent-centric)     ← Laminar emotional center       │
│                                                                          │
│  ┌─ OBSERVE ───────────────────────────────────────────────────────────┐ │
│  │  Traces default = Transcript          ← Laminar                     │ │
│  │  Mode: Tree | Timeline | Meta | Scores← Langfuse / Weave / TraceRoot│ │
│  │  List fleet = dense table             ← Braintrust                  │ │
│  │  Issues / Alerts / Signals strip      ← Laminar + TraceRoot detectors│ │
│  │  Sessions / Debugger replay           ← Laminar sessions            │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                          │ evidence                                      │
│                          ▼                                               │
│  ┌─ EVALUATE ──────────────────────────────────────────────────────────┐ │
│  │  Datasets ← production / clusters     ← Langfuse + Laminar clusters │ │
│  │  Experiments compare + baseline       ← Braintrust                  │ │
│  │  Playground promote                   ← Braintrust / LangSmith      │ │
│  │  Human queues (later/as needed)       ← LangSmith                   │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                          │ regressions / promoted fixes                  │
│                          ▼                                               │
│  ┌─ IMPROVE ───────────────────────────────────────────────────────────┐ │
│  │  Queue → Plan → Artifact → Promote    ← Eden EvidenceGate           │ │
│  │  Show Code / git / Diff               ← TraceRoot                   │ │
│  │  PR as first-class outcome            ← TraceRoot + Eden D7         │ │
│  │  Cost / gateway metrics               ← Helicone (Cost hub only)    │ │
│  │  Guardrails policies (no red-team UI) ← Galileo lifecycle, D3       │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  CROSS-CUTTING                                                           │
│  · Gateway ingest (Eden pillar) — Portkey-class routing visibility       │
│  · AI Agent page + bubble — Laminar chat overlay, one surface (D6)       │
│  · Workspace Settings / Audit — Linear/Vercel settings grammar           │
│                                                                          │
│  DIFFERENTIATOR (no single peer owns all four):                          │
│  gateway + observe + evaluate + improve→PR  in ONE dark instrument OS    │
└──────────────────────────────────────────────────────────────────────────┘
```

### Closed-loop path (must be ≤ few clicks)

```text
Failure in Transcript / Tree
  → Issues finding (Signals strip or detector)
    → Improve plan / RCA artifact
      → Show Code + Diff
        → Promote / Open PR
          → Ledger remembers
```

Parallel path: cluster → **Create eval** → Experiment compare → Improve if regress.

---

## 9. Visual grammar checklist (10 rules from Wave 0b)

Source: `.cursor/visual-research/ai-portals-wave0b/OBSERVATIONS.md` § “What Eden must copy”. Every rebuild PR that touches Observe/Evaluate/Improve chrome must pass these:

| # | Rule | Pass criterion |
|---|------|----------------|
| 1 | **Master–detail on one screen for every trace** | List/tree stays mounted; inspector split ≥1280 or drawer &lt;1280; no full-page hop per span |
| 2 | **Latency · tokens · cost on every node/row** | Secondary type, scannable when API provides values; not hover-only |
| 3 | **Metadata pill strip above I/O** | Latency, Env, $, token summary as compact chips |
| 4 | **I/O visual split** | Structured Input vs toned Output; Formatted/JSON toggle |
| 5 | **Slim chrome** | ≤~56px global header; Filter/Search/time/LIVE in **list pane** toolbar — not a second global bar |
| 6 | **Narrow app rail (~15–20%)** | Sidebar ~240px (64 collapsed); breadcrumb-first OK on pure log surfaces |
| 7 | **One accent + semantic colors only** | `--accent` CTA; `--terminal` running; span hues only in trace UI; no purple-default brand |
| 8 | **Chat/Ask as overlay or rail** | Dense data visible underneath; one Ask surface |
| 9 | **Hairline borders + density by type, not card spam** | Cards for Home/Cost KPIs only; traces = rows/trees |
| 10 | **Transcript mode for agents** | Accordion steps + Signals-style diagnosis strip; Tree/Timeline = power modes |

### Chrome consensus (Wave 0b)

| Dimension | Do | Don’t |
|-----------|----|-------|
| Chrome height | Slim 40–56px | Phoenix docs dual-bar ~88–100px in product |
| Toolbar density | Compact icon+label in master pane | Helicone card-embedded filters as Trace grammar |
| Nav flatness | 1px rules, flat active | Multi-layer shadows, floating chrome |
| Master–detail | Default for traces | Helicone card grid for traces |
| Color | One brand accent + semantic | Purple-as-default |
| Whitespace | High density in debug; air on marketing | Card padding everywhere |

---

## 10. Priority steal stack (build order implication)

| Priority | Steal from | Ships in |
|----------|------------|----------|
| P0 | Laminar transcript + Signals + agent home + density | P2 Agents/Dashboard, P3 Observe |
| P0 | Langfuse master–detail + pills + I/O | P3 Observe Tree Mode |
| P0 | Wave0b 10-rule checklist | All phases |
| P1 | TraceRoot detectors → RCA → Show Code → PR | P5 Improve |
| P1 | Braintrust logs table + LIVE toolbar | P3 Observe list |
| P1 | Braintrust compare grades | P4 Evaluate |
| P2 | Helicone Cost cards | P5 Cost |
| P2 | LangSmith queues / Weave modes / Galileo metrics | P4–P5 Advanced |
| P3 | Maxim / HoneyHive / AgentOps / Portkey specifics | Later / Advanced |

---

## 11. Explicit non-goals (competitive)

- Do not pixel-match Laminar orange or Helicone light theme.
- Do not use Helicone dashboard as Traces.
- Do not merge Evaluate into Improve.
- Do not resurrect dual Observe IA (`/observability` + `/traces`).
- Do not ship red-team UI in v1.
- Do not open dual always-on rails (nav + AI).
- Do not treat marketing mock density as permission for decorative cards in debug surfaces.
- Do not invent purple glow / neumorphic cards / sticky sandwich chrome.

---

## 12. Evidence index (highest signal PNGs)

Absolute paths under the repo:

```
/Users/kaiavnihalani/Downloads/Eden/.cursor/visual-research/ai-portals/lmnr-home-scroll1.png
/Users/kaiavnihalani/Downloads/Eden/.cursor/visual-research/ai-portals/lmnr-home-scroll2.png
/Users/kaiavnihalani/Downloads/Eden/.cursor/visual-research/ai-portals/lmnr-docs-scroll0.png
/Users/kaiavnihalani/Downloads/Eden/.cursor/visual-research/ai-portals/langfuse-public-trace-scroll0.png
/Users/kaiavnihalani/Downloads/Eden/.cursor/visual-research/ai-portals/langfuse-public-trace-scroll1.png
/Users/kaiavnihalani/Downloads/Eden/.cursor/visual-research/ai-portals/langfuse-trace-wide-scroll0.png
/Users/kaiavnihalani/Downloads/Eden/.cursor/visual-research/ai-portals/langfuse-home-scroll1.png
/Users/kaiavnihalani/Downloads/Eden/.cursor/visual-research/ai-portals/braintrust-home-scroll1.png
/Users/kaiavnihalani/Downloads/Eden/.cursor/visual-research/ai-portals/braintrust-observe-scroll1.png
/Users/kaiavnihalani/Downloads/Eden/.cursor/visual-research/ai-portals/braintrust-platform-scroll0.png
/Users/kaiavnihalani/Downloads/Eden/.cursor/visual-research/ai-portals/helicone-home-product-scroll0.png
/Users/kaiavnihalani/Downloads/Eden/.cursor/visual-research/ai-portals/helicone-home-scroll0.png
/Users/kaiavnihalani/Downloads/Eden/.cursor/visual-research/ai-portals/arize-tracing-clean-scroll0.png
/Users/kaiavnihalani/Downloads/Eden/.cursor/visual-research/ai-portals/arize-phoenix-clean-scroll1.png
```

---

## Related docs

| Doc | Role |
|-----|------|
| [00-vision.md](./00-vision.md) | Wedge + success |
| [01-product-bible.md](./01-product-bible.md) | Objects + JTBD |
| [02-information-architecture.md](./02-information-architecture.md) | Nav + kill list |
| [design/DESIGN-SYSTEM-V2.md](./design/DESIGN-SYSTEM-V2.md) | Tokens + components (implements this grammar) |
| [04-interview-log.md](./04-interview-log.md) | Frozen D1–D10 |
