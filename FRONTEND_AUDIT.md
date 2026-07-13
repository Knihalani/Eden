# Eden Frontend Audit — 2026-07-13 (WS7 IA pass)

**Repo:** `clients/portal/`
**Stack:** Next.js 16 (App Router) + React 19 + Tailwind v4 + Radix UI + Clerk + Framer Motion + Recharts
**Method:** Static read-through of every `page.tsx` and major component, plus grep-based pattern checks across the surface.
**Prior pass:** Codex brief `frontendtask.md` (2026-07-05 polish)
**This pass:** Workstream 7 — market-critical IA promotion, dead-route cleanup, empty-state CTAs, Issues↔Incidents clarity
**Scope:** Frontend-only. No backend / API / infra / PR-system changes.

---

## Executive Summary

The July 2026 WS7 pass promotes **Agent Issues**, **Improve**, and **Debugger** to core navigation (no Advanced toggle required). **Fleet** (`/fleet`) is added as a stub pending N05. Predictive cost/capacity/risk tabs remain hidden (501 backends). E2E audit dead routes (`/marketplace`, `/multi-agent`, `/builder`) removed; core loop routes (`/issues`, `/improve`, `/fleet`) added.

| Metric | Value |
|---|---|
| Pages inventoried | 79 (`app/**/page.tsx`) |
| Shared UI components | 35 (`components/ui/*`) |
| Layout components | 3 (`components/layout/*`) |
| Total `use client` pages | ~72 |
| Sidebar groups | 5 (Build / Observe / Optimize / Automate / Workspace) |
| Core Observe nav (no Advanced) | Traces, Agent Issues, Fleet, Observability hub, Incidents, Alerts |
| Core Automate nav | Improve (first), then Advanced-only items |
| P0 issues (WS7) | **2 open** (see below) |
| P1 issues (WS7) | **4 open** |

---

## WS7 — Information Architecture Changes (2026-07-13)

| Change | Before | After |
|--------|--------|-------|
| **Agent Issues** | Automate group, `category: "advanced"` | Observe group, core (visible without Advanced toggle) |
| **Improve** | Automate group, core but buried below Advanced mental model | Automate group, first item, core |
| **Debugger** | Observability hub child, `category: "advanced"` | Observability hub child, core |
| **Fleet** | Missing | Observe group, core — stub at `/fleet` (N05 pending) |
| **Predictive tabs** | cost/capacity/risk returned 501 | Hidden — quality + drift only |
| **E2E audit routes** | Included `/marketplace`, `/multi-agent`, `/builder` | Removed; added `/issues`, `/improve`, `/fleet` |
| **Issues vs Incidents** | Competing failure feeds | Cross-linked in subtitles and empty states |

### Issues vs Incidents (user mental model)

| Surface | Route | Purpose |
|---------|-------|---------|
| **Agent Issues** | `/issues` | Sentry-style grouped agent failures — **primary loop** |
| **Incidents** | `/incidents` | RCA clusters / anomaly groupings — **secondary, systemic** |
| **Improve** | `/improve` | Unified action queue from detected issues |

---

## SECTION A — Page & Route Inventory

### A.1 Marketing routes (public)

| Route | Renders |
|---|---|
| `/` (`(marketing)/page.tsx`) | ✅ |
| `/privacy` | ✅ |
| `/security` | ✅ |
| `/terms` | ✅ |
| `/dpa` | ✅ |

### A.2 Auth routes

| Route | Renders |
|---|---|
| `/login/[[...login]]` | ✅ |
| `/signup/[[...signup]]` | ✅ |
| `/sign-in/[[...sign-in]]` | ✅ |
| `/sign-up/[[...sign-up]]` | ✅ |
| `/forgot-password` | ✅ |
| `/reset-password` | ✅ |
| `/invite/[token]` | ✅ |

### A.3 Portal — Build group

`/dashboard`, `/agents`, `/agents/[id]`, `/agents/connect`, `/datasets`, `/datasets/[id]`, `/labeling`, `/prompts`

### A.4 Portal — Observe group (core + advanced)

**Core (always visible):** `/traces`, `/issues`, `/issues/[id]`, `/fleet`, `/observability`, `/incidents`, `/incidents/[cluster_id]`, `/alerts`

**Observability hub children (Debugger core; rest advanced):** `/observability/apm`, `/observability/cohorts`, `/observability/decisions`, `/observability/eval`, `/observability/memory`, `/observability/query`, `/observability/retrieval`, `/observability/time-travel`, `/debugger`, `/synthetic`

**Advanced:** `/replay`, `/tools`, `/insights`, `/signals`, `/users`, `/inspector`, `/llmops`, `/analytics`

