# Surface: AI Agent (Eden assistant)

> **Status:** Spec — must-ship  
> **Phase:** P6  
> **Decision date:** 2026-07-21  
> **Companions:** [../02-information-architecture.md](../02-information-architecture.md) §11 · [../01-product-bible.md](../01-product-bible.md) J13/C10/C11 · [../design/DESIGN-SYSTEM-V2.md](../design/DESIGN-SYSTEM-V2.md) §6.4 · [../03-competitive-synthesis.md](../03-competitive-synthesis.md) §1.6 / §2  
> **Decision lock:** D6 — dedicated **Agent page** + floating **clickable bubble**; three doors (`/agent`, bubble, ⌘K/⌘J) → **one** chat surface stack.

---

## 0. Naming collision (read first)

| Path / label | Meaning | Object |
|--------------|---------|--------|
| **`/agents`** · nav **Agents** | Customer agents under observation (fleet) | Product object **Agent** |
| **`/agent`** · nav **AI Agent** | Eden product assistant | AI session / thread |
| **Bubble / Ask AI** | Compact overlay door into the same assistant | Same stack as `/agent` |

**Never** title both chrome destinations “Agent” alone in the same band. i18n keys must stay distinct:

- `nav.leaves.agents` → “Agents”
- `nav.leaves.aiAgent` → “AI Agent”
- `ai.bubble.aria` → “Ask AI” / “Open AI Agent”
- German: keep the same disambiguation (e.g. “Agenten” vs “KI-Assistent”) — do not collapse to one word.

Cmd+K destinations: “AI Agent” vs “Agents” / “Connect agent” — never ambiguous.

---

## 1. Purpose

**One decision this surface owns:** Answer the engineer’s question about **org evidence** with **citations**, and offer **closed-loop actions** (explain → propose fix → open Improve plan → open PR draft) without inventing a second Ask product.

Not owned here: browsing the agent fleet (`/agents`), editing gateway keys, running evals, or replacing the Traces transcript reader.

---

## 2. Primary user + JTBD

| Field | Value |
|-------|-------|
| **Primary** | Mira — solo AI eng debugging tonight |
| **JTBD** | J13 — Ask Eden AI with citations |
| **Secondary** | Jordan — ask cost/audit/fleet questions; same surface, different prompts |
| **Done when** | Answer cites Trace / Span / Issue / Finding / Artifact / Plan IDs; citation click lands on canonical URL (C11); optional action creates or opens Plan / PR path |

Triggers:

- “Why did this turn fail?” (trace open)
- “Summarize this issue cluster”
- “Propose a fix and open a plan”
- “Draft a PR for the artifact we just generated”
- Overnight: resume a long thread on `/agent` after bubble triage

---

## 3. Dual surface contract (page + bubble)

Both are **must-ship**. They share one session/thread model, one tool/citation renderer, one permission gate. They differ only in **chrome and canvas size**.

### 3.1 Comparison

| Dimension | Floating bubble (compact) | `/agent` page (workspace) |
|-----------|---------------------------|---------------------------|
| **Role** | Chat-with-context overlay on dense product UI (Laminar) | Full-page threads, history, denser tool cards |
| **Visibility** | Collapsed FAB on all authenticated product pages (not marketing) | Workspace sidebar leaf |
| **Default** | Collapsed | Last thread or empty composer |
| **Underlay** | Current page remains visible (z-ladder) | Full `main` canvas |
| **History** | Current thread + “Open full Agent” link | Thread list + search + archive |
| **Tool cards** | Compact (1–2 lines + cite chips) | Expanded (diff peek, evidence table, action row) |
| **Context preload** | Automatic from page URL + selection | Explicit Context panel + same preload on deep-link |
| **Primary CTA** | Send | Send (same) — one solid accent in composer |
| **Expand** | “Open in Agent page” preserves `ai_session` | “Pop out bubble” optional; not required |

### 3.2 Three doors → one stack

