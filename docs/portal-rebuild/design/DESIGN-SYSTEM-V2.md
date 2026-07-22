# Eden Portal — Design System V2

> **Status:** Authoritative for the portal rebuild.  
> **Supersedes:** `clients/portal/DESIGN.md` (keep file as historical until teardown cutover; do not extend).  
> **Decision date:** 2026-07-21  
> **Scope:** Authenticated product under `clients/portal` only — dark-only.  
> **North star:** Laminar density + Eden dark-terminal tokens (see `../03-competitive-synthesis.md`).  
> **Brand sources:** `.impeccable.md` + token ladder below. Tokens ship in `src/app/globals.css` (rebuild kit). Prefer CSS variables; do not invent new brand hues.

---

## 1. Purpose & scope

Eden Portal is a **dark-only engineering instrument** for observing, evaluating, and improving AI agent runs — and for closing the loop **failure → artifact → PR** while owning **gateway + observe + improve** in one OS.

Hierarchy comes from **tonal steps**, not decoration. The product must feel like a terminal-adjacent ops console (Linear / Vercel / Laminar energy), not a marketing dashboard and not the current cluttered portal.

| In scope | Out of scope |
|----------|--------------|
| Rebuild authenticated portal: shell, hubs, detail panes, kit | `docs/` site content architecture (tokens may align; site stays) |
| `(portal)`, `(auth)`, shared chrome, AI Agent page + bubble | `(marketing)` / promotional landing layouts |
| Dark product chrome, master–detail, dense tables, transcript | Light mode, dual themes, consumer whitespace |
| Mobile adaptation of the same OS | Separate “mobile app” visual language |

**Brand signal:** Terminal Blue (`--accent` `#5B9EFF`) for **primary action**. Phosphor Green (`--terminal` `#5FE5A8`) for **running / live / focus ring only** — never a second CTA.

**Personality:** precise, technical, calm (`.impeccable.md`). Dry copy. No exclamation CTAs. No AI-y gradients.

**Principle order when trade-offs conflict:** legibility → precision → restraint → motion → coherence.

---

## 2. Aesthetic north star

| Layer | Source | What to take |
|-------|--------|--------------|
| Density / transcript / Signals / chat overlay | **Laminar** | High data density; metadata on the row; diagnosis strip; overlay Ask |
| Inspector / pills / I/O split | **Langfuse** | Master–detail; pill strip; Input vs toned Output |
| Fleet logs / LIVE toolbar / eval compare | **Braintrust** | Dense table + pane toolbar; baseline Diff grades |
| Improve → Code → PR | **TraceRoot** | Findings → RCA → Show Code → PR exits |
| Cost / gateway KPIs | **Helicone** | Card grid **only** on Cost/Dashboard — never Traces |
| Tokens / voice | **Eden** | Background ladder, Terminal Blue, Phosphor Green, Geist |

**One sentence:** Laminar instrument density wearing Eden’s dark-terminal skin, with TraceRoot exits and Langfuse inspector mechanics.

**Anti-north-star:** Current portal clutter; Helicone card-grid as Traces; Phoenix marketing purple glow; purple-on-dark default SaaS; cream+serif AI defaults; sticky chrome sandwiches.

---

## 3. Color tokens

Consume tokens in order: **primitive → semantic → component**. No raw `#hex` in leaf components (only `globals.css`).

### 3.1 Backgrounds (`--bg-*`)

| Token | Hex | Role |
|-------|-----|------|
| `--bg-base` | `#03060A` | Deepest — code blocks, terminal panels, transcript wells |
| `--bg-primary` | `#0A0E14` | Default page / body canvas |
| `--bg-secondary` | `#0F1419` | Popovers, **input fill**, elevated grouping |
| `--bg-tertiary` | `#151B23` | Table headers, sticky column heads, elevated strips |
| `--bg-inset` | `#060A10` | Inset wells, recessed code, Output wash base |

Depth = step the ladder. Do not add decorative accents to fake hierarchy.

### 3.2 Text (`--text-*`)

| Token | Hex | Role |
|-------|-----|------|
| `--text-primary` | `#E4ECF7` | Titles, primary values |
| `--text-secondary` | `#94A3B8` | Body supporting copy |
| `--text-muted` | `#7A8A9A` | Helper labels, meta |
| `--text-faint` | `#6B7C96` | De-emphasized chrome only (still ≥ AA) |

