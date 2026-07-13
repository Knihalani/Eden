# F03: Checkpoint Ingestion from LLM Spans

| Field | Value |
|---|---|
| **Feature ID** | F03 |
| **Slug** | `checkpoint-ingestion-from-spans` |
| **Priority** | P0 |
| **Effort** | M |
| **Eden status** | **SHIPPED (v0)** — checkpoint ingest wired for F01 prefix replay |
| **Competitive source** | Laminar |
| **Closes gap** | 1.1 |
| **Dependencies** | F01 (prefix cache consumer) |

---

## 1. Summary

Auto-persist debugger checkpoints on every LLM span finalize and populate `debugger_llm_cache` for F01 cached-prefix replay. Without F03, debugger has nothing to rerun from production traces.

---

## 2. Eden current state

| Component | Path | Status |
|---|---|---|
| `CheckpointStore.save()` | `src/eden/debugger/checkpoints.py:154` | Exists, **never called from ingest** |
| `ReRunEngine` | `checkpoints.py:243` | Hermetic replay only |
| Ingest pipeline | `src/eden/observability/ingestion/framework.py` | No checkpoint hook |
| Prefix cache table | — | **Missing** (F01 migration) |

---

## 3. Target behavior

On each LLM span commit during ingest:
1. Extract `messages`, `tool_calls`, `response`, `model`, `step_number`
2. Compute `input_hash` (exclude system role — Laminar parity, shared with F01)
3. Upsert `debugger_llm_cache(org_id, trace_id, step, hash) → response`
4. Append `debugger.checkpoint` telemetry event (audit trail)
5. Non-blocking: enqueue if ingest thread budget exceeded

**Trigger spans:** `gen_ai.operation.name` in (`chat`, `completion`) or `span.kind=llm`.

---

## 4. Architecture

```
ingest.span.finalize(span)
    │
    ├─ if is_llm_span(span):
    │     CheckpointIngestHook.on_span(span)  [async task]
    │         → extract_llm_payload(span)
    │         → PrefixCacheService.upsert(...)
    │         → CheckpointStore.save(...)  [optional audit row]
    │
    └─ return (no await on hot path)
```

**Module:** `src/eden/observability/ingestion/checkpoint_hook.py`

```python
class CheckpointIngestHook:
    async def on_span(self, span: IngestSpan) -> None:
        if not self._is_llm(span):
            return
        payload = self._extract(span)
        input_hash = llm_input_hash(payload.messages)
        await self._cache.upsert(
            org_id=span.org_id,
            source_trace_id=span.trace_id,
            step_number=payload.step_number,
            input_hash=input_hash,
            response=payload.response,
            model=payload.model,
        )
```

---

## 5. Data model

Uses F01 tables:

```sql
-- From F01 migration 074
CREATE TABLE debugger_llm_cache (
    org_id UUID NOT NULL,
    source_trace_id UUID NOT NULL,
    step_number INT NOT NULL,
    input_hash TEXT NOT NULL,
    response JSONB NOT NULL,
    model TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (org_id, source_trace_id, step_number, input_hash)
);

CREATE INDEX idx_cache_trace ON debugger_llm_cache (org_id, source_trace_id, step_number);
```

Optional audit: `telemetry_events` with `event_type='debugger.checkpoint'`.

---

## 6. API specification

**Internal only** — no new public routes.

Existing debugger routes consume cache:
- `GET /orgs/{org_id}/debugger/checkpoints/{trace_id}`
- `POST /orgs/{org_id}/debugger/rerun` (F01)

---

## 7. Implementation plan

1. Share `llm_input_hash()` with F01 `cache.py` (single module)
2. Implement `CheckpointIngestHook` with span attribute decoder
3. Register hook in `ingestion/framework.py` post-span-finalize
4. Migration 074 if not shipped with F01
5. Backfill job (optional): `scripts/backfill_checkpoints.py` for last 7d traces
6. Metrics: `eden_checkpoint_ingest_total`, `eden_checkpoint_ingest_errors_total`

---

## 8. Step number assignment

If SDK does not emit explicit step:
- Monotonic counter per `(trace_id)` in Redis `INCR trace:{id}:llm_step`
- TTL 24h; finalized trace persists max step on trace metadata

---

## 9. Feature flags

| Flag | Default |
|---|---|
| `debugger_checkpoint_ingest_v1` | `true` new orgs |
| `debugger_checkpoint_backfill_v1` | `false` |

---

## 10. Performance & cost optimization

See [PERFORMANCE-COST-STANDARDS.md](../PERFORMANCE-COST-STANDARDS.md).

### Latency budgets

| Operation | p50 | p95 | p99 |
|---|---|---|---|
| Hot-path enqueue | <0.5ms | <2ms | <5ms |
| Async upsert (full) | <3ms | <10ms | <25ms |
| Backfill per trace | — | <100ms | <500ms |

### Cost model

- **Storage:** ~2–8KB per LLM step cached JSON
- **50-step trace:** ~100–400KB in `debugger_llm_cache`
- **Dedupe win:** Same hash at same step → upsert no-op (ON CONFLICT DO NOTHING)

### Caching & batching

- Batch upserts on trace.finalized if >10 LLM spans (single transaction)
- Skip cache for traces tagged `debugger_skip_cache=true` (compliance)

### Degradation

- DB write fail → log + metric; do not fail ingest
- Queue backlog >10k → sample cache every 2nd span (configurable)

### Monitoring

```
eden_checkpoint_ingest_duration_seconds
eden_checkpoint_ingest_skipped_total{reason}
eden_checkpoint_cache_bytes_total{org}
```

---

## 11. Test plan

| Test | Path |
|---|---|
| LLM span → cache row | `tests/integration/test_checkpoint_ingest.py` |
| Hash excludes system | `tests/unit/debugger/test_cache_hash.py` (shared) |
| Non-LLM span ignored | same |
| Ingest p99 overhead | benchmark with 100 spans |

---

## 12. Acceptance criteria

- [ ] 50 LLM spans → 50 cache rows within 5s of trace complete
- [ ] Hot-path sync overhead p99 ≤5ms
- [ ] F01 rerun finds cache populated for production trace
- [ ] Failed cache write does not fail trace ingest
- [ ] Backfill job processes 1k traces/hour without ingest impact

---

*Blocks F01 live debugger. See F01 §cache algorithm.*
