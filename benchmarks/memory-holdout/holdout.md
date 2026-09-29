# M6.1 Hook holdout (Gate 1 coding-holdout)

Locked coding-holdout on the **hook inject** path. Report **§5** product path, **Gate 1** acceptance, **§11.1 item 4** (locked coding-holdout / AML coding track — this file is the hook holdout, not AML). **M6.1** scores it. Do not tune the ranker.

M2.4 tool-trace is a sibling protocol: [`tools.md`](./tools.md). This runner re-runs it and pastes those rows into [`RESULTS.md`](./RESULTS.md).

## API under test

| | |
|---|---|
| Product | `respondToHook` / `memoryHookResponse` + `openMemory` |
| Score | `additionalContext` / `additional_context` after a later `UserPromptSubmit` |
| k | **default** (`notesFor` / `relevant`: `Number(process.env.EDEN_MEMORY_CAP) \|\| 6`). Runner unsets `EDEN_MEMORY_CAP`. |
| Store | `openMemory({ dir: EDEN_MEMORY_DIR, session })` as the hook already does (`hookMemory`) |

Not a published column: BrainMemory, `BrainMemory.retrieve`, `cortex: false`, k=40, hay, LoCoMo 92. Dual-API forbidden. **inject path only.** Not bakeoff rec5.

## Protocol

1. Fresh `EDEN_HOME` + `EDEN_MEMORY_DIR` per case. `EDEN_KNOW=0`. Do not set k.
2. Same `session_id` on every event in a case so M5 session dir / `ep` can fire.
3. **Observe:** fire each frozen `UserPromptSubmit` (or `PostToolUse` where a case needs a tool trace) through live `respondToHook`.
4. **Cue:** later `UserPromptSubmit` (paraphrase / commit-shaped / version question). Inject is `notesFor(cue)` then observe — this-turn fact is not in this request.
5. **PASS** iff inject `additionalContext` contains **every** gold needle (case-insensitive substring), with the junk extra rule below. JSONL / `openMemory().memories()` are diagnostics, not a second scoreboard.
6. Pre-register **`expect: FAIL`** per case in the fixture **before** looking at live inject. After the run, record the **true** dated verdict. Do not fake WIN. Do not retune.

Rotation: Report §5 / Gate 1 (flake, ADR, file rule, version, junk, tools persist). Not bakeoff rec5.

## Gate 1 acceptance (score honestly)

Report: *coding-holdout on inject path; commit surfaces test rule; ADR survives paraphrase; Node 16→18 newest wins without deleting “CI”; tools persist.*

| gate | meaning |
|---|---|
| **WIN** | inject contains every gold needle (junk: postgres/session store present) |
| **LOSS** | inject has content but missed gold (ranker/retrieve miss). Feeds M10, not a silent ranker retune |
| **FAIL** | empty inject, junk-only inject, or 16 still wins (Node 18 absent). Protocol/store miss |

Honest FAIL/LOSS is a valid close.

## Cases

Frozen in `holdout-fixture.json`. Language is durable for `extractDurable` (copula, “always”, “decided”, file paths, “CI is …”).

| id | Observe | Cue | Gold needles |
|---|---|---|---|
| `flake` | UserPromptSubmit “Please fix the flake in auth.test.ts” (+ FAIL log) | later cue about the flake | `auth.test.ts`, flake language |
| `adr` | “We decided to use Clerk for auth because SSO.” | “what auth provider?” | Clerk |
| `file-rule` | “Always run tests before committing.” | commit-shaped (“commit these changes”) | tests / before committing |
| `version` | “CI is Node 16.” then “CI is Node 18.” | “what Node version does CI use?” | Node 18. Must **not** require deleting the word CI. `subjectKey` supersedes same key; honest FAIL if 16 still wins |
| `junk` | asdf/qwerty/lol/thanks chatter, then “Postgres is the session store.” | cue the fact | PASS if inject has postgres/session store; FAIL if inject is empty **or** only junk. Junk-in-inject is a diagnostic, not a second scoreboard |

Plus M2.4 tool-trace (`test-exit`, `git-sha`, `flake-log`) via `runHoldout` in `run-tools.ts`.

## Junk extra rule

- **PASS** if inject hits gold (`postgres` / `session store`).
- **FAIL** if inject is empty **or** is only junk (asdf/qwerty/lol/thanks with no gold).
- Record whether junk leaked into inject (diagnostic). A leak with gold still present is still WIN.

## Version extra rule

Facts keep the word **CI**. Scoring must not strip “CI” to make 18 win. Newest wins = inject contains `Node 18`. If inject has `Node 16` and not `Node 18`, 16 still wins → FAIL.

## How to run

```bash
bun benchmarks/memory-holdout/run-holdout.ts
bun test benchmarks/memory-holdout
bun benchmarks/memory-holdout/run-tools.ts
```

`run-holdout.ts` writes `RESULTS.md` (M6.1 Done-when) and refreshes `TOOLS-RESULTS.md`. Paste the tools table into `tools.md` § RESULTS. Score inject only. Do not retune. Do not add a BrainMemory column.

CI test `holdout.test.ts` asserts fixture schema + that RESULTS exists with dated rows. It does **not** assert today’s PASS/FAIL, so it will not go red when the product flips.

## Pre-registered expect

**FAIL** per case (coding-holdout never scored on inject). The dated table in `RESULTS.md` is the **true** verdict on the tree at run time.

## RESULTS

Copied from `RESULTS.md` after `bun benchmarks/memory-holdout/run-holdout.ts` on 2026-09-17 (bun 1.3.13). k = default. Pre-registered expect was FAIL. Ranker not tuned. Dual-API forbidden.

| case | verdict | gate1 | inject hits | inject miss | notes |
|---|---|---|---|---|---|
| flake | PASS | WIN | auth.test.ts; flake | — | — |
| adr | PASS | WIN | Clerk | — | — |
| file-rule | PASS | WIN | tests; before committing | — | — |
| version | PASS | WIN | Node 18 | — | stale Node 16 absent from inject; CI kept (CI) |
| junk | PASS | WIN | postgres; session store | — | junk not in inject |

M2.4 tool-trace re-run: test-exit / git-sha / flake-log all PASS (WIN). See `TOOLS-RESULTS.md`.

**Overall: PASS.** Gate 1 WIN 8 / LOSS 0 / FAIL 0. Inject/additionalContext contained every gold needle. Ranker not tuned.