Body text must pass **WCAG AA** (≥4.5:1) on its background.

### 3.3 Borders

| Token | Role |
|-------|------|
| `--border-subtle` | Row dividers, cell separators |
| `--border-default` | Input borders, panel edges |
| `--border-strong` | Emphasized edges, active wells |
| `--border-glow` | Focus / active glow — **sparingly** |

Borders must pass **WCAG AA non-text** (≥3:1) on surfaces they touch. Use the audited blue-tinted ladder; do not invent thinner gray.

### 3.4 Accent (one primary)

| Token | Hex | Role |
|-------|-----|------|
| `--accent` | `#5B9EFF` | **Only** primary CTA / active nav / links |
| `--accent-hover` | `#7AB1FF` | Hover on primary |
| `--accent-dim` / `--accent-faint` | (ladder) | Selected / tinted backgrounds |
| `--accent-foreground` | `#03060A` | Text on solid accent fills |

### 3.5 Reserved (not CTAs)

| Token | Hex / family | Role |
|-------|--------------|------|
| `--terminal` | `#5FE5A8` | Active / running / **focus ring** — not a button fill |
| `--success` | semantic green family | Success status (may alias terminal carefully) |
| `--warning` | `#FFB547` amber | Warning / tool span family |
| `--error` | semantic red | Failed / destructive |
| `--info` | `#22D3EE` cyan | Info / subagent / refining |
| `--accent-purple` | `#C084FC` | **Span-type LLM label only** (or eval stage) — not brand |
| `--status-running` | lifecycle | Process running (decoupled from CTA blue) |

**Rule:** Hierarchy = tonal shift + 1px border + optional neutral shadow. No new purple brand themes. No colored/inset/glow shadows for decoration. Cards should not need a shadow to read; reserve `--shadow-lg/xl` for modals and floating surfaces.

### 3.6 Shadows

Linear-inspired: subtle, precise. Static cards: no shadow required. Floating: `--shadow-sm` → `--shadow-lg/xl` for Dialog / Sheet / CommandPalette only.

---

## 4. Typography

| Face | Use |
|------|-----|
| **Geist Sans** | UI body, headings, chrome |
| **Geist Mono** | IDs, durations, JSON, tool/span names, code chips, status micro where allowed |

### 4.1 Scale (product UI)

| Role | Size | Notes |
|------|------|-------|
| Body | **14px** (`text-sm`) | Default everywhere in product |
| Chrome labels | **≥12px** (`xs`) | Cap; never below |
| Section titles | 16–18px | One weight step up |
| Page title | 18–20px | PageHeader `title` |
| Display (rare) | 24px max in portal | Dashboard greeting only if needed |
| Controls | Match 28–32px control height | Do not shrink label to fit |

### 4.2 Hard bans

- Kill **9–10px** chrome micro-labels (`2xs` / `3xs` / `text-[9px]` / `text-[10px]`) in PageHeader, banners, toolbars, badges, nav.
- `--font-size-2xs` / `3xs` **only** inside true terminal mock windows — never chrome.
- ≤ **two** font weights per screen.
- Mono is for identity-shaped data — not prose paragraphs.
- No Inter / Roboto / Arial / system-ui as primary product face.

### 4.3 Tracking / case

- Uppercase + wide tracking is a **terminal mock recipe**, not a toolbar recipe.
- Prefer sentence case for UI labels (`Filter`, `Display`, `Save view`).

---

## 5. Spacing / density / radii

### 5.1 Spacing

| Token ladder | Base |
|--------------|------|
| `--space-1` … `--space-8` | **4px** base unit; **8px** primary rhythm |

| Context | Spec |
|---------|------|
| Toolbar gap | 8px comfortable / 4–6px compact |
| Table cell padding | Comfortable: 8–10px y; Compact: 4–6px y |
| Panel padding | 12–16px |
| Page content inset | 16–24px desktop; 12–16px mobile |
| Section stack | 24px between major blocks |

### 5.2 Density toggle

Persist via `DensityProvider` / `data-density` on AppShell:

| Mode | Use |
|------|-----|
| **Comfortable** (default) | Default row padding; occasional users |
| **Compact** | Tables / virtualized lists; tighter toolbar/cell padding |

Compact must **not** reintroduce 9–10px chrome labels. Density is a product setting, not one-off hard-coded heights.

### 5.3 Control height

