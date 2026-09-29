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
