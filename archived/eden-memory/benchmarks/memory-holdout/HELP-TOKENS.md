# M47.3 Wrap token Δ

**Date:** 2026-09-24
**API:** wrap `injectBody` / `openMemory`. Not BrainMemory. Not memory_search.
**Control:** `EDEN_MEMORY=0` (off, inject identity). **On:** `EDEN_MEMORY` unset.
**Know:** `EDEN_KNOW=0`.
**k:** default (EDEN_MEMORY_CAP unset → 6). No k=40. No hay. No LoCoMo 92.
**Bun:** 1.3.13

This file is wrap inject packet tokens only. LIVE session classification is HELP.md (M47.1). Harbor/TB totals are not this number.

Approx tokens are `ceil(chars/4)` of the system content that contains `Eden Memory:`. Bytes are the UTF-8 length of that packet. Off is 0 bytes when identity. Accuracy Δ is gold needles present on the on-arm minus gold needles on the off-arm. Gold on-arm only and off empty is Δ>0 (helped). Both empty of gold is Δ=0. On-arm leftover junk on math with tokens up is Δ≤0 and that class is silent (M38).

## Table

| case | tokens_off (approx) | tokens_on | bytes_off | bytes_on | Δ bytes | accuracy Δ (needles) | silent? | verdict |
|---|---|---|---|---|---|---|---|---|
| flake | 0 | 35 | 0 | 141 | 141 | +2 | no | helped |
| adr | 0 | 21 | 0 | 83 | 83 | +1 | no | helped |
| file-rule | 0 | 17 | 0 | 70 | 70 | +2 | no | helped |
| version | 0 | 12 | 0 | 49 | 49 | +1 | no | helped |
| junk | 0 | 16 | 0 | 65 | 65 | +2 | no | helped |
| silent-math | 0 | 0 | 0 | 0 | 0 | 0 | yes | silent |

## Totals

- **sum Δ bytes:** 408
- **classes where tokens up and accuracy Δ≤0:** 0 (target 0)

## Classes that must be silent

- None. No cue class had tokens up and accuracy Δ≤0.

## Anthropic-shaped check

`inject` via the same user messages is the packet source Anthropic wrap copies into `system`. It is not a second scored API. `injectBody` is the wrap OpenAI path and the filed number.

- inject() packet bytes matched injectBody on every class.

## Packets

### flake
- cue: `Which file had the flake I asked you to fix?`
- store_n: 2
- gold on-arm: auth.test.ts, flake
- leftover on-arm: none
- inject() bytes (Anthropic message source): 141 · agrees with injectBody: yes
- on packet: Eden Memory: - [fact · 0m · user] Please fix the flake in auth.test.ts - [fact · 0m · user] FAIL auth.test.ts Intermittent flake on login

### adr
- cue: `what auth provider?`
- store_n: 1
- gold on-arm: Clerk
- leftover on-arm: none
- inject() bytes (Anthropic message source): 83 · agrees with injectBody: yes
- on packet: Eden Memory: - [episode · 0m · user] We decided to use Clerk for auth because SSO

### file-rule
- cue: `commit these changes`
- store_n: 1
- gold on-arm: tests, before committing
- leftover on-arm: none
- inject() bytes (Anthropic message source): 70 · agrees with injectBody: yes
- on packet: Eden Memory: - [rule · 0m · user] Always run tests before committing

### version
- cue: `what Node version does CI use?`
- store_n: 1
- gold on-arm: Node 18
- leftover on-arm: none
- inject() bytes (Anthropic message source): 49 · agrees with injectBody: yes
- on packet: Eden Memory: - [fact · 0m · user] CI is Node 18

### junk
- cue: `What is the session store?`
- store_n: 1
- gold on-arm: postgres, session store
- leftover on-arm: none
- inject() bytes (Anthropic message source): 65 · agrees with injectBody: yes
- on packet: Eden Memory: - [fact · 0m · user] Postgres is the session store

### silent-math
- cue: `what's 2+2?`
- store_n: 2
- gold on-arm: none
- leftover on-arm: none
- inject() bytes (Anthropic message source): 0 · agrees with injectBody: yes
- on packet: (empty)

## How to re-run

```bash
bun benchmarks/memory-holdout/run-help-tokens.ts
```

Writes this file from the run. Does not retune the ranker. Does not edit holdout or silence fixtures.
