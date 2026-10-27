# M50.1 optional reject — Dense RAG, PreToolUse-as-memory, MCP

**Date:** 2026-09-25  
**Wave:** M50.1  
**Plan:** §7 walkthrough on wrap and hook. Not a memory UI. Not a second brain.

## Verdict

Rejected. No named Plan §7 walkthrough step fails without them.

`bun test src/memory-walkthrough.test.ts` after this pass: **38 pass / 0 fail** (518 `expect()` calls). M36.2 steps 1–10 and M49.3 first-session are green on wrap (OpenAI `injectBody` and Anthropic `inject`) and on hook (`memoryHookResponse`).

## Dense RAG — rejected

`src/memory-dense.ts` exports `DENSE_RAG = false`. The module does not retrieve and does not throw into inject.

Report §4.3: dense RAG (Qwen3 / TE3) overall **38.0–38.2**, below BM25 **41.5**. Dense lost overall.

- **M18** EventQA inject **64** vs identical-chunk BM25 **74.6** on official 534k — LOSS. Close rule: lose to LangChain BM25 on identical chunks, stop adding structure. Dense is more structure.
- **M27** SH inject **64** vs BM25 **66** / HippoRAG **76** — LOSS. Same close rule.

A hybrid was permitted by those BM25 losses and is still rejected: §4.3 already ran embeddings and they lost overall, so they are not a hybrid proof. Store-all BM25 stays. No embedder. No network embed. No new npm dependency. ICL stays store-all.

## PreToolUse — not the memory product

`packages/cli/src/setup.ts` installs PreToolUse as a compile probe (`preHookCommand`: `curl --max-time 1` to hookd, or `echo '{}'`). It does not cold-spawn the CLI and it does not encode or inject.

`packages/cli/src/memory-hook.ts` `MEMORY_EVENTS` is the seven memory events: UserPromptSubmit, SessionStart, PreCompact, Stop, SessionEnd, PostToolUse, SubagentStop. PreToolUse is absent, so `memoryHookResponse` returns null for it.

`packages/cli/src/hook.ts` `respondToHook` on PreToolUse claims compile remainder / steer. It does not call `memoryHookResponse`.

## MCP / memory_search / memorable-cli — rejected as the default loop

Product callers have **zero** `memory_search` and **zero** `memorable-cli`:

- `packages/wrap/src/` (non-test): `proxy.ts` injects with `injectBodyThenObserveTools(processMemory(), body)`, which calls `injectBody`
- `packages/wrap/src/know-inject.ts`: Anthropic path calls `mem.inject(...)`
- `packages/cli/src/memory-hook.ts`, `hook.ts`, `setup.ts`, `doctor.ts`

`eden mcp` in setup is the compile server, not a hippocampus. Plan §7: no MCP in the default loop. The model does not call `memory_search`.

## Evidence the walkthrough does not need them

| Gate | Holds without Dense / PreToolUse / MCP |
|---|---|
| M36.2 1–10 | wrap OpenAI + Anthropic and hook, this pass |
| M49.3 first session | sqlite decision, new cue, sleep, still sqlite, wrap and hook |
| Remain-silent | `what's 2+2?` with a sqlite store omits the packet; SessionStart still briefs pins/gists |
| Fail-open | inject throw returns the original messages |
| `EDEN_MEMORY=0` | identity on inject, wrap, and hook |
| Operator | seven memory events; PreToolUse stays compile-only |

M38–M49 Done-whens were re-run on their owner tests in this pass and stayed green. Ranker weights were not rewritten.
