# M2.4 tool-trace holdout RESULTS

**Date:** 2026-09-25
**Bun:** 1.3.13
**API under test:** hook-inject (`respondToHook` / `memoryHookResponse` + `openMemory`)
**k:** default (product EDEN_MEMORY_CAP||6)
**Pre-registered expect:** FAIL
**Overall:** PASS
**PostToolUse stored (all gold needles in JSONL after observe):** yes

No BrainMemory column. No cortex-off column. Not LoCoMo 92. Not bakeoff rec5. Ranker not tuned.

| case | verdict | stored after observe | JSONL n after observe | inject hits | inject miss |
|---|---|---|---|---|---|
| test-exit | PASS | yes | 1 | exit code 1; test_refresh_token; AMA-NEEDLE:EXIT_NONZERO=1 | — |
| git-sha | PASS | yes | 1 | c3f8a91b2e4d7a0c5b6e8f1a3d9c2e7b4a1f6c80; AMA-NEEDLE:GIT_SHA=c3f8a91b2e4d7a0c5b6e8f1a3d9c2e7b4a1f6c80 | — |
| flake-log | PASS | yes | 1 | test_concurrent_login; failed 2 of 7; FLAKE-SIG:auth-race-token-reuse; AMA-NEEDLE:FLAKE_LOG=auth-race-token-reuse | — |

True verdict on this tree: inject/additionalContext contained every gold needle. `respondToHook` PostToolUse forwards to `memoryHookResponse`, which observes tool name + result (returns null; inject is the later UserPromptSubmit). Pre-registered expect was FAIL until tools were observed; M2.2 had landed, so this is not a forced FAIL.

## How M6 re-runs

```bash
bun benchmarks/memory-holdout/run-tools.ts
```

Paste the table into this file and into `tools.md` § RESULTS. Score additionalContext only. Do not add a BrainMemory column. Do not set k=40.
