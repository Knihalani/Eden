# F03: Checkpoint Ingestion from LLM Spans

| Field | Value |
|---|---|
| **Feature ID** | F03 |
| **Slug** | `checkpoint-ingestion-from-spans` |
| **Priority** | P0 |
| **Effort** | M |
| **Eden status** | **MISSING** |
| **Competitive source** | Laminar |
| **Closes gap** | 1.1 |

---

## 1. Summary

Auto-persist debugger checkpoints on every LLM span finalize + populate prefix cache.

## 2. Eden current state

`CheckpointStore.save()` exists (`checkpoints.py:154`) but **never called from ingest pipeline**.

## 3. Target behavior

On each LLM span commit: extract messages, tool_calls, response → save checkpoint + upsert `debugger_llm_cache`.

## 4. Architecture

Hook in `src/eden/observability/ingestion/framework.py` post-span-finalize callback.

## 5. Data model

Uses existing `telemetry_events` event_type=`debugger.checkpoint`.

## 6. API specification

Internal only (no public route).

## 7. Implementation plan

`src/eden/observability/ingestion/checkpoint_hook.py`

## 8. SDK / CLI / Portal

None

## 9. Feature flags & rollout

`debugger_checkpoint_ingest_v1` default true

## 10. Test plan

Integration: ingest synthetic trace → list checkpoints returns N rows

## 11. Acceptance criteria

- [ ] 50 LLM spans → 50 checkpoints within 5s of trace complete

## 12. Dependencies

F01

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
