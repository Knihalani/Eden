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
