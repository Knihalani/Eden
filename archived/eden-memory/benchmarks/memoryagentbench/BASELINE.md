# AgentMemory inject baseline (M1.4)

Dated snapshot of the **product** path: `openMemory` + `inject` (not `BrainMemory`, not LoCoMo retrieve@5).

**Date:** 2026-09-16  
**Machine:** Darwin 27.0.0 arm64 / bun 1.3.13  
**Script:** `bun benchmarks/memoryagentbench/baseline-measure.ts` (one-shot; not CI)  
**N:** 80 injects on one `AgentMemory({ dir: tmp })`  
**Fixture:** 4 durable turns + 1 query (`Kai's timezone is Pacific.` / staging `api.internal` / `Postgres is the session store.` / `deploy region is us-east-1.` / `What timezone is Kai in?`). `EDEN_KNOW=0` so Know is not on the clock.

| metric | value |
|---|---|
| inject p50 (ms) | 0.088 |
| inject p95 (ms) | 0.233 |
| persist bytes | 765 |
| JSONL n | 4 |
| swallows (happy path) | 0 |
| swallows (forced throw) | 1 |
| min / max (ms) | 0.059 / 5.790 |

First inject includes extract + JSONL write (max 5.790 ms). Later injects are retrieve + inject on the same instance; p50 is sub-millisecond. Recorded as measured — not rounded to a WIN.

**Fail-open stays:** `inject` catch → pass-through (`return list`). Happy-path swallows = 0. Forced `notesFor` throw: original messages unchanged, swallow counter = 1. Optional log: `EDEN_MEMORY_SWALLOW=1`.

M11 compares against this file. No k-hack. This is not a LoCoMo retrieve@5 loop.

**This is not a SOTA claim.** Latency on a 5-message fixture is not Table 3, not MCC, not retrieve@k.

## M6.4 remeasure (after M2–M5)

Dated remeasure of the **same product path**: `openMemory` + `inject` (not `BrainMemory`, not LoCoMo retrieve@5). Same fixture and N as M1.4. Retrieve **k** is the product default — `EDEN_MEMORY_CAP` unset (falls through to 6). No k-hack, no hay, no ranker retune.

**Date:** 2026-09-17  
**Machine:** Darwin 27.0.0 arm64 / bun 1.3.13  
**Script:** `bun benchmarks/memoryagentbench/baseline-measure.ts`  
**N:** 80 (same fixture as M1.4)  
**k:** default (`EDEN_MEMORY_CAP` unset)

| metric | M1.4 | M6.4 | delta |
|---|---|---|---|
| inject p50 (ms) | 0.088 | 0.048 | -0.040 |
| inject p95 (ms) | 0.233 | 0.133 | -0.100 |
| persist bytes | 765 | 1009 | +244 |
| JSONL n | 4 | 5 | +1 |
| swallows (happy path) | 0 | 0 | 0 |
| swallows (forced throw) | 1 | 1 | 0 |
| min / max (ms) | 0.059 / 5.790 | 0.030 / 5.575 | -0.029 / -0.215 |

**Latency (p50/p95): better** than M1.4. Steady-state inject is still sub-millisecond. First-inject max includes extract + lock + atomic JSONL write (M5.1 `withFileLock` / `writeFileAtomic`); on this run max was 5.575 ms vs M1.4 5.790 ms — not slower.

**Persist bytes: larger**, not a WIN. JSONL n 4 → 5 because M2 `extractDurable` now stores the query turn (`What timezone is Kai in?`) in addition to the four durable facts. Rows also serialize `ep` / `ctx` (M5 session identity). Size growth is encode + fields, not a retrieve-k change.

**Fail-open stays:** happy-path swallows = 0. Forced `notesFor` throw: swallows = 1. Same as M1.4.

Recorded as measured — not rounded to a WIN. **This is not a SOTA claim.** Not Table 3. M11 compares against this file.

## M34 remeasure (after WAL / retrieve loop / packet budget)

Dated remeasure of the same product path: `openMemory` + `inject`. Same fixture and N as M1.4 / M6.4. Retrieve **k** is the product default — `EDEN_MEMORY_CAP` unset (falls through to `PACKET_CHAT_K_DEFAULT` 6). No k-hack, no BrainMemory, no retrieve@5. Ranker and extract were not retuned.

**Date:** 2026-09-22  
**Machine:** Darwin 27.0.0 arm64 / bun 1.3.13  
**Script:** `bun benchmarks/memoryagentbench/baseline-measure.ts`  
**N:** 80 (same fixture as M1.4 / M6.4)  
**k:** default (`EDEN_MEMORY_CAP` unset → 6)

| metric | M6.4 | M34 | delta |
|---|---|---|---|
| inject p50 (ms) | 0.048 | 0.590 | +0.542 |
| inject p95 (ms) | 0.133 | 1.016 | +0.883 |
| persist bytes | 1009 | 1079 | +70 |
| JSONL n | 5 | 5 | 0 |
| swallows (happy path) | 0 | 0 | 0 |
| swallows (forced throw) | 1 | 1 | 0 |
| min / max (ms) | 0.030 / 5.575 | 0.498 / 12.826 | +0.468 / +7.251 |

