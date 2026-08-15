# Wave 3 — Phoenix patterns (span trees without chrome competition)

**Agent:** `w3-phoenix`  
**Date:** 2026-07-20  
**Sources:** [Phoenix release notes](https://arize.com/docs/phoenix/release-notes) · [Extract data / filter UI](https://arize.com/docs/phoenix/tracing/how-to-tracing/importing-and-exporting-traces/extract-data-from-spans) · PR [trace tree search #14074](https://github.com/Arize-ai/phoenix/pull/14074)  
**Baseline:** Eden TraceDetailPanel + TranscriptView; Observe card-nest depth ~5

---

## Steal (calm detail, not hub piles)

### P1 — Quiet in-tree search

Phoenix replaced a loud “Trace” header label with a quiet **Search trace** field that filters visible spans while **preserving ancestor context**. Matching branches stay expanded.

**Eden steal:** Put span/tree search **inside** the detail panel — never as hub chrome.

### P2 — Filter DSL in one bar

Python-boolean filter expressions in the project filter bar (same as SDK `.where()`). Power without a second nav.

### P3 — Sessions as a peer list mode

Sessions tab groups multi-turn history; session tools (stats, turn dividers) live in **session context**, not competing with project header.

### P4 — Optional chart strip is resizable / per-table

Metric charts above tables are **opt-in/resizable** — not an immovable third band on every visit.

### P5 — Column customize without sprawl

Pick/reorder columns on traces/sessions/experiments tables — menu-driven (aligns with Laminar hide-via-views).

### P6 — ⌘K for destinations

Global search for projects/datasets/experiments — reduces sidebar leaf pressure (Eden already has ⌘K).

---

## Eden gap

| Pattern | Gap |
|---|---|
| In-detail tree search | Weak vs Phoenix quiet search |
| Filter DSL | Query mode exists; not Phoenix-syntax clone required |
| Chart strip | Alerts KPI strips stack as bands — make thin/optional |
| Card nest | Flatten Observe detail chrome (W2 P0) |

---

## Priority

| ID | P | Note |
|---|---|---|
| P1 Quiet tree search | P1 | Detail progressive disclosure |
| P2 One filter bar | P0 | Align with Langfuse/Laminar |
| P3 Sessions context tools | P1 | Keep off hub |
| P4 Resizable KPI strip | P0 | Anti-clutter for Alerts |
| P5 Columns menu | P0 | Hide-first |
| P6 ⌘K | P2 | Already present |

**Non-goal:** Clone Phoenix light UI or Python filter syntax literally.

*End of w2-phoenix-patterns (Wave 3).*
