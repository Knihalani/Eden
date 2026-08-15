# Eden Portal UI Specs

> **Date:** July 14, 2026  
> **Companion to:** [`../FEATURE-GAP-MASTER.md`](../FEATURE-GAP-MASTER.md), [`../features/`](../features/)  
> **Research basis:** Laminar, Braintrust, Langfuse, Helicone, LangSmith, Phoenix, Weave, HoneyHive, Galileo, BentoLabs portals

> **UI specs define interaction/layout.** Feature logic lives in F/N specs.  
> **⭐ Execution sequencing:** [`../EDEN-MASTER-ROADMAP.md`](../EDEN-MASTER-ROADMAP.md)

These specs define **interaction, layout, and information architecture** for the logged-in portal. Feature logic lives in F/N specs; UI specs own wireframes-in-prose, keyboard maps, empty states, and clone targets.

## Inventory

| ID | Title | Clone target | Priority | Status |
|---|---|---|---|---|
| **U00** | [Portal Operating System](./00-portal-operating-system.md) | Laminar table OS + Helicone IA | P0 | SPEC |
| **U01** | [Traces Hub](./u01-traces-hub.md) | Laminar traces/spans/sessions | P0 | SPEC |
| **U02** | [Artifacts](./u02-artifacts.md) | Bento Artifacts lifecycle | P0 | SPEC |
| **U03** | [Playground](./u03-playground.md) | Braintrust / Arize / LangSmith | P0 | SPEC |
| **U04** | [Alerts Inbox](./u04-alerts-inbox.md) | Bento NL + Braintrust filters | P0 | SPEC |
| **U05** | [Book & Drift](./u05-book-and-drift.md) | Bento Book + drift pinpoint | P0 | SPEC |
| **U06** | [Annotation Queue](./u06-annotation-queue.md) | Weave / LangSmith / Laminar queues | P1 | SPEC |
| **U07** | [Experiments Compare](./u07-experiments-compare.md) | Braintrust grades / Laminar evals | P1 | SPEC |
| **U08** | [Saved Views & Filters](./u08-saved-views-and-filters.md) | Laminar table-views / Langfuse filter bar | P0 | SPEC |
| **U09** | [Home Dashboard](./u09-home-dashboard.md) | Langfuse Home / Helicone KPI | P1 | SPEC |
| **U10** | [Datasets Spreadsheet](./u10-datasets-spreadsheet.md) | Braintrust / LangSmith datasets | P1 | SPEC |
| **U11** | [Topics / Insights](./u11-topics-insights.md) | Braintrust Topics / Galileo Insights | P2 | SPEC |
| **U12** | [Portal IA Rewrite](./u12-portal-ia.md) | Helicone grouping + Eden moat | P0 | SPEC |
| **U13** | [Debugger Sessions](./u13-debugger-sessions.md) | Laminar debugger sessions | P1 | SPEC |
| **U14** | [Online Rules Builder](./u14-online-rules-builder.md) | LangSmith / Braintrust automations | P1 | SPEC |
| **U15** | [Render Templates](./u15-render-templates.md) | Laminar render templates | P2 | SPEC |
| **U16** | [In-UI Copilot](./u16-in-ui-copilot.md) | Braintrust Loop / Laminar Agent | P2 | SPEC |
| **U17** | [Prompt Environments](./u17-prompt-environments.md) | Helicone / Humanloop / Braintrust envs | P1 | SPEC |
| **U18** | [Portal Overhaul](./u18-portal-overhaul.md) | Laminar/Braintrust app shell | P0 | SPEC — Wave 11 |
| **U19** | [Portal Improvement](./u19-portal-improvement.md) | Competitor density pass | P0 | SPEC — Wave 12 |
| **U20** | [Portal Polish](./u20-portal-polish.md) | A11y / motion / consistency | P1 | SPEC — Wave 13 |

## How to use

1. Implement **U00 + U08 + U12** first (shared chrome) in feature Wave 3.
2. Ship **U01** before any other Observe polish.
3. Pair each UI spec with its F/N backend: e.g. U02↔F39/F41, U03↔F49, U04↔F81.
4. Run **U18 → U19 → U20** as Waves 11–13 (portal-only programs).
5. Wave 14 (F82–F85) optimizes and hardens after polish.

## Design non-negotiables

- Clone **interaction patterns**, not competitor visual skins (keep Eden tokens in `globals.css`).
- Core nav ≤ 12 items; Advanced hides the rest ([U12](./u12-portal-ia.md)).
- URL state is shareable (`?traceId=&filter=&view=`).
- No full-page hop for primary detail when a split pane works.
- Empty states teach the closed loop (Gap 4.8).