| Surface | Height |
|---------|--------|
| Desktop chrome / toolbars / inputs / buttons | **28–32px** (`h-7`–`h-8`) |
| Touch (`max-md`) | **≥44px** hit area (`min-h-11`) without growing desktop visual height |

### 5.4 Radii

| Token | Use |
|-------|-----|
| `--radius-sm` | Inputs, small chips, dense controls |
| `--radius-md` | Panels, dialogs, buttons default |
| `--radius-lg` | Sheets / rare large surfaces |

Do not mix radii inside one composite. Ban `rounded-3xl` / pillow shapes in product chrome. Badge status may use `rounded-md`; pill Badge base `rounded-full` is frozen — do not invent a third radius language.

---

## 6. Chrome contract

### 6.1 Bands

**≤2 bands above content:**

1. **Identity header** — breadcrumb + utilities  
2. **Toolbar** — View / Filter / Display / Search / primary actions  

Banners: **max one** visible at a time. No sticky sandwich (header + filters + table head + bulk + FAB + mobile nav all fighting).

### 6.2 Sidebar

| State | Width |
|-------|-------|
| Expanded | **240px** (~15–20% on 1440) |
| Collapsed | **64px** icon rail |
| Mobile | Hidden; **bottom nav** + More sheet |

Sidebar = **places**. Command palette = **verbs + deep find**.

Flat nav ≤ ~12 core items. Kill dual entry points (no parallel Observe IA).

### 6.3 Header

| Spec | Value |
|------|-------|
| Height | **40–56px** (slim; Wave0b) |
| Contents L→R | Menu (mobile) · Breadcrumb/title region · spacer · Search · Ask AI · Notifications |
| Account | Lives in **sidebar** — do not duplicate avatar in header |
| Location grammar | Breadcrumb + page title only — no eyebrow + PageHelpHint + title triple |

### 6.4 AI bubble / Agent

| Rule | Contract |
|------|----------|
| Surfaces | **Dedicated Agent page** + **floating clickable bubble** + ⌘K/⌘J (D6) |
| Implementation | Three doors → **one** overlay/command surface |
| Default | Collapsed; never dual always-on rails (nav 240 + AI 360) |
| Desktop AI rail | Opt-in aside; z-index per ladder |
| Underlay | Dense data remains visible (Laminar) |

### 6.5 Mobile bottom nav

| Spec | Contract |
|------|----------|
| Position | `fixed` bottom-0 + `safe-area-inset-bottom` |
| Items | Primary hubs only (Dashboard, Observe, Evaluate, Improve, More) |
| More sheet | Workspace: Audit · Settings · API keys (match desktop Workspace) |
| Mutual exclusion | See z-index / thumb-zone contract |

### 6.6 Z-index ladder

| Token | Value | Role |
|-------|-------|------|
| `--z-bulk-bar` | 20 | BulkActionBar |
| `--z-mobile-nav` | 30 | MobileBottomNav |
| `--z-ai-fab` | 35 | Ask AI bubble/FAB; bottom = `--ai-fab-bottom` |
| `--z-ai-rail` | 40 | Desktop AI rail |
| `--z-cookie` | 40 | Cookie **banner only** while awaiting choice |
| Modals / sheets | 40–50 | Dialog, Sheet, CommandPalette portal |
| `--z-toast` | 60 | Toasts above dialogs |
| `--z-grain` | 9999 | Decorative only (`pointer-events: none`) |

**Thumb-zone mutual exclusion** (only one occupant):

| State | Visible |
|-------|---------|
| Cookie awaiting choice | Cookie banner (FAB hidden; nav stays) |
| AI open | AI surface only — hide MobileBottomNav + cookie + FAB |
| Idle (choice done) | FAB + MobileBottomNav |
| Bulk select (desktop) | BulkActionBar; hide on mobile so it never stacks with FAB+nav |

Cookie after Accept/Decline: **render nothing fixed**. Reopen via Settings · Privacy · footer only. `--cookie-banner-offset` = `0` when hidden.

Always-on chrome sinks (desktop first paint) **≤6:** sidebar · header · command-palette · banner · toast · ask-ai-fab. Cookie is not a sink after choice.

---

## 7. Layout patterns

### 7.1 Master–detail (default for resources)

```
≥1280:  [ Master list/tree  |  Detail inspector ]
<1280:  [ Master full width ] → Detail in Sheet/Drawer
URL:    ?traceId= & ?spanId= (Esc closes detail)
```

