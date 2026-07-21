# Eden Portal — Design System

Canonical visual and interaction rules for the authenticated product under `clients/portal`.  
Out of scope: docs site, `(marketing)`, landing pages.

Inspired by Laminar-class density ([PR #1810](https://github.com/lmnr-ai/lmnr/pull/1810)) and Wave 0 research (R2 / R7 / R8). Tokens live in [`src/app/globals.css`](src/app/globals.css). Prefer existing CSS variables; do not invent new brand hues.

---

## 1. Purpose & scope

Eden Portal is a **dark-only engineering tool** for observing, evaluating, and improving agent runs. Hierarchy comes from **tonal steps**, not decoration. The product should feel like a terminal-adjacent ops console (Linear / Vercel dashboard energy), not a marketing dashboard.

| In scope | Out of scope |
|----------|--------------|
| `(portal)`, `(auth)`, shared chrome / `portal-os` / `ui` kit | `docs/`, `(marketing)/`, promotional landing |
| Dark product chrome, hubs, detail panes | Light mode, dual themes |
| Dense tables, transcript reading, master–detail | Consumer whitespace, glow kits, purple-on-dark themes |

**Brand signal:** Terminal Blue (`--accent`) for primary action; Phosphor Green (`--terminal`) for running / focus / live — not as a second CTA.

---

## 2. Palette / tonal steps

Use the existing background ladder for depth. Do not add decorative accents to create hierarchy.

### Backgrounds (`--bg-*`)

| Token | Hex | Role |
|-------|-----|------|
| `--bg-base` | `#03060A` | Deepest — code blocks, terminal panels |
| `--bg-primary` | `#0A0E14` | Default page / body |
| `--bg-secondary` | `#0F1419` | Cards, popovers, **input fill** |
| `--bg-tertiary` | `#151B23` | Elevated surfaces, table headers |
| `--bg-inset` | `#060A10` | Inset wells, recessed code |

### Text (`--text-*`)

| Token | Hex | Role |
|-------|-----|------|
| `--text-primary` | `#E4ECF7` | Titles, primary values |
| `--text-secondary` | `#94A3B8` | Body supporting copy |
| `--text-muted` | `#7A8A9A` | Helper labels, meta |
| `--text-faint` | `#6B7C96` | De-emphasized chrome only (still ≥ AA) |

### Borders

| Token | Role |
|-------|------|
| `--border-subtle` | Row dividers, cell separators |
| `--border-default` | Card edges, input borders |
| `--border-strong` | Emphasized edges |
| `--border-glow` | Focus / active glow (use sparingly) |

### Accent (one primary)

| Token | Hex | Role |
|-------|-----|------|
| `--accent` | `#5B9EFF` | **Only** primary CTA / active nav |
| `--accent-hover` | `#7AB1FF` | Hover on primary |
| `--accent-dim` / `--accent-faint` | — | Selected / tinted backgrounds |
| `--accent-foreground` | `#03060A` | Text on solid accent fills |

### Reserved (not CTAs)

| Token | Role |
|-------|------|
| `--terminal` | Active / running / focus ring — **not** a second primary button color |
| `--success` / `--warning` / `--error` / `--info` | Status semantics only |
| `--status-running` | Process lifecycle (decoupled from CTA blue) |

**Rule:** Hierarchy = tonal shift + 1px border + neutral shadow. No new purple brand themes. No colored / inset / glow shadows for decoration.

---

## 3. Density & typography

| Rule | Spec |
|------|------|
| Control height | **28–32px** (`h-7`–`h-8`) for chrome, toolbars, form controls |
| Body | **14px** (`text-sm` / `--font-size-sm`) default in product UI |
| Chrome labels | Cap at **12px** (`xs`). Kill **9–10px** (`2xs` / `3xs` / `text-[9px]` / `text-[10px]`) in chrome |
| Micro mono | `--font-size-2xs` / `3xs` only for true terminal mock windows — never PageHeader eyebrows, banners, or toolbar |
| Weights | ≤ **two** font weights per screen |
| Mono | Identity-shaped + data only (IDs, durations, JSON, tool names) — not prose |
| Radii | Don’t mix radii inside one composite; prefer `--radius-sm` / `--radius-md` |
| Spacing | 4px base / 8px primary (`--space-1`…`--space-8`) |

Touch: on `max-md`, keep the existing 44px hit-area bump without growing visual control height on desktop.

---

## 4. Primary CTA

- **One** primary accent action per screen (solid `--accent`).
- Secondary actions = **ghost / quiet** (transparent or `--bg-secondary` + border; no second solid brand color).
- Destructive = `--error` grammar only — one delete style, not parallel solid/outline families.
- Do not use `--terminal` or `--accent-purple` as button fills.
- Do not ship hand-rolled `bg-[var(--accent)]` buttons when the kit `Button` exists.

---

## 5. Semantic span colors

Color in trace / transcript UI encodes **span kind**, not decoration.

| Kind | Intent | Eden mapping (use tokens, not hard-coded hex in leaves) |
|------|--------|---------------------------------------------------------|
| Tool | Tool / function call | Amber family — `--warning` (or dedicated span token aliasing it) |
| LLM | Model turn | Violet family — `--accent-purple` **only** as span-type label |
| Subagent | Nested agent card | Cyan family — `--info` / `--node-tool` |
| Error | Failed span / fault | `--error` |

**Rules**

- Span hues appear as **pills / labels in trace UI only**.
- Do not reuse tool / LLM / subagent hues as generic page accents, KPI tints, or nav chrome.
- Builder `--node-agent` / `--node-tool` stay for canvas nodes; do not invent additional decorative palette ramps.

---

## 6. Inputs ≠ cards

| Surface | Fill | Signal |
|---------|------|--------|
| Editable field | `--bg-secondary` (secondary fill) | “I can type here” |
| Card / popover | `--bg-secondary` + border + optional `shadow-sm` | Interaction unit |
| Page | `--bg-primary` / `--bg-base` | Canvas |

Inputs always use **secondary fill** so fields do not read as cards. Cards use the same tonal band but gain border + padding + (when interactive) hover — never rely on fill alone to mean “card.”

Default input / button height: **28–32px**. Focus ring stays `--terminal` (existing global contract).

---

## 7. Cards

**Cards only for interaction units** — selectable rows, clickable destinations, expandable subagent blocks, form sections the user submits.

| Do | Don’t |
|----|-------|
| Card wraps a click / expand / submit target | Wrap static KPI strips or prose in Card for polish |
| Prefer `Panel` / bare tonal grouping for layout | Nest Card → Card → Card for visual weight |
| 24px-class padding when a card is used | Decorative borders with no interaction |

If removing border, shadow, background, or radius does not hurt interaction or understanding, it should not be a card.

---

## 8. Motion

| Token | Cap |
|-------|-----|
| `--duration-fast` | 150ms |
| `--duration-normal` | **200ms** (hard ceiling for product UI) |
| `--duration-slow` | Prefer ≤200ms for new work; existing 300ms only for rare chrome width |

- Motion **confirms action** (panel open, row select, toast) — not ambient decoration.
- Allowed: panel enter, row highlight, live-append pulse (short).
- Forbidden: perpetual glow pulses in chrome, long stagger parades, marketing mesh drift on product routes.
- Honor `prefers-reduced-motion` (already nukes animations in `globals.css`).

---

## 9. Density toggle

Persist via existing `DensityProvider` / `data-density` on AppShell:

| Mode | Use |
|------|-----|
| **Comfortable** (default) | Default row padding, nav type, breathing room for occasional users |
| **Compact** | Tables / virtualized lists — more rows; tighter toolbar and cell padding |

Density is a **product setting**, not a one-off hard-coded height. Compact must not reintroduce 9–10px chrome labels.

---

## 10. Do / Don’t (aligned to plan P0–P2)

### P0 — Behavior

| Do | Don’t |
|----|-------|
| One page = one decision (Home=health, Traces=triage, Evals=compare, Improve=act) | Stuff every hub with every widget |
| ≤2 chrome bands above content | Sticky sandwich (header + filters + table head + bulk + FAB + mobile) |
| ≤5 primary toolbar actions; rest → Overflow / More / ⌘K | 18–22 first-paint controls on Traces |
| Master–detail everywhere (split ≥1280 / drawer below) | Full-page navigate for every row open |
| Transcript-first for agents; Tree / Timeline = power modes | Equal-weight span trees as default |
| Collapse by default (subagents, AI rail, metadata, timeline) | Dual side rails open (nav 240 + AI 360) |
| One primary CTA; secondary = ghost | Multiple solid accent buttons |
| Named saved views per hub | Silent filter drift with no save affordance |
| Empty states teach next step | Sad “no data” with no path |
| Flat nav ≤12 core; kill dual entry points | Parallel Observe IA (`/observability` + `/traces`) |

### P1 — Visual

| Do | Don’t |
|----|-------|
| Dark-only; hierarchy via tonal steps | Invent purple themes or new brand accents |
| 28–32px controls; 14px body | Spacious consumer chrome; 9–10px micro-labels in chrome |
| Semantic span colors only | Span hues as page decoration |
| Cards for interaction units | Decorative card soup |
| Inputs on secondary fill | Fields that look like cards |
| Motion ≤200ms | Glow kits, long ambient animation |
| Comfortable / Compact density toggle | One hard-coded density for all users |

### P2 — Eradicate

| Do | Don’t |
|----|-------|
| Use kit `Button` / `Dialog` / status primitives | Hand-rolled accent buttons; raw Radix Dialog bypasses |
| One Ask AI / CommandPalette **surface** (header icon · redesigned FAB · ⌘K/⌘J = three doors) | Competing Ask products / coach overlays that open a *different* surface |
| One Badge / Status grammar | Parallel Badge vs StatusBadge families fighting |
| Settings ≤8 visible tabs default; no double sidebar | ~19-tab settings + hub-of-hubs second headers |

---

## 11. Observe interaction contract (V3)

Locked for Observe core (`/traces`, `/sessions/[id]`, `/issues`, `/alerts`). Full plan: [`PORTAL_OBSERVE_V3_PLAN.md`](./PORTAL_OBSERVE_V3_PLAN.md).

| Rule | Contract |
|------|----------|
| Master–detail | List stays mounted; split ≥1280 / drawer &lt;1280; `?traceId=` + `?spanId=`; Esc closes |
| Default reader | **Transcript**; Mode = Tree \| Timeline \| Meta \| Scores (one control) |
| Toolbar | View tabs · Search · ≤3 filters · Views · **Display** · Overflow; clutter ≤8 primaries |
| Display owns | Columns · density shortcut · **LIVE opt-in** (never always-on primary) |
| Row / tree metrics | Latency · tokens · cost visible when API provides them |
| Timeline | Synced Gantt with transcript (power mode); not default |
| Sessions lens | Numbered turn cards (`1/N`) with Input + last LLM Output |
| Issues / Alerts | Master–detail; evidence → traces **preserves** time/filters (`TracePreserveParams`) |
| URL writers | Only `traceId` / `spanId` — alias-read legacy `span` / `trace_id` / path ids |

**Still forbidden:** dual `/observability` hub · Live as first-paint primary · Helicone card-grid as Traces grammar · waterfall as default reader.

---

## 11b. Improve interaction contract (V3)

Locked for Improve core + Advanced satellites. Full plan: [`IMPROVE_V3_PLAN.md`](./IMPROVE_V3_PLAN.md). Product job: Improve = **act** (queue → ship → remember); Evaluate = **compare** — stays separate (`/evals` not under Improve).

| Rule | Contract |
|------|----------|
| Core nav | Queue `/improve` · Plans (`?tab=plans`) · Artifacts · Ledger · **Prompts** (promoted to core) |
| Advanced | Scorecard · Online scoring · Change impact · Guardrails · Cost — sidebar Advanced + ⌘K only |
| Queue | Master–detail; ViewsMenu Needs you / In progress / Verify; one primary CTA per selection |
| Related strip | Issues · Artifacts · Ledger · Prompts (Advanced off strip) |
| Plans | Diff toggle + Summary (change / evidence / risk); kit Dialog; no false success toasts |
| Artifacts | Evidence-gated promote (hard boundary UI before CTA) |
| Ledger | Institutional memory; promotions = mode (`/ledger?tab=promotions`) |
| Prompts | List \| editor lifecycle; playground iterate deep-links to Evaluate — **no Studio merge** |
| Kit | Same frozen kit as §§1–10 + 14: dark-only · PageHeader · Button/Dialog/Badge · ≤2 chrome bands · **no new accents / glow / pill clusters** |
| Hub shell | `improve/page.tsx` ≤400 LOC (peel to `_components/`) |

**Still forbidden:** merging Evaluate into Improve · Prompts demotion to Advanced · three permanent kanban card walls as the only queue UI · hand-rolled accent CTAs on Improve hubs.

---

## 12. Chrome rules

1. **≤2 bands above content** — identity (header) + toolbar only. Banners: max one visible at a time.
2. **AI rail / overlay collapsed by default** — opt-in; never open beside nav as always-on dual rail. Never dual always-on rails (nav + AI).
3. **Ask AI — three doors, one surface (1A)** — visible entry points: header utility icon + redesigned FAB + ⌘K/⌘J. All open the **same** overlay / command surface (navigate + act + Ask AI). Not competing products; not a demoted-FAB / coach-only era.
4. **Header utility strip** — Search · Ask AI · Notifications (L→R). User / account lives in the sidebar — do not duplicate avatar in the header strip.
5. **One location grammar** — breadcrumb + page title. No PageHelpHint + eyebrow + title triple.
6. **Sidebar = places; palette = verbs + deep find** (R8).
7. Preserve `portal-os`: `ResourcePageShell`, `DetailPanelShell`, `QueryFilterBar`, `ViewsMenu`, `BulkActionBar`.

### Cookie consent (2A)

| State | Contract |
|-------|----------|
| No choice yet | Full banner until Accept or Decline |
| After Accept / Decline | Render **nothing** fixed — no preferences pill, no thumb-zone chrome |
| Reopen | Settings · Privacy · footer only |

`--cookie-banner-offset` = `0` when hidden. Ban any post-choice fixed pill. Prior WAVE11 cookie-pill lock is superseded (see **Home + Shell**).

---

## 13. Z-index / bottom-layer contract

Tokens in `globals.css` (Home Shell Wave 9 audit):

| Token | Value | Role |
|-------|-------|------|
| `--z-bulk-bar` | 20 | BulkActionBar (desktop / above-nav calc on mobile when shown) |
| `--z-mobile-nav` | 30 | `MobileBottomNav` fixed bottom-0 + `safe-area-inset-bottom` |
| `--z-ai-fab` | 35 | Ask AI FAB / coach; bottom = `--ai-fab-bottom` (clears nav + home indicator) |
| `--z-ai-rail` | 40 | Desktop AI rail aside |
| `--z-cookie` | 40 | Cookie **banner only** while awaiting choice (below dialogs). Unused after Accept/Decline (2A — no fixed pill) |
| Ad-hoc `z-40` / `z-50` | — | Modals, sheets, floating overlays |
| `--z-toast` | 60 | Toasts above dialogs |
| `--z-grain` | 9999 | Decorative only (`pointer-events: none`) |

**Bottom-layer contract (Wave 1.6 + Home Shell W9):** `BulkActionBar`, `MobileBottomNav`, Ask AI FAB, and cookie banner share the thumb zone. **Mutually exclusive** — only one occupant claims the zone at a time:

| State | Visible thumb chrome |
|-------|----------------------|
| Cookie awaiting choice | Cookie banner (FAB hidden; nav stays) |
| AI open (sheet / rail) | AI surface only — hide `MobileBottomNav` + cookie + FAB |
| Idle (choice done) | FAB + `MobileBottomNav` (FAB cleared above nav via `--ai-fab-bottom`) |
| Bulk select (desktop) | BulkActionBar; `hideOnMobile` so it never stacks with FAB+nav |

Cookie chrome is **not** a post-choice bottom occupant (2A). Do not invent another `z-[9999]` click-catcher. Prefer documented tiers over magic numbers; grain stays non-interactive.

When implementing chrome splits (`AiRailHost`, mobile nav, bulk bar, redesigned FAB), update call sites to this contract rather than raising z-index to “win.”

---

## Quick reference

```
Page canvas     → --bg-primary / --bg-base
Field           → --bg-secondary + --border-default (28–32px)
Card            → interaction unit only; tonal + border
Primary CTA     → --accent (once per screen)
Secondary       → ghost / quiet
Running/focus   → --terminal
Span labels     → tool / LLM / subagent / error only
Body type       → 14px; chrome ≥12px; no 9–10px chrome
Motion          → ≤200ms
Density         → comfortable | compact
Chrome          → ≤2 bands; AI collapsed; Ask AI = header + FAB + ⌘K/⌘J → one surface; cookie = banner then gone (2A)
```

---

## Home + Shell (fleet reopen)

Home + Shell Chrome Overhaul supersedes WAVE11 quiet-FAB / demote-coach and always-on cookie-pill locks.

| Lock | Was | Now |
|------|-----|-----|
| Ask AI | Quiet / ⌘K-only; demote FAB · coach | **1A** — header icon + redesigned FAB + ⌘K/⌘J → one overlay |
| Cookies | Post-choice fixed preferences pill | **2A** — hide completely after choice; reopen Settings / Privacy / footer only |

Always-on chrome sinks (desktop first paint): **≤6** — `sidebar` · `header` · `command-palette` · `banner` · `toast` · `ask-ai-fab`. Cookie is **not** a sink after choice.

Sources: [`.home-shell-wave0.md`](./.home-shell-wave0.md), [`.home-shell-w1-contracts.md`](./.home-shell-w1-contracts.md). Density / Laminar tokens unchanged; no new brand accents.

---

## 14. Kit grammar (Wave 1 V2 freeze)

Canonical primitives live under [`src/components/ui/`](src/components/ui/). Import from `@/components/ui` or the named file. Do not hand-roll accents or raw Radix Dialog outside `ui/dialog` / `ui/sheet`.

**Frozen contracts (do not reopen without a wave):** Badge radius/size grammar · PageHeader identity · Tabs default · focus ring · CommandPalette export path.

### Button

| Variant | Use |
|---------|-----|
| `default` | Sole solid `--accent` CTA (one per screen) |
| `secondary` | Quiet fill + border (collapsed former solid secondary) |
| `outline` / `ghost` / `link` | Quiet utilities |
| `destructive` / `danger` | One error delete style (aliases) |
| `emerald` | Deprecated alias of `default` — do not use for new work |

Height: **28–32px** (`h-7`–`h-8`); `max-md:min-h-11` for touch. Prefer kit `Button` over `bg-[var(--accent)]` leaves. Wizard / invite / lineage CTAs use kit `Button`.

**IconButton / shell utilities:** Icon-only chrome controls = kit `Button` with `size="icon"` only. Shell utilities (Search, Ask AI, Notifications, FAB trigger) use kit `Button`. Ban raw chrome `<button>` except a11y menu triggers when the kit has no equivalent.

**Shell Home path examples (W6):**

| Control | Kit usage |
|---------|-----------|
| Header menu / Search icon / Ask AI / Notifications | `Button variant="ghost" size="icon"` |
| Search…⌘K chip | `Button variant="ghost" size="sm"` + border chip classes |
| Sidebar collapse / close / pin | `Button variant="ghost" size="icon"` (focus ring from kit) |
| Home header primary CTA | `Button` (default) — one only; Docs / More / Connect = `ghost` |
| Cookie Accept | `Button variant="default"`; Decline = `ghost` / `outline` |

Zero hand-rolled `bg-[var(--accent)]` on raw `<button>` in `portal-chrome/`, `cookie-consent.tsx`, or Home header actions.

### Badge / Status / Tag (frozen)

| Primitive | Role |
|-----------|------|
| `Badge` | Single pill API (`rounded-full` base; status/outline/stage variants **frozen** — no new variants) |
| `StatusBadge` (+ Outcome / TraceOutcome / Severity / Issue / PR / ImprovePlan wrappers) | Domain status — **wraps `Badge`**, `rounded-md`, `text-xs` |
| `Tag` | Dismissible chip only (`onRemove`); wraps `Badge` |

No `text-[9px]` / `text-[10px]` on status pills. Import status wrappers from `@/components/ui` barrel.

### PageHeader (frozen)

Contract: **AppShell breadcrumb + `title` only**. Optional `actions`, optional `subtitle` (page one-liner, not location). `eyebrow` / `description` props are deprecated and **not rendered**. Home may keep `greeting`.

### Breadcrumb

**Prefer** kit [`ui/breadcrumb.tsx`](src/components/ui/breadcrumb.tsx) in `PortalHeader` (adopt / extend in W5). Wave 0: kit exported but unused; live crumbs are inline in `PortalHeader` + `lib/breadcrumbs.ts`. W1 contract: single breadcrumb API = kit — extend kit for home root + deep-path ellipsis + optional category prefix; do not grow a second inline system. Until W5 lands, inline may remain; new breadcrumb UI must target the kit.

### Tabs

| Variant | Use |
|---------|-----|
| `underline` (**default**) | Hub / product tabs |
| `pills` | Settings / embedded surfaces only |
| `default` (boxed) | Legacy / rare chrome — prefer underline for new hubs |

### FilterBar / density

- Kit `Input` + `Select`; control height `h-8` desktop / `max-md:min-h-11` touch.
- `useDensity()` from `DensityProvider`: compact tightens gap/padding.
- `QueryFilterBar` composes `FilterBar` + Advanced drawer (same density).

### Focus ring (one system)

`--focus-ring` → `--terminal`. Kit controls use `FOCUS_RING_CLASS` from `ui/focus-ring` (matches global `:focus-visible`). Do not use accent-blue focus rings on kit primitives.

### Surfaces

| Primitive | When |
|-----------|------|
| `Card` | Interaction unit (click / expand / submit). Ban decorative Card. |
| `Panel` | Tonal grouping without a box / border stack |
| `StatCard` | Real KPI summary / click-through — not decorative soup |
| `Section` | Labeled content block (title + body) without full card chrome |

### Empty / Error / Query

List hubs **must** use `QueryState` (loading → error → empty / filter-empty → children). Ban new bare `EmptyState` as the sole hub shell. Pass `EmptyState` as `emptySlot` / `filterEmptySlot`. First-run ≠ filter-empty ≠ error (D9).

### CommandPalette

Canonical: `@/components/ui/command-palette` or `@/components/ui`. `portal-os/CommandPalette` is a thin re-export for AppShell / chrome dynamic import — one implementation.

### Barrel extras

Also exported: `FilterBar`, `Wizard`, `ErrorBoundary`, `Panel`, `Tag`, `CodeChip`, full StatusBadge family.
(`LinkCard` / `DataList` removed — unused; prefer `Card` + `Link` or table rows.)

### Visual checklist (Button / Badge / Panel / Empty)

| Matrix cell | Expect |
|-------------|--------|
| Button `default` | Solid accent; one per viewport |
| Button `secondary` / `outline` / `ghost` | Quiet — no second solid brand |
| Button `destructive` ≡ `danger` | Solid error |
| Badge / StatusBadge | Shared pill; status icons via StatusBadge; no 10px micro |
| Tabs | Underline default; pills only embedded/Settings |
| PageHeader | Title (+ actions/subtitle); no eyebrow/hint triple |
| Panel vs Card | Panel = group; Card = interact |
| EmptyState | Inside QueryState on hubs; title + next-step |
| Focus | Terminal green ring |

Smoke: Home, Traces toolbar, Settings delete-org / transfer / 2FA disable dialogs, ScoresTab “Run judges”, portal 404, invite accept CTA, wizard Next.

---

## Workspace

<!-- WS1_DESIGN_COMPLETED -->

Locked for Workspace (`/settings`, `/audit-trail`, sidebar / mobile More group **Workspace**). Aligns with §4 Primary CTA, §10 P0/P2, §12 Chrome, §14 Kit. Peer grammar: Linear / Vercel / Stripe team-settings overview (R3). Sources: `.workspace-research-wave0.md`, `.workspace-research-r9-design-addendum.md`.

Workspace answers: **who owns this workspace, can I unblock keys / people / plan, and can I prove what changed?** — not a second product hub of Observe / Eval / Improve dashboards.

### Overview composition (one composition)

`/settings` with no tab or `?tab=overview` is the **default Settings landing** — one composed surface, not a hub-of-hubs. One primary CTA; fail→act ≤2 clicks to keys / members / billing.

| Band | Contract |
|------|----------|
| **Identity** | Workspace name + personal/team scent (slug / avatar optional). Kit `PageHeader`: title **Settings** (or **Workspace** if product renames) + optional one-liner subtitle. No eyebrow / PageHelpHint triple (§12). |
| **Plan chip** | Calm plan / seat pulse (Stripe-class) — not an invoice spreadsheet or FinOps explorer. |
| **Health row** | Members count · API key health · audit snapshot (link to full trail). Prefer `Panel` / tonal grouping — **not** decorative StatCard soup. |
| **Primary CTA** | Solid `--accent` **once**. Context picks the job: **Create API key** · **Invite member** (team only) · **Manage billing** · or **Upgrade to team** (personal). All other actions = ghost / quiet / daily tabs. |
| **Chrome** | ≤2 bands above content: identity + category/tab toolbar. Search may live in the toolbar band — not a third sticky strip. |

**Cards:** only for interaction units (invite, key create, danger). Ban KPI card grids and second product-home widgets on overview.

**Empty / blocked:** `QueryState` + next step (create org, request admin, upgrade). No sad “no data” without a path.

**Forbidden on overview:** parallel solid accent buttons; hub-of-hubs second headers; Observe/Eval/Improve loop chrome.

### Personal vs team mode

Driven by `Organization.is_personal`. Mode changes **copy and soft-hide**, not a second Settings app. Use shared mode helpers (`workspace-mode` / `use-org`) — do not fork leaf UIs.

| Mode | Do | Don’t |
|------|----|-------|
| **Personal** | Label “personal workspace”; Account · API Keys · Billing · Security stay first-class; Members explains upgrade (no invite spam); overview may show **Upgrade to team** as the accent CTA | Show invites / SCIM / ownership transfer / org 2FA-enforcement chrome as available |
| **Team** | Members invite first-class; transfer / SCIM behind permission + Advanced | Reuse personal-only empty copy that blocks invites |
| **Both** | Permission gates with quiet microcopy; denied deep-links toast + rewrite to a safe daily tab | Silent dead tabs or hard 404 for known soft-hides |

**Personal soft-hides (must stay soft):** invites, SCIM, transfer ownership, team-only security enforcement. Keep deep-link handling — rewrite quietly; do not invent Roles/SSO product to “fill” the gap.

### Unified audit trail

**One** compliance reader. Dual live surfaces = **0**.

| Rule | Contract |
|------|----------|
| Canonical URL | **`/audit-trail` only** — Events \| Chain packs (or equivalent segments); toolbar ≤5 primaries; EmptyState teaches next step. |
| Settings alias | `?tab=audit-log` **redirects** to `/audit-trail` (preserve filter / agent scent when present). No competing Settings compliance body. |
| Sidebar / mobile | Single Workspace entry **Audit trail** → `/audit-trail`. Do not add a peer “Compliance” nav item. |
| Overview | Audit **snapshot** only — one quiet link into the full trail (≤2-click scent). |
| Tools | Export / verify live on `/audit-trail` (collapsed details OK). Do not rebuild a second tool wall under Settings. |

**Still forbidden:** `/compliance` as a third peer · Settings audit-log tab body that duplicates the trail · advertising Roles/SSO as the path to “compliance.”

### Daily tabs ≤6 (+ Advanced)

Settings chrome = **category pills** (or equivalent) + secondary tab list. Default paint shows **≤6** `defaultVisible` daily tabs. Advanced is **collapsed** by default.

| Tier | Tabs (canonical) | Notes |
|------|------------------|-------|
| **Daily** (≤6) | Overview *(or Org-as-home)* · Account · API Keys · Members · Security · Billing | First-paint path for fail→act. Org identity may fold into overview (still ≤6). |
| **Advanced** | Gateway · PII · Retention · Exports · SCIM · MCP · Status · Analytics · FinOps · Autonomous · Sidebar · References · DLQ / data-plane leaves · … | Distinct group (`data-settings-group="advanced"`); never inflate the daily rail |
| **Ghosts** | — | Not in daily, Advanced, or search promo (see below) |

**Cap rule:** New Settings tabs default to Advanced unless a wave explicitly promotes one into the daily ≤6 set (and drops another). Compliance is **not** a seventh daily tab — it is `/audit-trail`.

Categories may remain Org / Members / Security / Billing / Advanced (≤6 pills). Search may surface Advanced without promoting them to daily.

### Ghosts soft-hide (Roles / SSO)

**Ghosts A:** Roles + SSO stay out of IA until backend ships. Quiet deep-link only — no advertised UI.

| Ghost | Contract |
|-------|----------|
| `roles`, `sso` | **Not** in tab registry rail, category pills, mobile Workspace group, or ⌘K promotion |
| Deep-link `?tab=roles` \| `?tab=sso` | Quiet notice (inline or toast) → land on overview/org; `router.replace` to safe daily tab |
| Future ship | Implement and add to Advanced **or** keep ghost forever — never half-advertise in the rail |

Personal-org SCIM / invite denial is a **mode soft-hide**, not a ghost: toast “Team organizations only,” rewrite to safe tab.

### Hard bans

| Ban | Rationale |
|-----|-----------|
| **No second ~240px Settings sidebar** | Portal nav owns place-switching. Settings = hub + `?tab=` (pills / toolbar). Never nest a full 240px rail inside Settings. |
| **Preserve `?tab=` deep links** | All Settings destinations stay URL-addressable. `audit-log` → `/audit-trail`. Alias-read unknown tabs safely; do not drop query on refresh. Nested `/settings/(tabs)/*` leaves must not fork a second IA. |
| **DESIGN kit only** | Kit `Button` / `Tabs` (pills OK on Settings) / `Dialog` · `Sheet` / `PageHeader` / `QueryState` / `Panel` · `Card` per §§7 + 14. No hand-rolled `bg-[var(--accent)]` CTAs; no raw Radix Dialog bypass. |
| **No dual compliance UIs** | Canonical `/audit-trail` only; zero competing Settings audit body. |
| **No 19-tab first paint** | Regression against daily ≤6 + Advanced collapse / clutter lints. |
| **No ghost promo** | Roles / SSO never in rail, pills, or ⌘K. |
| **No dual Observe reopen** | Workspace work must not resurrect `/observability` as a parallel Observe hub. |

### Fail → act (≤2 clicks)

From Workspace overview / Settings default (`/settings` or `?tab=overview`), the user reaches the three recovery jobs in **≤2 clicks** (overview CTA = click 1; daily tab = click 1).

| Job | Canonical path | Click budget |
|-----|----------------|--------------|
| **API keys** | Overview CTA **or** `?tab=api-keys` | ≤2 |
| **Members** | Overview CTA **or** `?tab=members` | ≤2 |
| **Billing** | Overview CTA **or** `?tab=billing` | ≤2 |

Sidebar / mobile Workspace children may deep-link (`/settings?tab=api-keys`) as click 1 from anywhere in-product. ⌘K must expose the same three verbs (no ghost promo). Do not bury keys / members / billing exclusively under Advanced or a second sidebar.

**Still forbidden:** double Settings rail · ghosts in the daily list · personal-mode invite/SCIM/transfer as primary CTAs · compliance tool walls on first paint · kit bypasses for delete-org / transfer / 2FA dialogs · overview as a second product home.

### Mobile Workspace IA

Mobile More sheet **Workspace** group must match desktop Workspace: **Audit trail**, **Settings**, **API keys**. Move Artifacts / Alerts / Ledger / Promotions / Debug sessions out of that label (they are not Workspace).

### Quick reference (Workspace)

```
Overview     → one composition: identity · plan · health · one --accent CTA
Personal     → soft-hide team jobs; keep keys / account / billing / security
Team         → invite + members first-class
Compliance   → /audit-trail only; ?tab=audit-log redirects
Daily tabs   → ≤6 defaultVisible + Advanced collapsed
Ghosts       → roles/sso soft-hide; quiet notice; safe daily rewrite
Hard bans    → no 240px settings sidebar; preserve ?tab=; kit Button only; no dual audit
Fail→act     → keys | members | billing in ≤2 clicks
Mobile IA    → Audit trail · Settings · API keys (match desktop)
```