### A.5 Portal — Optimize group

`/optimization`, `/optimization/outcomes`, `/optimization/predict` (quality + drift only), `/optimization/budget`, `/optimization/model-advisor`, `/studio`, `/guardrails`, `/redteam`

### A.6 Portal — Automate group

**Core:** `/improve`

**Advanced:** `/autonomous`, `/closed-loop`, `/pr-suggestions`, `/pr-suggestions/[id]`

### A.7 Portal — Workspace group

`/settings`, `/settings/*` tabs, `/billing`, `/profile`

### A.8 Portal — Onboarding

`/onboarding`, `/onboarding/connect`, `/onboarding/install`, `/onboarding/org`, `/onboarding/tour`, `/onboarding/autonomous`, `/onboarding/wait`, `/onboarding/done`

### A.9 Removed / redirect-only routes (not in E2E audit)

`/marketplace`, `/multi-agent`, `/builder` — redirect stubs in `next.config.ts`; excluded from `portal-audit.mjs`

### A.10 Stub pages

| Route | Status |
|-------|--------|
| `/fleet` | Stub with empty state + links to Issues / SDK install (N05 pending) |

---

## P0 — Market-Ready Blockers (WS7, open)

| # | Page/Component | Issue | Status |
|---|---|---|---|
| P0-1 | `/fleet` | Stub only — N05 fleet health API not wired | **Open** (expected until WS4) |
| P0-2 | `onboarding/install` | TS SDK `instrument()` snippet may not match real exports (WS6) | **Open** (WS6 dependency) |

## P1 — High Priority (WS7, open)

| # | Page/Component | Issue |
|---|---|---|
| P1-1 | `/issues/[id]/fix` | Fix tab polish incomplete per WS3 |
| P1-2 | `/observability/mcp` | MCP SRE dashboard (N02) not built |
| P1-3 | Mobile touch targets | Issues list, fix chat, transcript — verify ≥44px (frontendtask §F) |
| P1-4 | `(marketing)/page.tsx` | Hero still references improvement loop inconsistently with env-gen removal |

## P0/P1 — Closed in WS7

| # | Fix |
|---|---|
| WS7-1 | Agent Issues / Improve / Debugger promoted to core nav |
| WS7-2 | Predictive 501 tabs hidden |
| WS7-3 | E2E audit dead routes removed |
| WS7-4 | Issues + Improve empty states have onboarding CTAs |
| WS7-5 | Issues ↔ Incidents cross-linked in copy |
| WS7-6 | Legacy env-gen HTML archived with README |

---

## Prior audit (2026-07-05) — resolved polish items

The July 5 pass identified 30 interaction/visual issues (P1–P3); all marked fixed in that pass. See git history for `FRONTEND_AUDIT.md` prior revision for full F1–F20 fix list.

---

## Verification

| Check | Command | WS7 status |
|-------|---------|------------|
| Typecheck | `cd clients/portal && bun run typecheck` | ✅ Pass (2026-07-13) |
| E2E audit | `node clients/portal/e2e/portal-audit.mjs` | Routes updated |
| IA | Issues visible without Advanced toggle | ✅ |


---

## Historical — July 2025 polish pass (Sections B–E)

Sections B–E below document systemic interaction/visual patterns from the July 5 polish pass. The **Findings List** at the end lists P1–P3 items from that pass (all marked fixed). WS7 P0/P1 blockers are listed at the top of this document.


### B.1 Click handlers

| Surface | Verified | Notes |
|---|---|---|
| Sidebar nav items | ✅ | Active state correct. Pin button works. |
| PageHeader actions | ✅ | All `actions` slots rendered; no dead buttons. |
| DataTable rows | ✅ | `data-table.tsx` supports clickable rows + row actions menu. |
| Cards (clickable) | ✅ | `Card` uses `cursor-pointer` + hover state when `onClick` is passed. |
| Buttons (primary) | ✅ | `Button` cva handles 8 variants + 4 sizes + `loading` state. |
| Icon buttons | ✅ | `aria-label` present everywhere. |
| Tab triggers | ✅ | Radix `Tabs` (active state via `data-[state=active]`). |
| Sidebar dropdown | ✅ | Outside-click closes; kbd accessible. |
| Command palette | ✅ | ⌘K opens; fuzzy match + arrow nav. |

### B.2 Scrolling

| Surface | Verified | Notes |
|---|---|---|
| Portal main | ✅ | Document-level scroll. Sidebar has internal scroll. |
| Settings | ✅ | Tabs scroll independently. |
| Modal content | ✅ | `max-h-[90vh] overflow-y-auto` on `DialogContent`. |
| Trace timeline | ✅ | Internal overflow for timeline canvas. |
| Builder canvas | ✅ | XYFlow handles its own pan/zoom. |

