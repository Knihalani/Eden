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

F48, F28, F29, F20, F30, F04, F47, F03, F01, F22, F39, F41, F46, **N01, N02, N07, N08, N09**

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
