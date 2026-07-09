# Feature Implementation Specs

> **Master:** [`../FEATURE-GAP-MASTER.md`](../FEATURE-GAP-MASTER.md)  
> **Performance SLAs:** [`../PERFORMANCE-COST-STANDARDS.md`](../PERFORMANCE-COST-STANDARDS.md)  
> **Market thesis:** [`../MARKET-HYPOTHESES.md`](../MARKET-HYPOTHESES.md)

## Inventory

| Category | Count |
|---|---|
| F-features (parity) | 24 |
| N-features (differentiation + restored) | 13 |
| **Total** | **37** |

## Mandatory in every spec

- Latency budgets (p50/p95)
- Cost model ($/1k ops or $0 deterministic)
- Caching & degradation modes
- Prometheus metrics

## P0 ship list

**N14** (blocker), F48, F28, F29, F20, N08, N16, F04, N17, F30, F22, F39, F41, N15, N01, N07

## New: production maintenance stand-outs (N14–N19)

| ID | Why it matters |
|---|---|
| N14 | Activates ETEC/StatGate/worker — **unblocks moats** |
| N15 | Evals become live gateway guardrails (shipped EvalToGuardrailLink) |
| N16 | 80% cost cut, keep all failures |
| N17 | Single improvement queue for operators |
| N18 | Auto prompt evolution + canary (shipped evolver) |
| N19 | KB compounding with safe two-speed promotion |

See [`../PRODUCTION-MAINTENANCE-STANDOUT.md`](../PRODUCTION-MAINTENANCE-STANDOUT.md).

## Restored high-value (N09–N13)

| ID | Was | Why |
|---|---|---|
| N09 | F11 | Storage cost at scale |
| N10 | F36 | Search → signal conversion |
| N11 | F10 | Live trace tail |
| N12 | F17 | Session timeline |
| N13 | F38 | Transcript polish |

## Deepened specs (second pass)

All 37 feature specs expanded with implementation detail + performance/cost sections.

Hand-edited priority: F01, F03, F04, F06, F09, F20, F28–F30, F22, F41, F46, F47, F48, N01–N13.

## Generator

`generate_specs.py` — skeleton F-specs only; never overwrites hand-edited files.
