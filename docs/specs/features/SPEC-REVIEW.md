# Feature Spec Cross-Review

> **Updated:** July 9, 2026 — second pass (37 specs, all with perf/cost)

## Verdict

Spec set is **complete for high-value parity + differentiation**. Every feature includes latency budgets, cost controls, caching, and degradation modes per [PERFORMANCE-COST-STANDARDS.md](../PERFORMANCE-COST-STANDARDS.md).

## Inventory

| Type | Count |
|---|---|
| F-features | 24 |
| N-features | 13 (N09–N13 restore deleted high-value work) |

## Critical path

**F48 → F28 → F29 → F20 → F30 → F04 → F03 → F01 → F22 → F46**

**Cost foundation:** **N09** early (storage) + **N08** (free P0 detection)

**Differentiation:** **N07, N08, N06**

## Restored features (N09–N13)

| ID | Value |
|---|---|
| N09 | 5–20× storage savings (was F11) |
| N10 | Raindrop search→signal (was F36) |
| N11 | Live tail without Workshop (was F10) |
| N12 | Session UX (was F17) |
| N13 | Transcript demo quality (was F38) |

## Performance highlights by feature

| Feature | Key SLA |
|---|---|
| F01 | Prefix replay p95 <2s |
| F03 | Ingest overhead p99 ≤5ms |
| F04 | MCP read p95 <800ms |
| F20 | Detect→stumble <60s, $0 for 5/7 detectors |
| F29 | Issue list p95 <300ms |
| F30 | StatGate triage <200ms; LLM <60s |
| F39 | Gateway overhead p95 <5ms |
| N08 | P0 without LLM <100ms |
| N09 | Dedupe ratio ≥3× |
| F12 | Search p95 <200ms |

## Risk summary

| Risk | Mitigation |
|---|---|
| LLM COGS | SLM cascade, budgets, F34 classifiers |
| Storage cost | N09 dedupe + 90d TTL |
| MCP abuse | Scoped keys, rate limits |
| Live stream scale | 100 sessions/org cap (N11) |

## Sign-off

Ready for Wave 0 (F48) implementation.
