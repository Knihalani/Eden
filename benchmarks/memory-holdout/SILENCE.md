# M38.3 Remain-silent SILENCE

**Date:** 2026-09-25
**Pre-registered:** 2026-09-24 (`silence-fixture.json`, ROADMAP §4.9). Expects were not edited after this run.
**Bun:** 1.3.13
**Part:** M38.3
**API under test:** inject path (`openMemory` / `inject`). `injectBody` is the same `openMemory` path, checked beside inject and not a second product.
**hook-inject:** named, not scored. Dual-API forbidden.
**k:** default (EDEN_MEMORY_CAP unset → 6)
**Backbone:** N/A (no LLM reader)
**Materiality:** ±1% (band = materiality × max(baseline bytes, 1)). Baseline 0 ⇒ band 0.01 byte ⇒ only Δ = 0 is Δ≈0. Registered once.
**Off:** `EDEN_MEMORY=0` (inject identity). **On:** `EDEN_MEMORY` unset (product default).
**Know:** `EDEN_KNOW=0` so the Know catalog is not this memory packet.

No BrainMemory column. Inject path only. k default. No hay. No k=40. LoCoMo 92 is not an Eden claim. Ranker not tuned. Dual-API forbidden. Math cues are measurement reuse of M35.1, not a new training target. Rotation cell is `What is 17 times 23?`.

Remain-silent is compatible with fail-open; Start briefing is M38.2/M7.3 not this annex.

## Key numbers

- **empty-math:** WIN · omitted on-arm yes · 0 B off → 0 B on · Δ 0 B · leftover none
- **seeded-math:** WIN · omitted on-arm yes · 0 B off → 0 B on · Δ 0 B · leftover none
- **aa-off (noise floor):** WIN · omitted on-arm n/a · 0 / 0 B off → — B on · Δ 0 B · leftover none
- **seeded-times (rotation):** WIN · omitted on-arm yes · 0 B off → 0 B on · Δ 0 B · leftover none
- **WIN:** empty-math, seeded-math, aa-off, seeded-times
- **LOSS:** none
- **FAIL:** none

## Silence table

Scored bytes are the UTF-8 length of system content containing `Eden Memory:`. Δ = probe − baseline. Omitted on-arm is yes only when the on arm has no `Eden Memory:` packet (inject identity, 0 bytes). A/A has no on-arm, so that cell is n/a; both off packets must still be omitted for WIN. Packet bytes are arithmetic.

| case | omitted on-arm | packet B off | packet B on | Δ B | leftover | verdict |
|---|---|---|---|---|---|---|
| empty-math | yes | 0 | 0 | 0 | — | WIN |
| seeded-math | yes | 0 | 0 | 0 | — | WIN |
| aa-off | n/a | 0 / 0 | — | 0 | — | WIN |
| seeded-times | yes | 0 | 0 | 0 | — | WIN |

## injectBody (same path)

`injectBody` must agree with `inject` on identity, omit, packet bytes, and leftover. It is not a second product column.

| case | agrees | injectBody baseline B | injectBody probe B | injectBody Δ B | leftover | omitted |
|---|---|---|---|---|---|---|
| empty-math | yes | 0 | 0 | 0 | — | yes |
| seeded-math | yes | 0 | 0 | 0 | — | yes |
| aa-off | yes | 0 | 0 | 0 | — | yes |
| seeded-times | yes | 0 | 0 | 0 | — | yes |

## A/A noise floor

Packet bytes are arithmetic (ROADMAP §4.9 determinism). The A/A cell is two `EDEN_MEMORY=0` injects of `what's 2+2?` on empty stores. Wall-clock is one sample pair and is not the verdict.

- inject wall ms: 0.011 then 0.009 (Δ -0.001 ms)
- packet Δ: 0 B
- both omitted: yes

## Seed liveness (not a scored row)

The seeded store is the same two facts (`Use sqlite.` / `Auth is Clerk.`). A related cue must inject sqlite, or the silent rows are FAIL (dead store). This cue is not a scored Δ row and not a product column.

- cue: `What sqlite database do we use?`
- packet: 47 B
- sqlite in packet: yes
- text: Eden Memory: - [fact · 0m · user] Use sqlite.

## Protocol

- Inject path only: `openMemory` / `inject` / `injectBody`.
- hook-inject (`memoryHookResponse` / `respondToHook`) is named here and not scored.
- k default (`EDEN_MEMORY_CAP` unset → 6). No k=40.
- Backbone N/A. No LLM reader.
- Store is empty or two remembered facts (`Use sqlite.` / `Auth is Clerk.`). No hay. No LoCoMo.
- Off switch is `EDEN_MEMORY=0`. On is the unset product default.
- `EDEN_KNOW=0` during seed and probe.
- Silence cells are pre-registered OMIT: Δ≈0 and packet omitted.
- Seeded rows with `store_n` below the seed length, or a dead store on the related sqlite cue, are FAIL, not WIN.
- Leftover sqlite or Clerk on an on-arm, or any `Eden Memory:` packet outside the ±1% band, is a named LOSS.
- Ranker was not retuned. `NEGATIVE.md` was not edited. `negative-fixture.json` was not retuned.

## Product bugs

- None on this run. injectBody packet bytes, omit, and identity matched inject on every arm.

## How to re-run

```bash
bun benchmarks/memory-holdout/run-silence.ts
```

Writes this file. Does not edit `silence-fixture.json`. Does not retune `src/index.ts`.
