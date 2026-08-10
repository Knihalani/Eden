# Wave 5 — Ingest Hot-Path Optimization Plan (2026-08-10)

Every item below was **measured first** (profiles + microbenchmarks on the real
code paths), then implemented, then re-benchmarked, then guarded by the test
suite. Nothing here is speculative. The ingest path is Eden's highest-leverage
surface: every SDK-flushed batch crosses `validate → enrich → dedup → sample →
row-build → sinks`, and the previous waves already claimed the big structural
wins (executemany batching, batch message-dedup, batch compression,
SELECT-column narrowing). This wave attacks the **per-event Python overhead
that was never measured**: per-call imports, redundant timestamp parses,
unnecessary dict copies, per-event task spawns, and sink connect storms.

## Baseline (measured before this wave)

| Metric | Baseline |
|---|---|
| Full single-event path (validate+enrich+dedup+row) | 15.37 µs/event |
| Row build alone (`_build_postgres_row`) | 7.96 µs/event (52% of path) |
| Full batch path (200/batch, all sinks idle) | 237.96 µs/event |
| `eden.api.app` cold boot | ~611 ms (contains 104 ms Ledger chain) |
| Sampling analysis in `full` profile (idle-sink batch) | ~0.7 s per 10k events |
| Redis-down connect storms | 1 connect attempt + warning **per event** |

---

## Wave 5.1 — Kill the per-event sampling analysis in the default profile

**Problem (measured):** With `sampling_profile=full` (the process default, 100%
keep), the batch path still ran the *entire* N16 analysis per event:
`should_route_event → decide_for_event → keep_signals_for_event` — attribute
scans, cost parsing, threshold lookups — ~0.7 s per 10k events (~21% of the
idle-sink batch profile), and the result was *always* keep.

**Fix:** `should_route_event` in `src/eden/observability/sampling/apply.py` now
takes a fast path when the org has no override **and** the process policy can
never drop (`not enabled`, `profile == "full"`, or `keep_rate >= 1.0`) — exactly
the condition of `SamplingPolicy.decide`'s first branch (verified against
`policy.py` L103-112), so the skip is behavior-identical.

**Safety verified:** `sampling_profile_override_sync` is a pure dict-cache lookup
(no per-event DB cost); `ensure_org_sampling_warmed` still runs first (the M14
per-org warm path is untouched); `keep_signals_for_event` has no side effects —
it only reads event attributes. Org overrides (`balanced`/`aggressive`) bypass
the fast path entirely.

**Result:** sampling work drops to ~0 in the default profile; orgs that opt into
`balanced` keep the full analysis.

---

## Wave 5.2 — Eliminate per-call imports and wasted dict copies in row build

**Problem (measured):** Row build (7.96 µs/event) was dominated by:

1. `_json_dumps` doing `from eden.util.jsonx import dumps` inside a try/except
   on **every call** — and `_build_postgres_row` calls `_dump_jsonb` ~7×/event.
2. `_normalize_token_metrics_dict` **copying every dict** it serialized
   (100k dict copies per 20k events — 5/event) even when no token key was
   present (payload/attributes/bodies almost never have them).
3. `_stamp_cost_usd` / `_emit_billing_events` re-importing
   `eden.llmops.pricing.estimate_cost_usd` per event, and `_stamp_cost_usd`
   building a fresh `_tok` closure per event.

**Fixes** (all in `src/eden/observability/telemetry_collector.py`):

