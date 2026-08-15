# Wave 12 — UX friction & micro-interaction sweep

**Goal:** finish the clarity mandate Waves 10/11 started and add the
interaction layer that makes the whole portal feel alive. Two classes of
work: (1) the *remaining* data-model leaks (raw ISO timestamps the clarity
sweep missed, bare "Search…" placeholders, double labels) and (2) tactile
micro-interactions (button press feedback, one-click search clearing, link
affordance on dashboard KPIs). Pure frontend wave; backend untouched.

---

## 1 — Finished the clarity sweep (Wave 11 stragglers)

The Wave 11 audit documented "human timestamps everywhere" but four surfaces
still rendered raw ISO strings:

| Surface | Before | After |
|---|---|---|
| Traces detail header | `2026-08-01T00:00:00.000Z` | `3h ago` (full date on hover) |
| Issues list rows | `· 2026-08-04T00:00:00Z` | `· 2d ago` |
| Issues detail meta + metric strip | raw `firstSeen` / `lastSeen` | relative, full date on hover |
| Issues runs tab | raw `startedAt` | relative, full date on hover |
| Detector detail "Last hit" | raw `lastHit` | relative, full date on hover |
| Guardrail detail "Last hit" | raw `lastHit` | relative, full date on hover |

Audited-and-kept: debugger / compare / agent-chat rows already render
backend-supplied human strings (`"just now"`, `"2h ago"`) — running them
through `formatRelativeTime()` would have turned them into "—".

## 2 — Search everywhere is now a real search field

Bare `placeholder="Search…"` gave zero hint of what a field could match.
Every master-list feed now has a descriptive placeholder:

- Traces feed: `Search runs, ids, agents…` (sessions: `Search sessions, ids…`)
- Issues: `Search issues, ids, agents…`
- Detectors: `Search detectors, agents…`
- Agents runs: `Search runs, ids…`
- Debugger: `Search sessions, ids…` · Compare: `Search splits, ids…` ·
  Guardrails: `Search policies, ids…` · Agent chat: `Search conversations…`

## 3 — New shared `SearchInput` (lab-ui.tsx)

One component for the master-list feeds: a visible search glyph on the left,
the native WebKit cancel button hidden, and a **custom clear (×) button**
that appears once the field has text — clicking it clears *and* returns
focus so the next query is one keystroke away. Used on traces, issues,
agents, and detectors so filtering behaves identically on every list.

Also removed a double-label: issues + detectors wrapped `AgentScopeFilter`
(which already renders "Viewing agent") in an extra `<p>Agent</p>` label —
the redundant label is gone.

## 4 — Tactile micro-interactions

- **Button press feedback** (`components.css`): `.ds-btn` and `.ds-tab` now
  sink 1px on `:active` — controls feel mechanical, not flat. The primary
  button also deepens its gold on press. Hover keeps the gold-wash
  convention; reduced-motion is handled by the global transition clamp.
- **KPI link affordance** (Home): the four dashboard tiles are links but
  didn't look like it. A faint chevron fades in on the right on hover, so
  the "these are navigable" signal is there without cluttering the flat
  aesthetic.
- **Action-bar declutter** (traces detail): the generic "Compare" button
  moved into the More menu (as "Compare runs") — "vs prev" remains the
  discoverable one-click diff entry, so the header lost a button without
  losing a feature. "Fail" is now "Jump to failure" with a tooltip naming
  how many failed spans it will take you to.

## 5 — Validation

- Portal vitest: **360/360 pass (74 files)** — includes 3 new `search-input.test.tsx`
  tests (clear button appears only with text; clears + refocuses).
- `tsc --noEmit` clean; eslint 0 errors (14 pre-existing warnings, none in
touched files).
- Reviewer pass applied: the More menu is now controlled and closes when
  "Compare runs" opens the diff dialog; the button-press CSS carries no
  persistent transform base (avoids stacking contexts on every control);
  the Home KPI chevron renders only on lg+ cards so it can never occlude
  long values.

## Files touched

`lab/lab-ui.tsx` · `app/(portal)/traces/traces-client.tsx` ·
`app/(portal)/issues/issues-client.tsx` · `app/(portal)/signals/signals-client.tsx` ·
`app/(portal)/agents/agents-client.tsx` · `app/(portal)/home/home-client.tsx` ·
`lab/guardrails/guardrails-detail-view.tsx` · `lab/guardrails/guardrails-list-view.tsx` ·
`lab/debugger/debugger-list-view.tsx` · `lab/compare/compare-list-view.tsx` ·
`lab/agent/agent-chat-view.tsx` · `styles/components.css` · this doc