List stays mounted. No full-page navigation per row open.

### 7.2 Transcript rows (Traces default)

```
[ Signals / Issues strip ]
[ Summary meta: duration · tokens · $ ]
[ Mode: Transcript | Tree | Timeline | Meta | Scores ]
─────────────────────────────────────────────────────
[ icon ] step name                    120ms · 1.2k · $0.01
         └─ In/Out collapsed (… more)
[ icon ] tool:search                   40ms · — · —
```

- Hairline separators; **no card-per-step**.
- Metrics on the row when API provides them.
- Collapse subagents / metadata / timeline by default.

### 7.3 Resource list (fleet)

Braintrust-class dense table:

```
Toolbar (in pane): Views · Search · ≤3 filters · Display · Overflow
Table: checkbox · time · name/status · input preview · output · score · cost
Detail: right inspector tabs (Trace / Timeline / Thread / Meta)
```

LIVE lives under **Display** — opt-in, never always-on first-paint primary.

### 7.4 Settings

```
PageHeader: Settings (+ one-liner subtitle)
Band 2: category pills / daily tabs ≤6 + Advanced collapsed
Overview: identity · plan chip · health row · ONE accent CTA
No second ~240px Settings sidebar
```

Fail→act ≤2 clicks to API keys / members / billing. Ghosts (roles/sso) soft-hide until shipped.

### 7.5 Empty / first-run / filtered-empty / error

Hubs **must** use `QueryState`:

`loading → error → empty | filter-empty → children`

| State | Requirement |
|-------|-------------|
| Empty / first-run | Title + one next step CTA |
| Filter-empty | Clear filters action — distinct from first-run |
| Error | Retry + support path |
| Populated | Children only |

Ban sad “no data” with no path. Ban bare `EmptyState` as sole hub shell — pass as `emptySlot` / `filterEmptySlot`.

### 7.6 Dashboard (landing)

Agent-centric OS (Laminar energy). One composition first viewport: health of agents + path into failures. KPI cards allowed **here** and on Cost — interaction or click-through only. Not a second Trace grammar.

### 7.7 Improve queue

Master–detail. Views: Needs you / In progress / Verify. Related strip: Issues · Artifacts · Ledger · Prompts (Advanced off strip). One primary CTA per selection. PRs first-class outcome.

---

## 8. Component kit inventory

Canonical primitives under `src/components/ui/`. Import from `@/components/ui`. Do not hand-roll accents or raw Radix Dialog outside `ui/dialog` / `ui/sheet`.

**Not decorative cards.** If removing border/shadow/background/radius does not hurt interaction or understanding, it is not a Card.

### 8.1 Button

| Variant | Use |
|---------|-----|
| `default` | Sole solid `--accent` CTA (**one per screen**) |
| `secondary` | Quiet fill + border |
| `outline` / `ghost` / `link` | Quiet utilities |
| `destructive` / `danger` | One error delete style (aliases) |
| `emerald` | Deprecated — do not use for new work |

Height 28–32px; `max-md:min-h-11`. Icon-only chrome = `size="icon"` kit Button only. Ban raw chrome `<button>` with `bg-[var(--accent)]`.

### 8.2 Badge

| Primitive | Role |
|-----------|------|
| `Badge` | Single pill API (`rounded-full` base; frozen variants) |
| `StatusBadge` (+ domain wrappers) | Domain status — wraps Badge, `rounded-md`, `text-xs` |
| `Tag` | Dismissible chip (`onRemove`) |

No 9–10px on status pills. One Badge/Status grammar — no parallel families.

### 8.3 Input / Select / Textarea

| Spec | Value |
|------|-------|
| Fill | `--bg-secondary` (fields must not read as cards) |
| Height | 28–32px desktop |
| Focus | `--terminal` via `FOCUS_RING_CLASS` |
| Border | `--border-default` |

### 8.4 Tabs

| Variant | Use |
|---------|-----|
| `underline` (**default**) | Hub / product tabs / Mode |
| `pills` | Settings / embedded only |
| Boxed `default` | Legacy rare — prefer underline |

### 8.5 DataTable

Infinite/virtualized capable. Column config + saved views. Compact density aware. Row click opens detail (master–detail). Checkbox + bulk via BulkActionBar.

### 8.6 Panel

Tonal grouping **without** box/border stack. Prefer Panel over Card for layout.

### 8.7 Card