| Door | Behavior |
|------|----------|
| FAB / bubble click | Open compact panel; focus composer; attach page context |
| Header “Ask AI” | Same as FAB |
| ⌘K / ⌘J → “Open AI” or type prompt | Same stack; may set `ai=1` + optional `ai_prompt` |
| Nav → AI Agent | Navigate `/agent` (full page) |
| Deep link `?ai=1` | Open bubble on current route without leaving page |

**Banned:** Separate coach overlay, second chat product, always-on dual rail (sidebar 240 + AI 360), AiRailHost as permanent third column.

### 3.3 Z-index & thumb-zone (mobile)

Per DESIGN-SYSTEM-V2 §6.6:

- FAB: `--z-ai-fab` (35); bottom offset `--ai-fab-bottom` clears MobileBottomNav
- Open AI surface: hide MobileBottomNav + cookie + FAB (mutual exclusion)
- Desktop rail (opt-in): `--z-ai-rail` (40)
- Never dual always-on rails

---

## 4. URL + query grammar

### 4.1 Full page

| Route | Purpose |
|-------|---------|
| `/agent` | Eden AI Agent workspace |
| `/agent?ai_session=<id>` | Resume thread |
| `/agent?traceId=` / `issueId=` / `findingId=` / `spanId=` / `agentId=` / `planId=` / `artifactId=` | Preload context (TraceRoot-style attach) |
| `/agent?ai_prompt=<urlencoded>` | Prefill composer (do not auto-send unless `ai_autosend=1` and product explicitly enables) |

Breadcrumb: `Workspace / Agent` (IA §9).

### 4.2 Global overlay params (any authenticated product URL)

| Param | Meaning |
|-------|---------|
| `ai=1` | Open bubble / panel |
| `ai_prompt` | Prefill prompt (URL-encoded) |
| `ai_session` | Resume Eden AI session id |
| `ai_autosend` | `0`\|`1` — default `0`; only auto-send when product flag allows |

Identity params on the **host page** remain authoritative for context:

`traceId` · `spanId` · `sessionId` · `issueId` · `alertId` · `findingId` · `agentId` · `planId` · `artifactId` · `debuggerSessionId`

When opening AI from Traces/Issues/etc., **do not strip** observe filters (`pastHours`, `q`, `filter`, …). Context payload copies IDs; filters stay on host URL.

### 4.3 Write normalization

- Prefer camelCase.
- Opening bubble with `ai=1` is additive; Esc closes AI and removes `ai=1` / `ai_prompt` without wiping host selection.
- “Open in Agent page” navigates to `/agent` with `ai_session` + context IDs copied; host page filters may drop (page is Workspace, not Observe).

### 4.4 Example URLs

```
/agent
/agent?ai_session=ais_01HXYZ
/agent?traceId=tr_abc&spanId=sp_9&ai_prompt=Why%20did%20this%20tool%20fail%3F
/traces?traceId=tr_abc&mode=transcript&ai=1
/issues?issueId=iss_1&ai=1&ai_prompt=Propose%20a%20fix%20plan
/improve/plans/pl_2?ai=1
```

### 4.5 Redirects

| Old | New |
|-----|-----|
| `/agents/eden/inbox` | `/improve?tab=plans` (not AI Agent) |
| Dual Ask products / coach routes | Collapse to bubble + `/agent` |

---

## 5. Context model (TraceRoot pattern)

Context is a **structured attach list**, not free-form “remember the page.”

### 5.1 Context sources (priority)

1. **Explicit pins** user added in Context panel  
2. **URL selection** on host or `/agent` query (`traceId`, `issueId`, …)  
3. **Soft page hints** (e.g. Dashboard focused agent card → `agentId`)  
4. **Org scope** always (Clerk org ↔ Eden org)

### 5.2 Attachable object types

