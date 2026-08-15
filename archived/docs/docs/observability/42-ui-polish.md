---
title: "42 — UI polish (Phase E)"
status: IMPLEMENTED v1
last_updated: 2026-06-17
version: 1.0
---

# 42 — UI polish (Phase E)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-17).
> Closes the Laminar "UI polish" surface. Five reusable
> React components + a unified feedback library:
>  1. **TranscriptView** — LLM message cards (Laminar's
>     "transcript" with reasoning + tool calls + sub-agent
>     tree).
>  2. **RewardBars** — horizontal bar chart for eval scores
>     (Laminar's "reward bars" pattern).
>  3. **DurationScatter** — SVG scatter plot of duration vs
>     score (Laminar's eval scatter).
>  4. **EmptyState** / **Skeleton** / **Loading** / **ErrorBoundary**
>     — unified feedback library for every page.
> ~520 LOC + 4 components.

## Goal & motivation

The headline observation from the Laminar screenshot
comparison: the polish gap is the most-cited "looks
unfinished" complaint. The backend was at parity (22
cats shipped) but the UI was plain tables and dropdowns.
Laminar ships:
  * Inline LLM message cards (with reasoning toggle +
    tool-call badges + sub-agent tree)
  * Per-step cost heatmaps
  * Eval reward bars
  * Duration scatter plots
  * Consistent empty/loading/error states

Phase E ships 4 of those 5 (the cost heatmap is
deferred — see "What's NOT in this phase" below).

## Components

### TranscriptView

`clients/portal/src/components/observability/transcript-view.tsx`

Renders a single LLM call as a vertical stack of message
cards. Each card has:
  * Role icon + role name (system / user / assistant / tool)
  * Content (rendered as pre-formatted text)
  * For assistant: reasoning toggle (collapsible)
  * For tool calls: badge with status dot (ok / error / pending);
    click to expand args + result preview
  * For sub-agent traces: nested TranscriptView (recursive)

Laminar parity: full. The Laminar message cards include
a few extra affordances (e.g. message-edit-on-click,
drag-to-reorder) that are deferred to Phase E.5.

### RewardBars

`clients/portal/src/components/observability/reward-bars.tsx`

Renders a list of eval scores as horizontal bars with
colour-coded status (high = success, mid = warning, low
= error). Each bar:
  * Score name (left)
  * Score value (right, formatted)
  * Bar with width proportional to the value
  * Optional threshold (green if value >= threshold)
  * Optional description (small text under the bar)

Laminar parity: full. The "click bar to drill into
history" UX is a future cat.

### DurationScatter

`clients/portal/src/components/observability/duration-scatter.tsx`

Renders an SVG scatter plot of (duration, score) per eval.
The plot:
  * X axis: duration (ms, auto-scaled)
  * Y axis: score (0-1)
  * Points coloured by score (green / yellow / red)
  * Hover on a point shows the eval id + metadata
  * Optional "good zone" rectangle (semi-transparent green)

Laminar parity: full. The "click point to drill into
the trace" UX is a future cat.

### Feedback library

`clients/portal/src/components/ui/feedback.tsx`

Four primitives:
  * **EmptyState** — title + description + optional icon +
    optional action button. Used by every page that has
    "no data yet" (e.g. a brand-new org).
  * **Skeleton** — animated placeholder (pulse). Used
    while data is loading.
  * **Loading** — spinner + label. Used for inline loading
    indicators.
  * **ErrorBoundary** — class component that catches
    render errors. Renders a default fallback (or a custom
    fallback supplied by the parent).

Laminar parity: full. The "retry with exponential
backoff" UX is a future cat.

## What's NOT in this phase (deferred)

- **TraceCostHeatmap** — per-step cost heatmap. The
  backend (Cat 22 + Cat 8) has the data. The component
  is a 100-line addition; deferred to Phase E.5 because
  the per-step cost format is still being finalised
  (USD vs token-cost is org-configurable).
- **Click-to-edit affordances** — the message cards
  support view but not edit. A future cat adds
  inline-edit + a "save as new version" flow.
- **Drag-to-reorder** — the message list is read-only.
  A future cat adds reordering for prompt engineering.
- **Retry with backoff** — the ErrorBoundary retry
  button is one-shot. A future cat adds exponential
  backoff.
- **Animations** — the Skeleton pulse is the only
  animation. A future cat adds stagger animations
  for the message list, the score list, etc.

## Files added

| File | LOC | Purpose |
|---|---|---|
| `transcript-view.tsx` | ~200 | LLM message cards |
| `reward-bars.tsx` | ~95 | Eval score bars |
| `duration-scatter.tsx` | ~130 | SVG scatter plot |
| `feedback.tsx` | ~95 | EmptyState + Skeleton + Loading + ErrorBoundary |

## Cross-references

- [Cat 22 — APM Depth](22-apm-tracing-depth.md) — the
  source of the per-step latency data the scatter plot
  reads from.
- [Cat 3 — Evaluation Quality Intelligence](03-evaluation-quality-intelligence.md)
  — the source of the eval scores the reward bars
  display.
- [Phase C — Unified AI Agent](14-autonomous-intelligence.md)
  — the agent's responses render through TranscriptView.
- [Phase S — Dataset-as-Spreadsheet](40-dataset-spreadsheet.md)
  — the destination for playground results.
