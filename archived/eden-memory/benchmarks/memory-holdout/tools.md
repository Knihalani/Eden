# M2.4 Tool-trace holdout (AMA-Bench)

AMA-shaped coding-agent cases on the **hook inject** path. Report **§11.2 AMA-Bench** [arxiv:2602.22769] — memory over states / actions / tools, not chat. This part files the fixture. **M6 re-runs it.** Do not tune the ranker.

## API under test

| | |
|---|---|
| Product | `respondToHook` / `memoryHookResponse` + `openMemory` |
| Score | `additionalContext` / `additional_context` after a later `UserPromptSubmit` |
| k | **default** (`notesFor` / `relevant`: `Number(process.env.EDEN_MEMORY_CAP) \|\| 6`). Runner unsets `EDEN_MEMORY_CAP`. |
| Store | `openMemory({ dir: EDEN_MEMORY_DIR })` as the hook already does (`hookMemory`) |

Not a published column: BrainMemory, `BrainMemory.retrieve`, `cortex: false`, k=40, hay, LoCoMo 92.

## Protocol

1. Fresh `EDEN_HOME` + `EDEN_MEMORY_DIR` per case. `EDEN_KNOW=0`. Do not set k.
2. **Observe:** fire each frozen `PostToolUse` through live `respondToHook` (CLI hook; PostToolUse forwards to `memoryHookResponse`).
3. **Cue:** later `UserPromptSubmit` asking about that exit / sha / flake.
4. **PASS** iff inject `additionalContext` contains **every** gold needle (case-insensitive substring). JSONL / `openMemory().memories()` are diagnostics, not a second scoreboard.
5. Pre-register **`expect: FAIL`** until the hook observes tools. After the run, record the **true** dated verdict. Do not fake WIN. Do not retune.

Rotation: AMA-Bench Software Engineering (SWE-bench Verified + OpenHands-shaped tool observations) and LME-V2-style later-colleague cues over those logs. Not bakeoff rec5.

## Hook behavior on this tree

`memoryHookResponse` `MEMORY_EVENTS` includes `PostToolUse` and `SubagentStop` (M2.2 in-tree while this check ran). PostToolUse / SubagentStop **observe** tool name + result and **return null** (no inject on the tool event). `respondToHook` PostToolUse still does stretch / transparent recording, then calls `memoryHookResponse`.

Plugin `hooks.json` lists SubagentStop. Inject is the later UserPromptSubmit.

If a future tree drops PostToolUse from `MEMORY_EVENTS` again, this holdout must FAIL. Do not retune the ranker to compensate.

## Cases

Frozen in `tools-fixture.json`.

| id | AMA type | Observe | Cue | Gold needles |
|---|---|---|---|---|
| `test-exit` | A recall | PostToolUse Bash `pytest tests/test_session.py` → non-zero / FAIL | pytest exit status + which test FAILED | `exit code 1`, `test_refresh_token`, `AMA-NEEDLE:EXIT_NONZERO=1` |
| `git-sha` | A recall | PostToolUse Bash `git log -1 --format='%H %s'` | which commit sha | `c3f8a91b2e4d7a0c5b6e8f1a3d9c2e7b4a1f6c80` |
| `flake-log` | A recall | PostToolUse Bash `pytest … --count=7` flake log | which test flaked + signature | `test_concurrent_login`, `failed 2 of 7`, `FLAKE-SIG:auth-race-token-reuse` |

## How M6 re-runs

```bash
bun benchmarks/memory-holdout/run-tools.ts
```

That script executes the fixture against the live hook, prints PASS/FAIL per case, and writes `TOOLS-RESULTS.md`. Paste the table into **RESULTS** below. Score inject only. Do not retune. Do not add a BrainMemory column.

CI test `tools.test.ts` asserts fixture schema + that RESULTS exists. It does **not** assert today's PASS/FAIL, so it will not go red when the product flips.

## Pre-registered expect

**FAIL** until tools are observed (M2.2). This part still merges the fixture. The dated table below is the **true** verdict on the tree at run time.

## RESULTS

Copied from `TOOLS-RESULTS.md` after `bun benchmarks/memory-holdout/run-tools.ts` on 2026-09-25 (bun 1.3.13). k = default. Pre-registered expect was FAIL; M2.2 had landed.

| case | verdict | stored after observe | JSONL n after observe | inject hits | inject miss |
|---|---|---|---|---|---|
| test-exit | PASS | yes | 1 | exit code 1; test_refresh_token; AMA-NEEDLE:EXIT_NONZERO=1 | — |
| git-sha | PASS | yes | 1 | c3f8a91b2e4d7a0c5b6e8f1a3d9c2e7b4a1f6c80; AMA-NEEDLE:GIT_SHA=c3f8a91b2e4d7a0c5b6e8f1a3d9c2e7b4a1f6c80 | — |
| flake-log | PASS | yes | 1 | test_concurrent_login; failed 2 of 7; FLAKE-SIG:auth-race-token-reuse; AMA-NEEDLE:FLAKE_LOG=auth-race-token-reuse | — |

True verdict on this tree: inject/additionalContext contained every gold needle. `respondToHook` PostToolUse forwards to `memoryHookResponse`, which observes tool name + result (returns null; inject is the later UserPromptSubmit). Pre-registered expect was FAIL until tools were observed; M2.2 had landed, so this is not a forced FAIL.

**Overall: PASS.** Inject/additionalContext contained every gold needle. Ranker not tuned.