**Interaction units only** — selectable rows, clickable destinations, expandable subagent blocks, submit sections. Ban KPI decorative soup on Trace surfaces. StatCard only for real KPI summary / click-through (Dashboard/Cost).

### 8.8 Dialog / Sheet

| Primitive | Use |
|-----------|------|
| `Dialog` | Confirmations, small forms, promote gates |
| `Sheet` | Mobile/tablet detail drawer; filters Advanced |

Kit only — no raw Radix bypass.

### 8.9 CommandPalette

Canonical `@/components/ui/command-palette`. One implementation. ⌘K/⌘J open same surface as Ask doors.

### 8.10 QueryState

Required on list hubs. Composes loading/error/empty/filter-empty/children.

### 8.11 PageHeader

**AppShell breadcrumb + `title` only.** Optional `actions`, optional `subtitle` (page one-liner). `eyebrow` / `description` deprecated — **not rendered**. Home may keep greeting.

### 8.12 FilterBar

Kit Input + Select; composes into `QueryFilterBar` + Advanced drawer. ≤5 primary toolbar actions; rest Overflow. Control height `h-8` / touch `min-h-11`.

### 8.13 MetricInline

Secondary type for **latency · tokens · cost** on rows/nodes. Mono allowed for numbers. Not a Card. Not a chart.

### 8.14 Also kit

`Wizard`, `ErrorBoundary`, `Tag`, `CodeChip`, StatusBadge family, `Section`, `StatCard` (KPI only), Breadcrumb kit (single API).

### 8.15 portal-os shells (preserve contracts)

`ResourcePageShell`, `DetailPanelShell`, `QueryFilterBar`, `ViewsMenu`, `BulkActionBar` — rebuild may reimplement but **keep the interaction contracts**.

---

## 9. One primary CTA rule

- **One** solid `--accent` action per screen / selection context.
- Secondary = ghost / quiet / outline.
- Destructive = `--error` grammar only — one delete style.
- Do not use `--terminal` or `--accent-purple` as button fills.
- Do not ship hand-rolled accent buttons when kit `Button` exists.
- Context picks the job (e.g. Settings overview: Create key **or** Invite **or** Manage billing — not all solid).

---

## 10. Span / semantic colors

Color in trace/transcript encodes **span kind**, not decoration.

| Kind | Intent | Token mapping |
|------|--------|---------------|
| LLM | Model turn | Violet / `--accent-purple` **as span label only** |
| Tool | Tool / function call | Amber / `--warning` |
| Subagent | Nested agent | Cyan / `--info` |
| Error | Failed span / fault | `--error` |
| Running | In-flight | `--terminal` / `--status-running` |

**Rules**

- Span hues appear as **pills / labels in trace UI only**.
- Do not reuse as page accents, KPI tints, or nav chrome.
- Builder `--node-agent` / `--node-tool` stay for canvas nodes — do not invent decorative palette ramps.
- Output wash: tonal inset / subtle success tint — not a second brand green CTA.

---

## 11. Motion

| Token | Cap |
|-------|-----|
| `--duration-fast` | 150ms |
| `--duration-normal` | **200ms** hard ceiling for product UI |
| `--duration-slow` | Prefer ≤200ms for new work; ≤300ms only for rare chrome width |

| Allowed | Forbidden |
|---------|-----------|
| Panel/Sheet enter | Perpetual glow pulses in chrome |
| Row select highlight | Long stagger parades |
| Live-append short pulse | Marketing mesh drift on product routes |
| Toast in/out | Animating shadows into existence on mount |

Honor `prefers-reduced-motion` — disable shimmer, mesh, ticker, non-essential transitions.

Easing: `--ease-out` `cubic-bezier(0.33, 1, 0.68, 1)`.

Motion answers “did something change?” or “where should I look?” — never decoration.

---

## 12. Mobile rules

| Rule | Spec |
|------|------|
| Touch targets | **≥44px** hit areas on `max-md` |
| Layout | **Single column**; detail in **Sheet/Drawer** |
| Chrome | ≤2 bands; no sticky sandwich |
| Nav | Bottom nav + More; hide when AI open |
| Tables | Horizontal scroll **or** priority columns + Compact; prefer card-rows only if interaction requires |
| Transcript | Full-width rows; inspector drawer |
| FAB | Clears nav via `--ai-fab-bottom` |
| Typography | Still ≥12px chrome; 14px body — do not shrink for “mobile polish” |
| Density | Comfortable default; Compact available |

