# Feature Implementation Specs

> **Master:** [`../FEATURE-GAP-MASTER.md`](../FEATURE-GAP-MASTER.md)  
> **⭐ Execution roadmap:** [`../EDEN-MASTER-ROADMAP.md`](../EDEN-MASTER-ROADMAP.md)  
> **UI specs:** [`../ui/README.md`](../ui/README.md)  
> **Competitor research:** [`../COMPETITOR-UI-RESEARCH.md`](../COMPETITOR-UI-RESEARCH.md)  
> **Autonomous model:** [`../AUTONOMOUS-MAINTENANCE.md`](../AUTONOMOUS-MAINTENANCE.md)  
> **Performance SLAs:** [`../PERFORMANCE-COST-STANDARDS.md`](../PERFORMANCE-COST-STANDARDS.md)  
> **Market thesis:** [`../MARKET-HYPOTHESES.md`](../MARKET-HYPOTHESES.md)

## Inventory

| Category | Count |
|---|---|
| F-features (parity + eval/portal + optim) | **61** (F01–F85 present; historical gaps deleted) |
| N-features (differentiation + platform + autonomous) | 21 |
| UI specs (portal interaction) | **21** (U00–U20) |
| **Total** | **103** |

## Mandatory in every feature spec

- Latency budgets (p50/p95)
- Cost model ($/1k ops or $0 deterministic)
- Caching & degradation modes
- Prometheus metrics
- Normal vs autonomous behavior where applicable (N22 tiers)

## P0 ship list

**Maintenance moat:** N14, N22, F48, F28, F29, F20, N08, N16, F04, N17, F30, F22, F39, F41, N15, N01, N20, D6, D7, D12, F46, N21

**Portal / eval parity (new):** F58, F49, F50, F51, F52, F53, F81 + UI U00, U01, U02, U03, U04, U05, U08, U12

**Portal programs:** U18 (overhaul), U19 (improvement), U20 (polish) — Waves 11–13

**Final optim/debug:** F82, F83, F84, F85 — Wave 14

## Eval / LLMOps parity (F49–F81)

| Band | IDs | Theme |
|---|---|---|
| P0 | F49–F53, F58, F81 | Playground, queues, experiments, online rules, datasets, views, NL alerts |
| P1 | F54–F57, F60–F61, F65–F66, F68, F71, F73–F76, F79 | Code evals, dashboards, topics, prompts/env, Slack, PII, debugger sessions, SQL export, span scores |
| P2 | F59, F62–F64, F67, F69–F70, F72, F77–F78, F80 | Templates, SLM judges, jury, sandboxes, copilot, data planes, finetune, multimodal, workshop |

## Portal UI (see `../ui/`)

| Band | IDs |
|---|---|
| P0 | U00, U01, U02, U03, U04, U05, U08, U12 |
| P1 | U06, U07, U09, U10, U13, U14, U17 |
| P2 | U11, U15, U16 |

## Build waves 8–12 (portal parity)

See FEATURE-GAP-MASTER §4 — Portal OS → Bento UI → Eval loop → Online/dashboards → Signals/Topics/Debugger.

## Generator

`generate_specs.py` — skeleton F-specs only; never overwrites hand-edited files.