| Type | Required fields in payload | Citation target |
|------|----------------------------|-----------------|
| Trace | `traceId`, optional `spanId`, `agentId` | `/traces?traceId=&spanId=&mode=` |
| Session | `sessionId` | `/traces?view=sessions&sessionId=` |
| Issue | `issueId` | `/issues/[id]` or `/issues?issueId=` |
| Alert / Signal | `alertId` / `signalId` | `/alerts?...` |
| Finding | `findingId` (+ parent issue/trace) | Issue/Trace diagnosis panel deep link |
| Agent (customer) | `agentId` | `/agents/[id]` |
| Plan | `planId` | `/improve/plans/[id]` |
| Artifact | `artifactId` (+ version) | `/improve?tab=artifacts&...` |
| DebuggerSession | `debuggerSessionId` | `/debugger/[id]` |
| Experiment / Score | ids when eval context | `/evals?...` / trace `mode=scores` |

### 5.3 Preload behaviors

| Entry | Preload |
|-------|---------|
| Trace reader → Ask | Attach Trace + focused Span; optional open Findings strip items as secondary |
| Issue detail → Ask | Attach Issue + top evidence Trace IDs (cap N, show “+K more”) |
| Finding chip → Ask | Attach Finding + parent Trace/Span |
| Improve plan → Ask | Attach Plan + linked evidence |
| Debugger → Ask | Attach DebuggerSession + compared Trace ids |
| Empty Dashboard / no agent | Soft gate: composer enabled; system note “Connect an agent for org-grounded answers” — does **not** block first-run keys path |
| Settings | Attach Org only; refuse to invent gateway secrets in chat |

### 5.4 Context UI

- Chip row: removable pins (`Tag` with `onRemove`)
- “Add evidence…” opens picker (Cmd+K-style object search scoped to org)
- Token / size budget: show overflow as “Context truncated — N objects omitted” (honest)

### 5.5 Grounding rules

1. Answers that assert facts about traffic **must** cite evidence IDs or state uncertainty.  
2. Improve never invents evidence — AI **proposes** Plan/PR; user confirms.  
3. No silent use of other orgs’ data.  
4. Viewer role: ask + cite; hide mutate action buttons (bible §8).

---

## 6. Layout diagrams

### 6.1 `/agent` — desktop ≥1280

```
┌─ AppShell: sidebar (240) + header band 1 (breadcrumb Workspace / Agent) ─┐
│ Band 2 (toolbar ≤5): New thread · Search threads · Models · Overflow     │
├───────────────┬───────────────────────────────────────────┬──────────────┤
│ Thread list   │ Message stream                            │ Context      │
│ (~240–280)    │                                           │ panel        │
│               │  [system / assistant / user turns]        │ (~280–320)   │
│  Today        │  Citation chips → navigate                │ Pins         │
│  Yesterday    │  Tool cards (explain / fix / plan / PR)   │ Add evidence │
│  …            │                                           │ Related      │
│               │ ───────────────────────────────────────── │              │
│               │ Composer: textarea + Attach + Send        │              │
│               │ Actions strip (when tools ready)          │              │
└───────────────┴───────────────────────────────────────────┴──────────────┘
```

- Thread list may collapse to icon rail; Context panel collapsible (default open when pins exist).  
- **One** solid Send CTA in composer. Action buttons on tool cards are secondary/outline until user commits.

### 6.2 `/agent` — tablet <1280

```
[ Thread list as Sheet / left drawer ]
[ Message stream full width ]
[ Context as Sheet from "Context" toolbar control ]
Composer sticky bottom
```

### 6.3 `/agent` — mobile

```
Single column message stream
Top: thread title + Context button + Overflow
Bottom: composer (min-h-11 controls)
Threads via Sheet
No permanent third column
FAB hidden while on `/agent` (already in workspace) — optional
```

### 6.4 Bubble — desktop

```
FAB bottom-right (clears any bulk bar)
Click → floating panel (~360–420px wide, ~min(560px, 70vh) tall)
  Header: Ask AI · Context chips · Expand to /agent · Close
  Body: compact message stream
  Footer: composer
Underlay: host page fully interactive except focus trap in panel when open
```

Opt-in **docked rail** (same stack, wider): user preference only; default remains floating. Never default dual always-on with sidebar.

### 6.5 Bubble — mobile

```
Full-width Sheet from bottom (or nearly full height)
Mutual exclusion: hide bottom nav + FAB while open
Safe-area insets honored
```

