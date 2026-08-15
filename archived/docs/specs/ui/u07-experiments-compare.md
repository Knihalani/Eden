# U07: Experiments Compare Grid

| Field | Value |
|---|---|
| **Spec ID** | U07 |
| **Priority** | P1 |
| **Effort** | L |
| **Eden status** | PARTIAL — llmops experiments thin |
| **Clone targets** | Braintrust grades; Laminar eval progression |
| **Dependencies** | F51, F33, F49, U01, U03, U18 |
| **Routes** | `/experiments`, `/experiments/[id]`, `?targetId=` |
| **Roadmap** | Wave 5; Wave 12 |

---

## 1. List page

- Rows: name, score summary, dataset, created, baseline ★
- Multi-select → **Compare**
- Progression chart: one line per score; agg avg/p50/p95; toggle runs
- Create from UI or Playground promote

Built-in views: Default, Regressions, Unreviewed (if human scores).

---

## 2. Run detail (split)

```
┌ Score cards · CSV · Share · Set baseline · Linked issue banner (F33) ───────┐
├ Datapoint table                    │ Trace panel (sticky view mode)         │
│ input / output / scores / Δ        │ Transcript of executor span            │
└────────────────────────────────────┴────────────────────────────────────────┘
```

Compare `?targetId=`: old→new deltas; green/red; grades Improvement / Regression / Tradeoff / Tie.

Diff mode: output vs expected character-level (4k cap).

---

## 3. Keyboard

`j/k` rows, `c` compare picker, `b` set baseline (confirm), `Enter` focus trace.

---

## 4. Acceptance criteria

- [ ] Side-by-side compare with per-row deltas
- [ ] Progression chart multi-score
- [ ] Split table|trace panel
- [ ] Playground → experiment
- [ ] CSV + share link
- [ ] F33 issue banner when linked

---

## 5. Performance

First 50 rows <1s; aggregates precomputed; trace panel lazy.
