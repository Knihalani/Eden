# Wave 3 — Laminar table OS (no toolbar sprawl)

**Agent:** `w3-laminar-table`  
**Date:** 2026-07-20  
**Docs:** [Table views](https://laminar.sh/docs/platform/table-views) · [Search](https://laminar.sh/docs/platform/search) · PR [#1788](https://github.com/lmnr-ai/lmnr/pull/1788)  
**Baseline:** W1/W2 — `ViewsMenu` partial; Display menu missing; Traces hand-composes toolbar

---

## Core lesson

**Calm tables hide complexity in views — they don’t add chrome rows.**

Laminar Table views persist **filters + search + sort + column layout** per project, **scoped per table** (Traces ≠ Spans). Amber dirty → Save / Save as / Discard. Columns you don’t need are **hidden into the preset**, not left as always-on UI.

SQL Editor is the **escape hatch** when filters aren’t enough — opened from sidebar or detail, **not** a permanent third hub band.

---

## Patterns

| # | Pattern | Laminar | Eden gap | P |
|---|---|---|---|---|
| 1 | Scoped named views | Per resource dropdown | Enforce scope in `useSavedViews` | P0 |
| 2 | Dirty = full ViewState | Amber on drift | Wire columns+sort+filters | P0 |
| 3 | Hide columns via view | “Most expensive traces” example | Prefer hide over new band | P0 |
| 4 | ViewsToolbar in table surface | One cluster with search/filters | Don’t invent second filter row | P0 |
| 5 | InfiniteDataTableProvider | Shared store | Uneven hub adoption | P0 |
| 6 | Controlled advanced search | value/onChange + URL helper | Align QueryFilterBar | P1 |
| 7 | SQL when filters fail | Separate surface | Query leaf overflow link | P2 |

---

## Anti-sprawl rules (steal)

1. Column picker / Display = **menu**, not a third sticky band.  
2. One search surface per list (no SpanSearchBar + QueryFilterBar competing without merge).  
3. Export / bulk appear on selection or overflow — not always-on peers to Filters.  
4. Saved view switch must not require a second “presets” chrome strip.

---

## Declutter acceptance

- [ ] Hide-via-views prioritized over Display band  
- [ ] Dirty/save/discard semantics mapped to Eden `ViewsMenu`  
- [ ] SQL explicitly non-P0 chrome  

*End of w2-laminar-table-os (Wave 3).*