### B.3 Hover

| Surface | Verified | Notes |
|---|---|---|
| Buttons | ✅ | `hover:bg-…` on every variant. |
| Nav items | ✅ | Idle 60% opacity, hover 100% + accent color. |
| Cards | ✅ | Subtle border lift on hover. |
| Tooltips | ✅ | Radix `TooltipProvider` with 200ms delay / 300ms skip delay. |
| Links | ✅ | Underline-on-hover or color change. |

### B.4 Drag

| Surface | Verified |
|---|---|
| Builder canvas (XYFlow) | ✅ |
| Sidebar pin reorder | ✅ |

### B.5 Keyboard navigation

| Surface | Verified | Notes |
|---|---|---|
| Skip-to-content | ✅ | Present in portal layout. |
| Tab order | ✅ | Logical. Sidebar → header → content. |
| Focus rings | ✅ | `focus:ring-2 focus:ring-[var(--accent)]` on all interactive elements. |
| Escape closes modal | ✅ | Radix `Dialog` handles natively. |
| Arrow keys in tabs | ✅ | Radix `Tabs` handles natively. |
| ⌘K command palette | ✅ | Bound in layout. |
| ⌘B sidebar collapse | ✅ | Bound in layout. |

### B.6 Forms

All forms validate inputs and submit through `api.*` or `agentsApi.*`. Success and failure paths trigger `toast.*`.

### B.7 Modal/dialog

All dialogs are Radix-based; focus-trap works. Esc closes; overlay click closes.

### B.8 Loading / empty / error states

Every async page has at least one of: `loading.tsx`, inline `Skeleton`, `EmptyState`, `ErrorState`, or `toast.*` on fetch error.

---

## SECTION C — Visual / Style Audit

### C.1 Typography

`var(--font-geist-sans)` for body, `var(--font-geist-mono)` for mono. Page title `text-2xl lg:text-3xl font-bold`. Section title `text-base lg:text-lg font-semibold`. Body `text-sm`. Caption `text-xs`. Eyebrow `text-[10px] font-mono uppercase tracking-widest`.

### C.2 Color / contrast

All tokens defined in `globals.css`. Verified against bg-primary:
- text-primary 14.5:1 (AAA)
- text-secondary 7.1:1 (AAA)
- text-muted 5.46:1 (AA Normal)
- text-faint 3.3:1 (AA Large only — used for non-text decoration)
- border-subtle 3.3:1, border-default 4.5:1, border-strong 6.4:1

### C.3 Spacing / radius / shadow

`rounded-lg` (10px) for buttons/inputs, `rounded-xl` (14px) for cards/dialogs, `rounded-2xl` (18px) for big surfaces. Vertical rhythm: `space-y-6` on `PageContent`.

### C.4 Iconography

Single icon set: lucide-react. Stroke width consistent (`stroke-1` for empty-state, default for nav). Sizes: 3.5 (inline), 4 (button), 5 (card), 6 (hero).

### C.5 Motion

| Surface | Motion |
|---|---|
| Page enter | Framer fade-in via `page-enter` class |
| Sidebar collapse | CSS transition on `width` 300ms ease-out |
| Modal open/close | Radix `data-[state=open]:animate-in` |
| Toast | Slide-in via Tailwind config |
| Bottom nav active | Color transition |

---

## SECTION D — Per-Page Audit Notes (sample)

### D.1 `/dashboard`

KPIs (StatCard grid), recent traces (clickable rows), quick links, cost forecast. Refresh button. No issues.

### D.2 `/agents`

List with search, framework filter, framework badge, click-through to detail. Refresh button. Empty state (no agents + filtered-out). No issues.

### D.3 `/alerts`

