# F06: Per-Trace Signal Investigation Agent

| Field | Value |
|---|---|
| **Feature ID** | F06 |
| **Slug** | `per-trace-signal-investigator` |
| **Priority** | P0 |
| **Effort** | XL |
| **Eden status** | **MISSING** |
| **Competitive source** | Laminar,Bento |
| **Closes gap** | 1.3,5.4 |

---

## 1. Summary

NL signal + JSON schema → agent investigates each trace → structured events.

## 2. Eden current state

Phase Q regex metrics only (`services/cat2_intel/signals.py`).

## 3. Target behavior

Compressor → ReAct agent with span tools → signal_events.

## 4. Architecture

Worker on `trace.finalized` Redis stream.

## 5. Data model

signal_definitions, signal_events, signal_clusters tables (see competitor spec 075)

## 6. API specification

CRUD + backfill routes

## 7. Implementation plan

`src/eden/signals/{compressor,investigator,worker,clusterer}.py`

## 8. SDK / CLI / Portal

Portal Signals v2 tab

## 9. Feature flags & rollout

`per_trace_signals_v1`

## 10. Test plan

Fixture loop trace fires event

## 11. Acceptance criteria

- [ ] Backfill 1k traces <30min

## 12. Dependencies

F07,F08

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
