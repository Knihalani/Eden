# Optimization ID audit (Wave 2 harness)

Canonical register: [`docs/specs/OPTIMIZATION-ID-CHECKLIST.md`](../docs/specs/OPTIMIZATION-ID-CHECKLIST.md)

## Purpose

Wave 2 fails the program if any **P0** or **P1** ID is still `OPEN`.
This document + `tests/unit/observability/test_opt_id_checklist.py` are the
machine-checkable harness owned by agent **A10**.

## Required series names (A5 emit / A10 register)

| Prometheus series | Type | Module |
|---|---|---|
| `eden_ingest_redis_commands` | counter | `eden.observability.ingest_hot_path_metrics` |
| `eden_ch_flush_batch_size` | summary | same (`_sum` / `_count`) |
| `eden_sse_publish_skipped` | counter | same |

## Commands

```bash
# Checklist completeness + A10 DONE rows
.venv/bin/python -m pytest tests/unit/observability/test_opt_id_checklist.py \
  tests/unit/observability/test_ingest_hot_path_metrics.py \
  tests/unit/observability/test_slow_query.py -q

# Bundle gate dry-run (requires prior portal build)
cd clients/portal && bun run check:bundle

# Redact / chunk / dual-emit microbenches (S18)
.venv/bin/python -m pytest tests/perf/test_redact_chunk_dual_emit_bench.py -q
```

## Manual Wave-2 audit

1. Open `OPTIMIZATION-ID-CHECKLIST.md`.
2. Grep for `| OPEN |` under **P0** and **P1** sections only.
3. If any remain → re-spawn owning agent (A1–A10 / W15-e).
4. P2 `OPEN` is allowed until Wave 1.5 exit.