**Ban:** Dual sticky headers + sticky filters + sticky table head + bulk bar + FAB + bottom nav simultaneously.

---

## 13. Accessibility

| Requirement | Spec |
|-------------|------|
| Contrast text | WCAG **AA** ≥4.5:1 body |
| Contrast non-text | ≥3:1 borders / icons on surfaces |
| Focus | Visible `--terminal` ring (`FOCUS_RING_CLASS`); never remove outline without replacement |
| Keyboard | All primary flows operable; Esc closes detail/overlays; ⌘K documented |
| Landmarks | `header`, `nav`, `main`, complementary for AI rail when open |
| Labels | Icon-only buttons have accessible names |
| Live regions | Toasts / LIVE append announce politely |
| i18n | `next-intl` — **en + de** keys for all user-facing copy |
| Motion | `prefers-reduced-motion` |
| Hit targets | 44px mobile |

Do not rely on color alone for status — pair with icon/text.

---

## 14. Anti-patterns ban list

### Chrome & IA

- Sticky sandwich (header + filter + table head + bulk + FAB + mobile nav)
- \>2 chrome bands above content
- Dual always-on rails (nav + AI)
- Dual Observe entry points (`/observability` + `/traces`)
- Hub-of-hubs second headers
- ~19-tab Settings first paint; second 240px Settings sidebar
- Ghost Roles/SSO advertised in rail/⌘K before ship
- Parallel Ask AI products / coach overlays opening different surfaces
- Cookie preferences pill after choice
- Ad-hoc `z-[9999]` click-catchers
- LIVE as always-on first-paint primary
- Red-team UI in v1

### Visual

- 9–10px chrome micro-labels
- Purple-as-default brand / purple glow kits
- Laminar orange / Helicone light theme in portal
- Helicone **card-grid as Traces grammar**
- Decorative Card soup / nested Card→Card→Card
- Inputs that look like cards (wrong fill)
- Multiple solid accent buttons per screen
- `--terminal` or `--accent-purple` as CTA fills
- Span hues as page decoration
- Neumorphic / pillow `rounded-3xl` chrome
- Diffused multi-layer shadows on static surfaces
- Gradient hero blobs / mesh behind product work
- Phosphor green used decoratively
- Borders below WCAG 3:1
- Raw `#hex` in leaf components
- Hand-rolled `bg-[var(--accent)]` buttons
- Raw Radix Dialog/Sheet bypassing kit
- Parallel Badge vs StatusBadge visual families
- PageHeader eyebrow + hint + title triple
- Marketing exclamation CTAs / cartoon mascots

### Interaction

- Full-page navigate for every row/span open
- Equal-weight span tree as **default** reader (Transcript wins)
- Timeline/waterfall as default reader
- Merging Evaluate into Improve
- False success toasts on promote/PR
- Empty states with no next step
- Silent filter drift with no saved views
- Competing filter languages without Overflow
- 18–22 first-paint controls on Traces

### Motion & a11y

- Motion \>200ms for routine UI
- Ambient perpetual animation on product routes
- Ignoring `prefers-reduced-motion`
- Focus rings removed or blue-accent rings on kit (use terminal)
- Untranslated user-facing strings

---

## 15. Visual QA checklist (every PR)

Mechanical gates — LLM and human can verify:

### Tokens & color

- [ ] No new `#hex` outside `globals.css`
- [ ] Primary CTA uses kit `Button` `default` (one per viewport)
- [ ] Phosphor green only for running/live/focus — not decoration
- [ ] Span colors only on span labels
- [ ] Borders use `--border-*` tokens

### Type & density

- [ ] Body 14px; chrome labels ≥12px; no 9–10px chrome
- [ ] Controls 28–32px desktop; ≥44px touch targets on `max-md`
- [ ] ≤2 font weights on the touched screen
- [ ] Density toggle respected if table/list changed

### Chrome

- [ ] ≤2 bands above content
- [ ] Filter/Search/time/LIVE in list pane — not new global bar
- [ ] AI collapsed by default; one Ask surface
- [ ] Z-index from documented ladder
- [ ] Thumb-zone mutual exclusion intact on mobile

### Layout

- [ ] Master–detail for resource open (split or drawer)
- [ ] Latency · tokens · cost visible on rows/nodes when data exists
- [ ] Traces default remains Transcript unless Mode explicitly Tree/Timeline
- [ ] Cards only for interaction units; Panel for grouping
- [ ] No Helicone card collage on Traces

