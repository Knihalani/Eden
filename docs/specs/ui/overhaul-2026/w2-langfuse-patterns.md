# Wave 3 — Langfuse patterns (dual filter · no triple bands)

**Agent:** `w3-langfuse`  
**Date:** 2026-07-20  
**Docs:** [Filter Search Bar](https://langfuse.com/docs/observability/features/filter-search-bar) · [Changelog 2026-06-19](https://langfuse.com/changelog/2026-06-19-filter-search-bar) · [Full-text search](https://langfuse.com/docs/observability/features/full-text-search)  
**Baseline:** Eden QueryFilterBar as band 3 under Tabs; facets in More

---

## Steal (declutter-safe)

### L1 — Dual editor, one filter state

Langfuse Filter Search Bar and filter sidebar are **two editors over the same state**. Typing updates sidebar chips; chips update the query string. URL serializes the full query; Saved Views keep working.

**Eden steal:** Keep `QueryFilterBar` basic|query dual mode with lossless round-trip — **inside the single toolbar band**.  
**Do not steal:** A permanent left filter rail that becomes Eden’s **fourth** chrome band. Layout can stay toolbar-first.

### L2 — Time range beside filters, not a page band

Time + refresh sit next to the bar / in header slot — not a separate identity row.

### L3 — Autocomplete + project-aware schema

Bar suggests fields/values from loaded columns/metadata. Reduces “filter soup” by making power filters scannable in one line.

### L4 — AI refine as button, not band

Optional “build/refine query” control next to the bar — always available, never a third toolbar.

### L5 — Saved Views compatibility

Compiling to the same filter AST means views don’t fork into a second chrome system.

---

## Eden gap

| Item | Live |
|---|---|
| Dual mode present | Yes (`QueryFilterBar`) |
| Lives under Tabs as **band 3** | Yes — FAIL ≤2 |
| Facet runway | Collapsed to More — keep |
| URL share completeness | Partial |
| Evals hub filter OS | Missing |

---

## Anti-patterns

| Don’t | Why |
|---|---|
| Clone sidebar pixel layout | Adds bands on Eden shell |
| Dual **state** systems | Reconciliation loops / confusion |
| Put Fast/v4 toggles in hub identity | Peer product chrome ≠ Eden |

---

## Priority

| ID | Pattern | P |
|---|---|---|
| L1 | Dual editor one state | P0 |
| L2 | Time beside filters | P0 |
| L3 | Autocomplete | P1 |
| L4 | AI refine button | P2 |
| L5 | Views compatibility | P0 |

*End of w2-langfuse-patterns (Wave 3).*