---

## 7. Chrome budget

| Band | Contents |
|------|----------|
| **1** | Breadcrumb / title (`AI Agent`) + utilities (Search, Ask is self, Notifications) |
| **2** | ≤5 primary: **New thread** · **Search threads** · **Context** · **Model** · **Overflow** (Export, Delete thread, Density) |

Bubble header counts as overlay chrome — not a third app band. Host page keeps ≤2 bands.

**One primary CTA:** Send (composer). “Open Improve plan” / “Open PR draft” are secondary until confirmation dialog.

---

## 8. States

| State | Behavior |
|-------|----------|
| **Empty** (no threads) | Title + one CTA “Ask about a trace or issue”; secondary link to Traces / Issues; optional “Connect agent” if org has zero agents |
| **First-run** | Soft prompt: attach evidence or open from a Trace; do not block gateway connect journey |
| **Loading** | Thread list skeleton; stream skeleton; QueryState pattern for history fetch |
| **Error** | Retry + support path; failed send keeps draft in composer |
| **Filtered-empty** | Thread search no hits → Clear search (distinct from empty) |
| **Populated** | Stream + optional streaming token append |
| **Live** | Streaming assistant tokens; Phosphor `--terminal` only as running indicator / focus — not CTA fill; polite live region |

Streaming: honor `prefers-reduced-motion` (no shimmer parade).

---

## 9. Components (kit only)

| Need | Kit |
|------|-----|
| Shell | `PageHeader`, AppShell landmarks (`main`, complementary for rail) |
| Lists | Panel (not Card soup); virtualized thread list if long |
| Chips | `Tag` (dismissible pins), `Badge` / `StatusBadge` for tool status |
| Composer | `Textarea`, `Button`, `Input` |
| Overlays | `Sheet` (mobile/tablet), floating panel uses Dialog/Sheet contracts — no raw Radix bypass |
| Object pick | `CommandPalette` patterns |
| Code / diffs | Mono `CodeChip`; Diff in tool card |
| States | `QueryState` for history list |
| Toasts | Kit toast — no false success on Plan/PR |

---

## 10. Message & citation grammar

### 10.1 Citation chip

```
[ Trace tr_abc · span sp_9 ]  → click → /traces?traceId=tr_abc&spanId=sp_9&mode=transcript
[ Issue iss_12 ]              → /issues/iss_12
[ Finding fd_3 ]              → parent Issue/Trace with highlight
[ Artifact art_7@v3 ]         → Improve artifacts deep link
```

- Mono short ID; tooltip full ID + copy.  
- C11: **1 click** from citation to canonical object.  
- Keyboard: citation focusable; Enter activates.

### 10.2 Tool / action cards (TraceRoot exits)

Cards appear **after** model proposes an action — user confirms.

| Action | Card contents | Confirm navigates / creates |
|--------|---------------|-----------------------------|
| **Explain** | Summary + citation list | Stays in chat (no mutate) |
| **Propose fix** | Diff / prompt patch peek + evidence gate summary | May create **Artifact draft** or stage text only |
| **Open Improve plan** | Title, evidence IDs, suggested steps | `/improve/plans/[id]` or create Plan with prefilled evidence (C4) |
| **Open PR draft** | Repo, branch suggestion, artifact link | Improve PR flow (C7) — provider deep link; no false “PR merged” toast |

Card footer buttons: outline/secondary. Destructive never primary here.

### 10.3 Suggested prompts (empty composer)

Context-aware, dry copy — examples:

- Trace attached: “Explain the failing tool span”
- Issue attached: “Cluster root cause and propose a plan”
- None: “How do I connect the gateway?” → may cite external docs link only

Ban exclamation CTAs and mascot prompts.

---

## 11. Keyboard map