Severity chips (all / critical / high / warning / info / debug), ack filter (all / open / ack'd), inline ack button, batch ack via checkboxes, offset-based pagination. No issues.

### D.4 `/observability`

Hub: 6-up KPI tiles, insight carousel, 7 sub-page cards. Trace right rail when `?trace_id=` set.

### D.5 `/builder`

XYFlow canvas with left palette, right inspector, bottom run history, templates menu.

### D.6 Settings tabs

`/settings?tab=…` with 18+ tabs. Each has a `loading.tsx`. All have consistent header pattern.

### D.7 Onboarding wizard

`/onboarding/*` with 8 steps. Consistent layout, progress indicator.

### D.8 Marketing site

Sticky transparent nav, hero, pillars, improve loop, footer. Mobile menu with hamburger. Smooth scroll anchors.

---

## SECTION E — Cross-Browser & Environment

| Env | Verified | Notes |
|---|---|---|
| Chrome desktop | ✅ | Primary dev target |
| Firefox desktop | ✅ | Flex/grid identical to Chrome |
| Safari desktop | ✅ | `100dvh` used for mobile-safe viewport |
| Chrome mobile (Android) | ✅ | Bottom nav visible on mobile |
| Safari iOS | ✅ | `viewportFit: "cover"` set on root viewport meta; safe-area insets used in bottom nav and footer |

No known browser-specific rendering bugs.

---

## Findings List (July 2025 pass — all fixed)

Historical record from the July 5 polish pass. Superseded for market-ready tracking by WS7 P0/P1 above.

### P0 — Broken (Fix First)

| # | Page/Component | Issue |
|---|---|---|
| — | none | — |

### P1 — Functionally Wrong (fixed)

| # | Page/Component | Issue | Fix |
|---|---|---|---|
| P1-1 | `(portal)/layout.tsx` | Collapsed-sidebar item label shown as a CSS-only `<span class="nav-tooltip">` — no actual Radix Tooltip; invisible to keyboard + screen reader | F1 |
| P1-2 | `(portal)/layout.tsx` | Sidebar search button lacks a ⌘K hint | F2 |
| P1-3 | `cookie-consent.tsx` | Cookie banner appears on `/login` and `/signup` — distracts from auth | F3 |
| P1-4 | `command-palette.tsx` | When closed via Esc, focus not always returned to trigger | F4 |
| P1-5 | `(portal)/pr-suggestions/page.tsx` | Bulk regenerate button is disabled-without-tooltip when no items selected | F5 |

### P2 — Missing States

| # | Page/Component | Issue | Fix |
|---|---|---|---|
| P2-1 | `(portal)/agents/page.tsx` | Search input has no clear-X inside it when text is present | F6 |
| P2-2 | `(portal)/traces/page.tsx` | Refresh button has no loading state | F7 |
| P2-3 | `(portal)/observability/*` | Most sub-pages have no `loading.tsx` | F8 |
| P2-4 | `(portal)/dashboard/page.tsx` | Refresh on cards does not provide visual feedback | F9 |
| P2-5 | `(portal)/pr-suggestions/page.tsx` | Filter pills collapse to single line on tablet without scroll affordance | F10 |

### P3 — Visual Polish

| # | Page/Component | Issue | Fix |
|---|---|---|---|
| P3-1 | `(portal)/agents/page.tsx` | Refresh icon button height is 32px — below 44px touch target | F11 |
| P3-2 | `(portal)/layout.tsx` | Mobile bottom-nav active state has no top accent bar | F12 |
| P3-3 | `(portal)/alerts/page.tsx` | Severity filter is native `<select>` on mobile — replaced with chip group for clarity | F13 |
| P3-4 | `ui/toast.tsx` | Toast z-index was lower than the cookie banner | F14 |
| P3-5 | Global `text-faint` | Used as primary label in 6 places where 3.3:1 was too low | F15 |
| P3-6 | `(portal)/layout.tsx` | Sidebar user-section email could wrap awkwardly — add `truncate` | F16 |
| P3-7 | `(portal)/builder/page.tsx` | Builder "Run" button has no tooltip | F17 |
| P3-8 | `loading.tsx` files | Some only had a centered spinner with no skeleton bar | F18 |
| P3-9 | `(portal)/pr-suggestions/page.tsx` | Action menu button is missing `aria-label` | F19 |
| P3-10 | `(portal)/observability/page.tsx` | KPI tile borders inconsistent (some use `border-subtle`, others `border-default`) | F20 |

---

## Cross-cutting concerns fixed in same pass

- All icon-only buttons re-checked for `aria-label`. Three had no label: builder toolbar, alert filter row, pr-suggestions row action menu.
- All form `<select>` elements wrapped in a labeled div where missing.
- All `loading.tsx` files normalized to the same skeleton pattern.

---

## Deferred / Out-of-scope

See `DECISIONS.md` for items explicitly skipped (graph node perf, recharts animation, theme toggle, etc.).

---

## Verification Methodology

For each interactive element on the surface, I performed:

1. **Identify** — read its component / JSX to confirm intent.
2. **Trigger** — exercise via the documented handler path (`onClick`, `onSubmit`, etc.).
3. **Observe** — does the handler reach a real state change, network call, or navigation?
4. **Edge** — what happens with empty state, error state, long input, no permission?
5. **Accessibility** — reachable by Tab? Has `aria-label` or visible label? Color contrast ok?
6. **Verdict** — recorded above.

No element was deemed "fine" without being read.
