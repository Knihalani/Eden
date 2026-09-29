# M47.1 Product help ledger

**Date:** 2026-09-25
**Bun:** 1.3.13
**Report:** §11.2 — MemoryBench humility (memory can help, no-lift, or harm). This file is the live wrap+hook product ledger. `SAVINGS.md` is the M35 bench annex.
**API:** wrap `injectBody` (`openMemory({ dir }).injectBody`) and hook `memoryHookResponse` / `respondToHook` (`openMemory` inject). Not BrainMemory. Not `memory_search`.
**k:** product default (`EDEN_MEMORY_CAP` unset → 6). Not k=40. Not hay. Not LoCoMo 92.
**No-memory control:** `EDEN_MEMORY=0` (off = inject identity). On arm: `EDEN_MEMORY` unset. `EDEN_KNOW=0` so the Know catalog is not this packet.

**Totals:** helped 10 / no-lift 2 / harmed 0

Counted rows are host × case, on vs off. Harmed is a count, not a target. Correct omit (silent-math, both packets empty) is no-lift. Ranker not retuned. Fail-open stays. Token Δ is not in this file.
Verdict: helped = WIN. harmed = LOSS. no-lift is junk-silent, not a LOSS.

## Counted (on vs off)

Measured 2026-09-25. Each row is one scripted live-shaped session. Wrap seeds with `openMemory({ dir }).observe`, then scores `injectBody`. Hook seeds and cues with `respondToHook` → `memoryHookResponse` UserPromptSubmit. Off is a clone of that seeded store under `EDEN_MEMORY=0`. Hook echoes one packet on both `additional_context` and `hookSpecificOutput.additionalContext`; this ledger scores that text once.

| case | host | class | on | off | Δ | control | notes |
|---|---|---|---|---|---|---|---|
| flake | wrap | helped | gold: auth.test.ts; flake | empty | needles on only | EDEN_MEMORY=0 | gold on, absent off |
| flake | hook | helped | gold: auth.test.ts; flake | empty | needles on only | EDEN_MEMORY=0 | gold on, absent off |
| adr | wrap | helped | gold: Clerk | empty | needles on only | EDEN_MEMORY=0 | gold on, absent off |
| adr | hook | helped | gold: Clerk | empty | needles on only | EDEN_MEMORY=0 | gold on, absent off |
| file-rule | wrap | helped | gold: tests; before committing | empty | needles on only | EDEN_MEMORY=0 | gold on, absent off |
| file-rule | hook | helped | gold: tests; before committing | empty | needles on only | EDEN_MEMORY=0 | gold on, absent off |
| version | wrap | helped | gold: Node 18; Node 16 absent; CI kept | empty | needles on only | EDEN_MEMORY=0 | Node 16 absent; kept CI |
| version | hook | helped | gold: Node 18; Node 16 absent; CI kept | empty | needles on only | EDEN_MEMORY=0 | Node 16 absent; kept CI |
| junk | wrap | helped | gold: postgres; session store; chatter absent | empty | needles on only | EDEN_MEMORY=0 | chatter absent |
| junk | hook | helped | gold: postgres; session store; chatter absent | empty | needles on only | EDEN_MEMORY=0 | chatter absent |
| silent-math | wrap | no-lift | empty | empty | 0 | EDEN_MEMORY=0 | packet omitted both arms; stored Use sqlite. / Auth is Clerk.; cue “What is 17 times 23?”; store live: “What sqlite database do we use?” injected sqlite |
| silent-math | hook | no-lift | empty | empty | 0 | EDEN_MEMORY=0 | packet omitted both arms; stored Use sqlite. / Auth is Clerk.; cue “What is 17 times 23?”; store live: “What sqlite database do we use?” injected sqlite |

## Verdict (dated)

Measured 2026-09-25. One WIN or LOSS (or no-lift) per counted case.

| case | host | verdict |
|---|---|---|
| flake | wrap | WIN |
| flake | hook | WIN |
| adr | wrap | WIN |
| adr | hook | WIN |
| file-rule | wrap | WIN |
| file-rule | hook | WIN |
| version | wrap | WIN |
| version | hook | WIN |
| junk | wrap | WIN |
| junk | hook | WIN |
| silent-math | wrap | no-lift |
| silent-math | hook | no-lift |

## Packets (audit)

System text containing `Eden Memory:` only. Empty means the product returned inject identity (no mark).

- **flake / wrap** jsonl 2 — on: Eden Memory: - [fact · 0m · user] Please fix the flake in auth.test.ts - [fact · 0m · user] FAIL auth.test.ts Intermittent flake on login — off: empty
- **flake / hook** jsonl 2 — on: Eden Memory: - [fact · 0m · user] Please fix the flake in auth.test.ts - [fact · 0m · user] FAIL auth.test.ts Intermittent flake on login — off: empty
- **adr / wrap** jsonl 1 — on: Eden Memory: - [episode · 0m · user] We decided to use Clerk for auth because SSO — off: empty
- **adr / hook** jsonl 1 — on: Eden Memory: - [episode · 0m · user] We decided to use Clerk for auth because SSO — off: empty
- **file-rule / wrap** jsonl 1 — on: Eden Memory: - [rule · 0m · user] Always run tests before committing — off: empty
- **file-rule / hook** jsonl 1 — on: Eden Memory: - [rule · 0m · user] Always run tests before committing — off: empty
- **version / wrap** jsonl 1 — on: Eden Memory: - [fact · 0m · user] CI is Node 18 — off: empty
- **version / hook** jsonl 1 — on: Eden Memory: - [fact · 0m · user] CI is Node 18 — off: empty
- **junk / wrap** jsonl 1 — on: Eden Memory: - [fact · 0m · user] Postgres is the session store — off: empty
- **junk / hook** jsonl 1 — on: Eden Memory: - [fact · 0m · user] Postgres is the session store — off: empty
- **silent-math / wrap** jsonl 2 — on: empty — off: empty
- **silent-math / hook** jsonl 2 — on: empty — off: empty

## Construction traps

Not helped rows:

- Memorable 454/454 is a fixture-completion score, not this inject exam.
- Mem0 92 (LoCoMo 92) is not an Eden on-vs-off result.

No BrainMemory column. No cortex-off column. No k=40. No hay. No `memory_search`. Fail-open and silent inject stay as they are.

## Not in this file

- Token Δ lives in `HELP-TOKENS.md` (M47.3). This ledger does not invent token numbers.
- Harmed ids omitted on the next inject is M47.2 product code (`src/memory-harmed.ts`). This file only classifies sessions.

## How to re-run

```bash
bun benchmarks/memory-holdout/run-help.ts
```

Writes this file from the run. Does not retune `src/index.ts`. Does not edit `SAVINGS.md`.