### Kit & a11y

- [ ] Kit Button / Dialog / Sheet / Badge / Tabs / PageHeader / QueryState
- [ ] Focus visible (`--terminal`)
- [ ] `next-intl` keys en+de for new copy
- [ ] `prefers-reduced-motion` honored for new motion
- [ ] Empty/error/filter-empty distinguished via QueryState

### Closed-loop scent (when touching Improve/Issues)

- [ ] Path to artifact/PR or eval exists; no dead-end insight cards
- [ ] One primary CTA on selection
- [ ] No false success toast

### Wave0b 10-rule spot check

- [ ] Rules 1–10 from `03-competitive-synthesis.md` §9 still hold for Observe touches

**Smoke surfaces:** Dashboard, Traces toolbar + transcript, Tree inspector, Evals compare stub, Improve queue detail, Settings overview, Agent bubble open/close, mobile bottom nav + drawer detail.

---

## 16. Migration note from `clients/portal/DESIGN.md`

| Topic | Old DESIGN.md | Design System V2 |
|-------|---------------|------------------|
| Authority | Canonical for incremental overhaul | **Canonical for rebuild**; old file historical after cutover |
| North star | Laminar-class density (PR #1810 cite) | Laminar + TraceRoot Improve + Langfuse inspector + explicit peer map |
| Tokens | Same Eden ladder | **Same ladder** — do not invent hues |
| Typography | Kill 9–10px; 14px body; 28–32px controls | Unchanged, restated as hard law |
| Chrome | ≤2 bands; Ask 1A; cookie 2A; z-ladder | Unchanged contracts; bubble = Agent page + FAB |
| Observe | V3 transcript-first contract | Rebuild surfaces rewrite plans; **contracts kept** |
| Improve | V3 queue/PR contracts | PRs first-class; TraceRoot Show Code grammar added |
| Workspace | Long Settings contracts | Carry forward into Settings surface spec |
| Kit freeze | Wave 1 V2 freeze | Freeze continues; inventory explicit in §8 |
| Mobile | Touch 44px mention | Full §12 — single column, drawer, no sticky sandwich |
| Competitive | Implicit | Points to `03-competitive-synthesis.md` |
| Teardown | N/A | Portal teardown A deletes surfaces; this doc + stub remain |

**Cutover rule:** When rebuild P1 shell lands, import paths and PR templates must cite **this file**, not `clients/portal/DESIGN.md`. Ambiguity = V2 wins.

**Do not:** Port decorative patterns from old portal leaves “because DESIGN.md allowed Card somewhere.” V2 Card rule is stricter in spirit: interaction-only, Trace surfaces row/tree-first.

**Do:** Port token names, z-index ladder, Ask 1A, cookie 2A, QueryState, DensityProvider, PageHeader freeze, Button variants, focus ring = terminal.

---

## Quick reference

```
Canvas          → --bg-primary / --bg-base
Field           → --bg-secondary + border (28–32px)
Card            → interaction unit only
Primary CTA     → --accent once per screen
Secondary       → ghost / quiet
Running/focus   → --terminal
Span labels     → LLM / tool / subagent / error only
Body            → 14px Geist Sans; chrome ≥12px
Mono            → IDs, metrics, JSON, span names
Motion          → ≤200ms; reduced-motion
Density         → comfortable | compact
Chrome          → ≤2 bands; sidebar 240/64; header ≤56px
AI              → Agent page + bubble + ⌘K → one surface
Mobile          → 44px targets; single column; drawer detail
Traces default  → Transcript + Signals strip
Inspector       → pills + I/O split (Tree Mode)
Cost/Home KPIs  → Helicone-like cards OK; Traces never
Improve exit    → artifact → PR (Show Code)
Checklist       → §15 every PR
```

---

## Related docs

| Doc | Role |
|-----|------|
| [../03-competitive-synthesis.md](../03-competitive-synthesis.md) | Steal/Adapt/Skip + Wave0b 10 rules |
| [../README.md](../README.md) | Rebuild master + D1–D10 |
| [../04-interview-log.md](../04-interview-log.md) | Frozen discovery |
| [../02-information-architecture.md](../02-information-architecture.md) | Nav + URL grammar |
| `.impeccable.md` | Repo-wide brand personality |
| `clients/portal/DESIGN.md` | Historical — superseded |
