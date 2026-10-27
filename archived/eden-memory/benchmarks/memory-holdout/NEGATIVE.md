# M35.1 No-lift NEGATIVE

**Date:** 2026-09-22
**Pre-registered:** 2026-09-22 (`negative-fixture.json`, ROADMAP §4.9). Expects were not edited after this run.
**Bun:** 1.3.13
**Part:** M35.1
**API under test:** inject path (`openMemory` / `inject`). `injectBody` is the same `openMemory` path, checked in the table and not a second product.
**hook-inject:** named, not scored. Gate 1 hook-inject is `RESULTS.md`. Dual-API forbidden.
**k:** default (EDEN_MEMORY_CAP unset → 6)
**Materiality:** ±1% (band = materiality × max(baseline bytes, 1)). Baseline 0 ⇒ band 0.01 byte ⇒ only Δ = 0 is Δ≈0.
**Off:** `EDEN_MEMORY=0` (inject identity). **On:** `EDEN_MEMORY` unset (product default).
**Know:** `EDEN_KNOW=0` so the Know catalog is not this memory packet.

No BrainMemory column. Inject path only. k default. No hay. No k=40. LoCoMo 92 is not an Eden claim. Ranker not tuned. Dual-API forbidden. Fail-open stays. Silent inject stays. No `memory_search`. Remain-silent omit is M38 (not implemented). Live wrap+hook HELP.md is M47 (not created).

## Key numbers

- **empty-math (Done-when cell):** 0 B → 0 B, Δ 0 B, Δ≈0
- **aa-off (noise floor):** 0 B → 0 B, Δ 0 B, Δ≈0
- **seeded-math:** 0 B → 0 B, Δ 0 B, Δ≈0
- **seeded-openssl:** 0 B → 0 B, Δ 0 B, Δ≈0
- **empty-coding:** 0 B → 0 B, Δ 0 B, Δ≈0

## On vs off Δ table

Scored bytes are the UTF-8 length of system content containing `Eden Memory:`. Δ = probe − baseline. `injectBody B` is the same path on a fresh copy of the store.

| case | expect | baseline | probe | store_n | baseline B | probe B | Δ B | band B | Δ≈0 | leftover | identity base/probe | injectBody baseline B | injectBody probe B | verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| empty-math | DELTA_ZERO | off | on | 0 | 0 | 0 | 0 | 0.01 | yes | — | yes/yes | 0 | 0 | Δ≈0 |
| aa-off | DELTA_ZERO | off | off | 0 | 0 | 0 | 0 | 0.01 | yes | — | yes/yes | 0 | 0 | Δ≈0 |
| seeded-math | MEASURE | off | on | 2 | 0 | 0 | 0 | 0.01 | yes | — | yes/yes | 0 | 0 | Δ≈0 |
| seeded-openssl | MEASURE | off | on | 2 | 0 | 0 | 0 | 0.01 | yes | — | yes/yes | 0 | 0 | Δ≈0 |
| empty-coding | DELTA_ZERO | off | on | 0 | 0 | 0 | 0 | 0.01 | yes | — | yes/yes | 0 | 0 | Δ≈0 |

## A/A noise floor

Packet bytes are arithmetic (ROADMAP §4.9 determinism). The A/A cell is two `EDEN_MEMORY=0` injects of `what's 2+2?` on empty stores. Wall-clock is one sample pair and is not the verdict.

- inject wall ms: 0.002 then 0.001 (Δ -0.001 ms)
- packet Δ: 0 B

## Seed liveness (not a scored row)

The seeded store is the same two facts. A related cue must inject sqlite, or the unrelated 0-byte rows would be a dead store and are filed FAIL instead of Δ≈0. This cue is not a Gate 1 score and not a product column.

- cue: `What sqlite database do we use?`
- packet: 33 B
- sqlite in packet: yes
- text: Eden Memory: - [fact] Use sqlite.

## By construction

Memorable **454/454** and Mem0 **92** fail by construction. They are not Eden product scores. COMPETITORS V-zero. This is not a published BrainMemory column.

| claim | why it fails by construction |
|---|---|
| Memorable 454/454 | Marketing 100% completion on a 3-bug fixture (`docs/MEMORY-COMPETITORS.md`). Saturated fixture plus a skill-dump denominator. Not a negative control. Cannot be an Eden product score. |
| Mem0 92 | Vendor LoCoMo dirt (`docs/MEMORY-COMPETITORS.md`: Mem0 vendor LoCoMo 92). Gold is dirty, the set is saturated, and this annex did not run LoCoMo. Cannot be an Eden product score. |
| MemoryBench ELO | `benchmarks/memoryagentbench/SOTA-GAP-REPORT.md` §11.2: often **No Memory ≈ Embedder**. Humility: memory can be zero lift. |

## Protocol

- Inject path only: `openMemory` / `inject` / `injectBody`.
- hook-inject (`memoryHookResponse` / `respondToHook`) is the Gate 1 host. It is named here and not re-scored.
- k default (`EDEN_MEMORY_CAP` unset → 6). No k=40.
- Store is empty or two remembered facts (`Use sqlite.` / `Auth is Clerk.`). No hay. No LoCoMo.
- Off switch is `EDEN_MEMORY=0`. On is the unset product default.
- `EDEN_KNOW=0` during seed and probe.
- Seeded rows with `store_n` below the seed length are FAIL, not Δ≈0.
- MEASURE rows that inject leftover sqlite/Clerk, or any Eden Memory packet outside the ±1% band, are LOSS vs remain-silent. Omit is not implemented.
- Ranker and extract were not retuned.

## M32 remain-silent (cited, not re-run)

`benchmarks/terminal-bench/RESULTS.md` on-arm empty/junk/on_cue/no_inject = 0/0/5/5 (dated 2026-09-21). This annex does not implement omit and does not re-run Harbor.

## Product bugs

- None on this run. injectBody packet bytes and identity matched inject on every arm.

## How to re-run

```bash
bun benchmarks/memory-holdout/run-negative.ts
```

Writes this file. Does not edit `negative-fixture.json`. Does not retune `src/index.ts`.