| Key | Context | Action |
|-----|---------|--------|
| `⌘K` / `Ctrl+K` | Global | Command palette (includes Open AI) |
| `⌘J` / `Ctrl+J` | Global | Open Ask stack (same as bubble) |
| `Esc` | Bubble open | Close bubble; strip `ai=1` |
| `Esc` | `/agent` context sheet | Close sheet |
| `⌘↵` / `Ctrl+Enter` | Composer focused | Send |
| `⇧↵` | Composer | Newline |
| `⌘N` | `/agent` | New thread |
| `/` | Bubble/page idle | Focus composer (if not in input) |
| `Tab` | Citation / action card | Move between chips and confirm buttons |

All icon-only controls need accessible names (`ai.bubble.aria`, etc.).

---

## 12. Closed-loop exits

| From | To | Max actions | Preserve |
|------|----|-------------|----------|
| Any page | Open bubble with context | **1** (C10) | Host object IDs in payload |
| Citation | Trace / Issue / … | **1** (C11) | Canonical IDs + default reader mode |
| Propose fix → confirm | Artifact / Plan | **2** | Evidence IDs on Plan |
| Open Improve plan | `/improve/plans/[id]` | **2** | `planId`, evidence |
| Open PR draft | Provider / Improve PR UI | **3** (C7) | Artifact + Plan identity |
| Bubble | `/agent` expand | **1** | `ai_session` + pins |
| AI | Debugger | Via citation or “Replay this trace” secondary | `traceId` seed |

Dead-end allowed: “Not enough evidence” — say so; do not fake Plan.

---

## 13. Permissions

| Role | Ask | See citations | Create Plan / Artifact / PR from cards |
|------|-----|---------------|----------------------------------------|
| Viewer | ✓ | ✓ | Hide mutate CTAs |
| Member | ✓ | ✓ | ✓ |
| Admin | ✓ | ✓ | ✓ |

Model/BYOK settings (TraceRoot adapt): Admin (and Member if granted) under Settings or `/agent` Overflow → Model — not a separate Ask product.

---

## 14. Anti-patterns banned

- Confusing `/agent` with `/agents` in copy, icons, or Cmd+K  
- Second Ask AI product / coach overlay / always-on AiRailHost third column  
- Dual always-on sidebar + AI rail by default  
- Citations that do not deep-link  
- Inventing Plans without evidence IDs  
- False success toasts on PR/Plan  
- Purple glow chat bubbles as brand  
- Marketing “self-healing” hype copy  
- Auto-sending `ai_prompt` without explicit product flag  
- Blocking first-run connect behind AI onboarding  
- 9–10px chrome labels; Card soup around every message  
- Using `--terminal` as Send button fill  
- Red-team / adversarial attack suggestions as product actions  

---

## 15. Acceptance checklist

- [ ] `/agent` is Workspace core leaf; label **AI Agent** (en+de)  
- [ ] `/agents` remains customer Agents — no title collision in chrome  
- [ ] Clickable FAB on all authenticated product pages; collapsed by default  
- [ ] Bubble + `/agent` + ⌘K/⌘J share one stack  
- [ ] `?ai=1` / `ai_prompt` / `ai_session` work per IA §3.8  
- [ ] Context preloads from Trace / Issue / Finding / Plan / Debugger  
- [ ] Citation click → canonical URL with IDs (C11)  
- [ ] Actions: explain, propose fix, open Improve plan, open PR draft — user-confirmed  
- [ ] Viewer cannot see mutate CTAs  
- [ ] Chrome ≤2 bands on `/agent`; ≤5 toolbar actions  
- [ ] Mobile: AI open hides bottom nav; ≥44px targets  
- [ ] Z-index ladder + thumb-zone mutual exclusion  
- [ ] Empty / first-run / loading / error / filtered-empty / populated / live covered  
- [ ] No always-on dual rail; no parallel Ask product  
- [ ] Docs remain external; AI may link out only  

---

## 16. Implementation notes (non-normative wiring)

- Session persistence: `ai_session` id stable across bubble ↔ page.  
- Streaming protocol: reuse org AI backend; cancel in-flight on Esc/close.  
- Telemetry: door used (fab / header / palette / page), objects attached, action confirms — no PII in client logs beyond IDs.  
- i18n: all chrome strings via `next-intl`.

---

*End of surfaces/ai-agent.md*