- Hoisted the jsonx import to module level (`contextlib.suppress` guarded —
  still can't fail at import) so `_json_dumps` is a plain attribute lookup.
- `_normalize_token_metrics_dict` fast path: `if not (_TOKEN_METRIC_KEYS &
  metrics.keys()): return metrics` — no copy. Only copies when a token key
  actually exists. `_dump_jsonb` is the only caller and never mutates, so
  return-by-reference is safe (documented).
- `_get_estimate_cost_usd()` lazy module-level cache — one import per process
  instead of per event. `_tok_int` hoisted to module level — no closure per
  event.

**Result:** single-path 15.37 → ~14.0 µs/event (~1.1×); row build 7.96 → ~7.5
µs. (The remaining row-build cost is legitimately orjson serialization of
multi-column rows.)

---

## Wave 5.3 — Parse each event's timestamp once, not 3–4×.

**Problem (measured):** `datetime.fromisoformat` ran on the **same ISO string**
in `_validate`, `_compute_ingest_latency`, `_build_postgres_row`, and the
late-span policy — 3–4 parses per event on the hot path.

**Fix:** `_validate` now parses once and stashes the result on the event as
`_parsed_timestamp`; `_compute_ingest_latency`, `_build_postgres_row`, and
`evaluate_late_span` (in `late_span.py`) all reuse it with a `getattr` fallback
to re-parse when absent (events that bypass `_validate`). Declared as a
dataclass field with `compare=False, repr=False` so equality/repr semantics are
unchanged (reviewer-caught).

---

## Wave 5.4 — Stop the per-event Redis connect storm.

**Problem (measured):** With Redis down, `_get_redis` attempted a connection
(up to 10s ceiling) and logged a warning **per event** — serializing ingest
behind socket timeouts and flooding logs (0.392 s per 10k events in the
idle-sink profile).

**Fix:** failure is cached with a 30s cooldown (`REDIS_RETRY_COOLDOWN_S`); at
most one connect attempt per window. On recovery, Redis streams/SSE resume at
the next attempt (documented trade-off: up to 30s of SSE fanout lag after
recovery — fail-soft, deliberate).

---

## Wave 5.5 — Collapse per-event background-task spawns into per-batch.

**Problem (measured):** `ingest_batch` spawned **~7 `create_task` per event**
(checkpoint hook, plus the per-event context copies through `_spawn_bg`).

**Fix:** the F03 debugger checkpoint now spawns **one task per batch**
(`_persist_checkpoints_batch`) that loops the events — same fail-open
semantics, identical per-event DB work, but N task creations become 1.

---

## Wave 5.6 — Take the ~104 ms Ledger chain out of app boot.

**Problem (measured):** `eden.api.app` cold boot pulled
`gateway.py → ai_gateway → llmops.filters → book → eden.kb.ledger.retrieve`
eagerly — `eden.kb.ledger.retrieve` alone costs **104.3 ms** to import, and
`filters/__init__.py` imports `book.py` eagerly. (Flagged as item 3.7 in the
master plan; never executed before this wave.)

**Fix:** `src/eden/llmops/filters/book.py` defers `LedgerRetriever` and
`schedule_warm_learn` to first use inside `apply()` (behind the already-cheap
`ledger_enabled_sync` gate). Verified: after the change
`eden.kb.ledger.retrieve` is **absent** from the post-boot `sys.modules`.
App boot ~611 → ~550 ms warm samples.

---

## Wave 5.7 — Measured but **not** applied (deferred, with reasons)

| Item | Measurement | Why deferred |
|---|---|---|
| `MessageStore._hash_and_build_rows` double-serializes each message (once for the canonical hash, once for the stored `content` JSONB column) | 1.86 µs/msg | The content column is a read-back contract; canonical bytes differ from `default=str` for `datetime` (ISO vs `str()`) and `bytes` (hex vs `repr`) values. Stored-shape change on a dedup table with existing rows — risk not worth 1.86 µs/msg on an already-batched write. Revisit if `trace_messages` is ever rebuilt. |
| Defer CH row building to flush time (avoid ~10 `_dump_jsonb`/event) | larger win | CH buffer already batches inserts at 250/5s; deferring row build would require storing raw events in the buffer and re-serializing at flush — memory + complexity for a sink that is explicitly non-durable. Higher-risk than the durable store wins. |

---

## Verification (all green)

- `tests/unit/observability/` + `tests/unit/llmops/` + `test_wave3_wiring.py` +
  `tests/unit/closed_loop/`: **1288 passed, 1 skipped**
- `ruff check` on all four changed files: clean
- `mypy` on all four changed files: **5 pre-existing errors only** (verified by
  stash-diff — zero new errors from this wave)
- Benchmarks after: batch path ~200–205 µs/event (was 238), single path ~14.0
  µs/event (was 15.37), app boot ~550 ms (was ~611), Ledger module absent from
  boot graph.

## Files changed

- `src/eden/observability/sampling/apply.py` — full-profile fast path
- `src/eden/observability/telemetry_collector.py` — jsonx hoist, token-dict
  fast path, `_tok_int`/`_get_estimate_cost_usd` module-level, Redis cooldown,
  `_parsed_timestamp` stash, checkpoint batching
- `src/eden/observability/ingestion/late_span.py` — reuse stashed timestamp
- `src/eden/llmops/filters/book.py` — lazy Ledger imports
- `bench/ingest_cpu.py`, `bench/ingest_batch_path.py` — new benchmarks (added
  this session; they now cover the pure-Python cost and the full batch path)
