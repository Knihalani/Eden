# Inject API freeze (M1.1)

The product object is **`AgentMemory`**, opened with **`openMemory` / `processMemory`**. Product scores go through wrap inject and the Claude hook. Report **§2** (three systems, one brand) and **§5.4** (the only call sites that matter). `BrainMemory`, `BrainMemory.retrieve`, and a `cortex: false` column are not this path.

## Wrap OpenAI

`packages/wrap/src/proxy.ts` `handleChatCompletions` calls `injectBodyThenObserveTools(processMemory(), body)` on the live OpenAI chat path (same `AgentMemory` instance): stream at ~176 (`JSON.stringify(withStreamUsage(injectBodyThenObserveTools(processMemory(), body)))`), steered/non-stream at ~195 (`injectBodyThenObserveTools(processMemory(), { ...body, stream: false, tools: injected })`). A comment must not satisfy this — the live call is the helper, not `processMemory().injectBody`. The helper runs `mem.injectBody` then `observeToolTraces` (`packages/wrap/src/tool-observe.ts`) because `convBlob` still skips `tool_calls` / `tool_result` blocks. `injectBody` lives on `AgentMemory` in `src/index.ts`: **`inject(messages)` first** (or encode-only if `system*` already has `MEMORY_MARK`), then it may observe `body.system*` as a user turn. Rank cue is **`cueFor(messages)`** — latest user text, not the full `convBlob` window. Causal order is **notesFor then observe** (this-turn extract, including `system*`, is not in this request), then a second observe of synthetic tool turns. Empty cue skips last-k dump. Store is the `processMemory()` singleton, except `*.test.ts` which opens a **new random tmpdir per call**. `inject` catch returns the original list (silent fail-open; swallow metric is M1.4). Helper catch also returns the original body.

## Wrap Anthropic

`packages/wrap/src/anthropic.ts` `handleAnthropicMessages` (~259) assigns `body = withKnowFactsAnthropic(body)`. That function in `packages/wrap/src/know-inject.ts` ranks with **`cueFor(messages)`** (latest user text), same order as OpenAI **`inject`**: **notesFor then observe**, then `observeToolTraces`. Skip-if-mark: if `alreadyInjected(blob)` or `MEMORY_MARK` is already in the blob (`system` + last-8 `messageText` for mark detection only), Anthropic still **`observe(messages)` and `observeToolTraces`**, then returns the original body (encode-only; no second inject). Fail-open: the function `catch` returns the original body. One `processMemory()` instance per call.

## Claude hook

`packages/cli/src/memory-hook.ts` `memoryHookResponse` is the product hook. Events in `MEMORY_EVENTS`: **UserPromptSubmit, SessionStart, PreCompact, Stop, SessionEnd, PostToolUse, SubagentStop**. Submit/PreCompact: rank via `inject([{ role: "user", content: prompt }])` so the cue is the **prompt string** (`notesFromInject`); transcript-40 is **observed separately**, not ranked. Empty prompt (typical PreCompact) is observe-only. SessionStart briefs via `notesFor`; Stop/SessionEnd observe-only. PostToolUse / SubagentStop observe tool name + result and **return null** (no inject, so they cannot replace `updatedToolOutput`). `packages/cli/src/hook.ts` `respondToHook` always forwards PostToolUse to `memoryHookResponse` (even without `tool_name`); stretch/transparent recording still requires a name. Plugin `plugins/eden-memory/hooks/hooks.json` lists PostToolUse and SubagentStop. Store: **`openMemory()` per event** (`hookMemory`) keyed by hook `session_id` (also `sessionID` / `sessionId`) so the file is `<dir>/<session>/memories.jsonl` and `ep` is restored on load — TCM/`ep` survive spawn for that session. Wrap still uses the `processMemory()` singleton. Fail-open: `catch` → `null`.

## Bans

- Do not score **`BrainMemory`**, **`BrainMemory.retrieve`**, or **`cortex: false`** as a published product column. Bench CLS with cortex off is not wrap/hook `AgentMemory` (Report §2).
- Do not treat dual-API (bench CLS vs hook inject) as the same claim. A number without the inject API under test is not a product score (Report §5.4).

The files `mab-bridge.ts`, `eden.py`, `memory-fixes.test.ts`, and this folder’s `README.md` are the **legacy MAB adapter**. They stay `// not-product` / `not-product` until **M9.1** rewires Table 3 to `openMemory` inject. A BrainMemory import without `// not-product` on the **same line** fails `inject-api.test.ts` and `inject-only.test.ts`.

`injectBody` observes `body.system*` as `role: user` *after* `inject()` (so this-turn system text cannot echo). That observe is inside `injectBody`’s fail-open `catch` (same swallow metric as `inject`). Persist kill-9 / torn JSONL: `load()` skips bad lines; next `persist()` heals — pinned in `src/memory-struggle.test.ts` (M6.3).