**Latency (p50/p95): slower** than M6.4, **documented**. This 5-row fixture never hits WAL (first persist compact because the snapshot is missing; later injects are dup observes). Steady-state min 0.498 ms is already above M6.4 p95 0.133 ms, so the gap is the **inject retrieve path added in M7–M33** (`routeMemory`, `assembleNotes`, `completeNotes`, experience/howto/narrative merge, labeled `formatNote`) — not M34 WAL compact, not a 60ms CLI in front of wrap. M34.2 score loop stays ranking-identical (skip zero-hit bags; binary IDF leftover). Packet budget is named (k 6–10, procedure ~300 tok, slice 300). Holdout Gate 1 still WIN 8/0/0.

**Persist bytes: JSONL-only, 1079.** No `.wal` before or after `close()` on this fixture. `MEMORY_WAL_SUFFIX` is `.wal` and `MEMORY_WAL_COMPACT_LINES` is 32. **JSONL n = 5**, query turn stored (same n as M6.4). +70 bytes is JSONL body.

**Packet budget (M34.3, `src/index.ts`):** `PACKET_CHAT_K_MIN` 6, `PACKET_CHAT_K_MAX` 10, `PACKET_CHAT_K_DEFAULT` 6. `PROCEDURE_TOKEN_CAP` 300. Slice budget `EXPERIENCE_SLICE_TOKEN_CAP` 300 (re-export of `src/experience-retrieve.ts`). Harbor M32 prompt Δ +27759 is agent traces; packet upper bound ≈ 6300 tok.

**Fail-open stays:** happy-path swallows = 0. Forced `notesFor` throw: original messages unchanged, swallows = 1.

Recorded as measured. **This is not a SOTA claim.** Not Table 3. No retrieve@5.

## M49.2 2k-store inject (wrap still streams)

Dated measure of the same product path: `openMemory` + `inject`. This is a **2000-row** store (`EDEN_MEMORY_STORE_CAP` unset, default 2000). It is not the M34 5-row fixture. Retrieve **k** is the product default — `EDEN_MEMORY_CAP` unset (falls through to 6). `EDEN_KNOW=0`. No BrainMemory, no retrieve@5, no k=40. Ranker was not retuned.

**Date:** 2026-09-25  
**Machine:** Darwin 27.0.0 arm64 / bun 1.3.13  
**Script:** `bun benchmarks/memoryagentbench/baseline-measure.ts`  
**N:** 80 injects after the store exists (seed wall 1508.397 ms is not in p50/p95)  
**Store:** 2000 distinct `Operator opNNNN lives in city cNNNN.` rows via `openMemory.observe`, then reopen and inject. Seeded JSONL n = 2000 (1037914 B). After the timed injects JSONL n stayed 2000.  
**Cue:** `Where does operator op0042 live?`  
**k:** default (`EDEN_MEMORY_CAP` unset → 6)

| metric | M34 (5-row) | M49.2 (2k-store) | delta |
|---|---|---|---|
| inject p50 (ms) | 0.590 | 24.542 | +23.952 |
| inject p95 (ms) | 1.016 | 28.403 | +27.387 |
| JSONL n (seeded) | 5 | 2000 | +1995 |
| JSONL n (after timed injects) | 5 | 2000 | +1995 |
| swallows (timed injects) | 0 | 0 | 0 |
| min / max (ms) | 0.498 / 12.826 | 23.301 / 33.717 | +22.803 / +20.891 |

**Latency (p50/p95): slower** than the dated M34 5-row snapshot, **documented**. Steady-state min 23.301 ms is already above M34 p95 1.016 ms. The gap is scoring a 2000-row store on the in-process inject path, not a CLI subprocess. p95 28.403 ms is under a 60 ms CLI round-trip, and wrap does not put one in front of the model.

**Wrap still streams.** `packages/wrap/src/proxy.ts` calls `injectBodyThenObserveTools(processMemory(), body)` in-process, then `tapSseUsage` and SSE passthrough. `stream: true` returns `text/event-stream`. `proxy.ts`, `know-inject.ts`, and `tool-observe.ts` do not `spawn` / `execFile` / `Bun.spawn` an `eden` CLI on the inject path. Proof: `bun test packages/wrap/src/memory-stream.test.ts` — 2 pass, 0 fail, 33 expect() calls.

**Fail-open stays:** timed 2k inject swallows = 0. The same script's 5-row forced `notesFor` throw still swallows = 1 and returns the original list.

The M1.4 / M6.4 / M34 tables above are unchanged. This script still reprints the 5-row fixture; that reprint is not written back into those tables.

Recorded as measured. **This is not a SOTA claim.** Not Table 3. No retrieve@5.
