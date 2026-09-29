# M6.1 Hook holdout RESULTS

**Date:** 2026-09-25
**Bun:** 1.3.13
**API under test:** hook-inject (`respondToHook` / `memoryHookResponse` + `openMemory`)
**k:** default (product EDEN_MEMORY_CAP||6)
**Pre-registered expect:** FAIL (per-case FAIL in holdout-fixture.json; M2.4 tools-fixture expect FAIL)
**Overall:** PASS
**Gate 1:** WIN 8 / LOSS 0 / FAIL 0
**No-memory control:** `EDEN_MEMORY=0`. M35.2 (2026-09-22) off arm: `additionalContext` empty on all 8 Gate 1 + AMA cases. Gate 1 WIN is on vs off (needles present only when memory is on). See `SAVINGS.md`.
**M48.1:** Live coding holdout re-run after M16–M47 (2026-09-25). Same inject API. Ranker not retuned.

No BrainMemory column. No cortex-off column. Not LoCoMo 92. Not k=40. Not hay. Not bakeoff rec5. Ranker not tuned. Dual-API forbidden. inject path only.

Gate 1 acceptance: coding-holdout on inject path; commit surfaces test rule; ADR survives paraphrase; Node 16→18 newest wins without deleting “CI”; tools persist.

## Gate 1 coding-holdout (inject)

| case | verdict | gate1 | inject hits | inject miss | notes |
|---|---|---|---|---|---|
| flake | PASS | WIN | auth.test.ts; flake | — | — |
| adr | PASS | WIN | Clerk | — | — |
| file-rule | PASS | WIN | tests; before committing | — | — |
| version | PASS | WIN | Node 18 | — | stale Node 16 absent from inject; CI kept (CI) |
| junk | PASS | WIN | postgres; session store | — | junk not in inject |

## M2.4 tool-trace (re-run)

**Tools overall:** PASS. PostToolUse stored: yes.

| case | verdict | gate1 | stored after observe | JSONL n after observe | inject hits | inject miss |
|---|---|---|---|---|---|---|
| test-exit | PASS | WIN | yes | 1 | exit code 1; test_refresh_token; AMA-NEEDLE:EXIT_NONZERO=1 | — |
| git-sha | PASS | WIN | yes | 1 | c3f8a91b2e4d7a0c5b6e8f1a3d9c2e7b4a1f6c80; AMA-NEEDLE:GIT_SHA=c3f8a91b2e4d7a0c5b6e8f1a3d9c2e7b4a1f6c80 | — |
| flake-log | PASS | WIN | yes | 1 | test_concurrent_login; failed 2 of 7; FLAKE-SIG:auth-race-token-reuse; AMA-NEEDLE:FLAKE_LOG=auth-race-token-reuse | — |

True verdict on this tree: every Gate 1 gold needle and every M2.4 gold needle was in inject/additionalContext. Pre-registered expect was FAIL; this is not a forced FAIL. Ranker not tuned.

## How to re-run

```bash
bun benchmarks/memory-holdout/run-holdout.ts
bun benchmarks/memory-holdout/run-tools.ts
```

Paste this table into this file. Score additionalContext only. Do not add a BrainMemory column. Do not set k=40. Do not retune `src/index.ts` ranking.

## M33.4 Gate 1 after competency router

**Date:** 2026-09-22
**Bun:** 1.3.13
**API:** hook-inject (`respondToHook` / `memoryHookResponse` / `openMemory`)
**Router:** `routeMemory` on `AgentMemory.relevant` (one lane). Not a memory_search tool.
**router_wired:** yes (`src/index.ts` imports `./memory-router`)
**k:** product default (`EDEN_MEMORY_CAP` unset → 6)
**Gate 1:** WIN 8 / LOSS 0 / FAIL 0

Command: `bun benchmarks/memory-holdout/run-holdout.ts` (also re-ran tools). Exit 0. Ranker not retuned. Dual-API forbidden. No BrainMemory column. No k=40. No LoCoMo 92.

True verdict after router: every Gate 1 gold needle and every M2.4 gold needle still in inject/additionalContext. Gate 1 still WIN. Ranker not tuned.

## M34.2 Gate 1 after retrieve skip + WAL persist

**Date:** 2026-09-22
**Bun:** 1.3.13
**API:** hook-inject (`respondToHook` / `memoryHookResponse` / `openMemory`)
**Change:** `relevant()` score loop skips zero-hit bags (df unchanged); persist WAL on `memories.jsonl.wal`. No hay return.
**k:** product default (`EDEN_MEMORY_CAP` unset → 6)
**Gate 1:** WIN 8 / LOSS 0 / FAIL 0

Same table as above. Ranker not retuned. Dual-API forbidden. No BrainMemory column. No k=40. No LoCoMo 92.

## Silence

**Date:** 2026-09-25
**API:** hook-inject (`respondToHook` / `memoryHookResponse` + `openMemory`)
**Gate:** M38 remain-silent — packet omitted or no harm.
**k:** default (`EDEN_MEMORY_CAP` unset → 6). `EDEN_KNOW=0`. Off: `EDEN_MEMORY=0`.
**Command:** `bun benchmarks/memory-holdout/run-holdout-silence.ts`

Hook echoes one packet on `additional_context` and `hookSpecificOutput.additionalContext`; bytes below are that text scored once.

| case | packet | leftover / junk | verdict |
|---|---|---|---|
| junk (holdout) | gold present — postgres; session store (65 B: `Eden Memory: - [fact · 0m · user] Postgres is the session store`) | chatter absent — asdf, qwerty, lol, thanks | PASS |
| silent-math (hook) | omitted — 0 B on / 0 B off, Δ 0 (`what's 2+2?` and `What is 17 times 23?`) | none — sqlite, Clerk absent | PASS |

Holdout `junk`: after `asdf asdf asdf`, `qwerty qwerty qwerty`, `lol`, `thanks`, `ok thanks`, and `Postgres is the session store.`, cue `What is the session store?` injected the fact. Junk needles were not in the packet. Off arm `additionalContext` empty (0 B).

Silent-math: store held `Use sqlite` and `Auth is Clerk`. Related cue `What sqlite database do we use?` injected sqlite (87 B), so the omit is not a dead store. Both math cues returned no `Eden Memory:` chrome and empty `additionalContext` on and off. Δ = 0.

Packet omitted or no harm (M38). Pass. See also `SILENCE.md` (M38.3 inject annex). Ranker not retuned.

## Multi-session

**Date:** 2026-09-25
**API:** hook-inject (`respondToHook` / `memoryHookResponse` + `openMemory`)
**Proof:** session A encode ADR → session B inject (M44). Not a second full Gate 1 re-run.

| case | session A | session B cue | inject hits | verdict |
|---|---|---|---|---|
| adr-across-sessions | Clerk ADR observed | what auth provider? | Clerk | PASS |

Pass. Ranker not retuned. Dual-API forbidden. No BrainMemory column.

Session A JSONL contained Clerk after UserPromptSubmit. Stop on session A ran after UserPromptSubmit because root semantic and gist still lacked Clerk. After that flush check, root semantic contained Clerk and root gist contained Clerk. Same cue on session A injected Clerk (store live; not a scored cell).
Math cue on B (`what's 2+2?`) omitted the packet (M38). Not a scored cell.
