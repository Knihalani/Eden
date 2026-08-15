# U13: Debugger Sessions

| Field | Value |
|---|---|
| **Spec ID** | U13 |
| **Priority** | P1 |
| **Clone targets** | Laminar debugger-sessions |
| **Dependencies** | F01, F74, N11, U18 |
| **Routes** | `/debugger-sessions`, `/debugger-sessions/[id]` |
| **Roadmap** | Wave 7; Wave 12 |

---

## 1. Summary

Multi-run iteration timeline: runs (traces), evaluations, markdown notes — live SSE. Extends F01 single-trace replay into a session product.

---

## 2. List

Name, updated, run count, last score Δ. New session / open from CLI deep link.

---

## 3. Session view

```
┌ Title (inline edit) · Copy env flags · Copy URL · Live ─────────────────────┐
├ Outline of blocks                                                            │
├ Timeline: [Run 1 trace cards] [Note] [Eval Δ] [Run 2…]                       │
│ Trace segments: transcript-style; click span → panel                         │
│ Eval cards: per-score averages + delta vs previous in session                │
│ Notes: markdown; <span id> chips jump to spans                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Actions
Set cache-until span for F01 replay; open fullscreen trace; attach playground run.

---

## 4. Empty state

> "Debugger sessions record agent iteration: replay from a span boundary, compare evals, leave notes."
> Link F01 docs + CLI flags.

---

## 5. Acceptance criteria

- [ ] Multi-run timeline in one session
- [ ] Live SSE updates
- [ ] Notes with clickable span refs
- [ ] Eval Δ cards vs previous run
- [ ] Deep link from CLI/env file

---

## 6. Performance

SSE reconnect; virtualize long timelines; initial load <1s for ≤20 blocks.
