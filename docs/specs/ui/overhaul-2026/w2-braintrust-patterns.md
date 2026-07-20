# Wave 3 — Braintrust patterns (Display · Filter · Views = one grammar)

**Agent:** `w3-braintrust`  
**Date:** 2026-07-20  
**Docs:** [View logs](https://www.braintrust.dev/docs/observe/view-logs) · [Filter and search](https://www.braintrust.dev/docs/observe/filter) · [Interpret results](https://www.braintrust.dev/docs/evaluate/interpret-results)  
**Baseline:** Eden ViewsMenu partial; no hub Display menu; Traces 3 bands

---

## One grammar (the steal)

Braintrust Logs chrome reads as **one** coherent control set:

| Control | Job | Disclosure |
|---|---|---|
| **Filter** | Basic chips or SQL; Suggestions/Recent; chips editable inline | Menu / bar — not a second product |
| **Display** | Columns · layout (list/grid/summary) · row type (traces vs spans) | **Menu** — hides options until needed |
| **Views** | Save filters+display+columns; personal / project / org defaults | Dropdown |
| **Live tail** | Time range + Live in toolbar | One control |
| **Loop** | NL assist for filters/SQL | Agent — **do not** clone as Eden chrome requirement |

This is the clearest peer expression of **progressive disclosure**: power lives under Display/Filter/Views, not three stacked page bands.

---

## Patterns → Eden

| ID | Pattern | Eden mapping | P |
|---|---|---|---|
| B1 | Display/Filter/Views one toolbar grammar | `QueryFilterBar` + `ViewsMenu` + future `DisplayMenu` in **one** band | P0 |
| B2 | Row type traces vs spans via Display | Eden uses Tabs — OK if tabs share toolbar band | P0 |
| B3 | Defaults hierarchy personal→project→org | `useSavedViews` | P1 |
| B4 | Suggestions + Recent | QueryFilterBar | P1 |
| B5 | Create alert / playground from filters | Closed-loop moat | P1 |
| B6 | Experiment layouts via Display | Evals compare chrome discipline | P1 |
| B7 | Loop custom React views | **P2 / non-goal** for chrome | P2 |

---

## Declutter lesson

Braintrust does **not** put Layout / Columns / Row type as always-visible peer buttons fighting Filters. **Display** is the hide hatch.

Eden anti-pattern to kill: CrossLinkBar + Tabs + FilterBar + KPI strip as four simultaneous bands (Alerts/Agents).

---

## Non-goals

- Clone Loop product into portal chrome  
- Clone Braintrust light skin  
- Explode Eden core nav to match Braintrust leaf sprawl  

*End of w2-braintrust-patterns (Wave 3).*
