# What was kept from the memory era

The previous product (passive memory for coding agents, and before it the compile era) is archived intact in
`archived/eden-memory/` (moved there on 2026-10-27 with `git mv`, so `git log --follow` still works).

## Brought into the new tree

| Now | From | Why |
|---|---|---|
| `packages/redact/src/secrets.ts`, `redact.ts`, `vendor/gitleaks/` + tests | `src/memory-secrets.ts`, `packages/ir/src/redact.ts` | Hardened over many review rounds; source content needs the same gate. |
| `scripts/check-line-length.ts`, `format.sh`, `typecheck.sh`, `test.sh`, `test-preload.ts` (simplified) | `scripts/` | The local CI that kept the old tree honest. |
| `.prettierrc.json`, `tsconfig.base.json`, Bun workspace layout | root | Same toolchain. |

## Worth mining later (read, don't import)

| Archived path | What to take |
|---|---|
| `packages/wrap/src/` | The OpenAI-compatible proxy that injected memory into requests (`messages` and Gemini `contents[]`), with operator-only auth. Port for M5's proxy. |
| `src/memory-ledger.ts` | The not-twice ledger with compaction re-arming. Ours is the minimal version. |
| `src/memory-gate.ts`, `src/memory-tau.ts`, `memory-silence-seeds.json` | Learned silence thresholds: when to say nothing. |
| `src/memory-bm25f.ts`, `src/memory-postings.ts` | Field-weighted BM25 with on-disk postings, if the item cache outgrows memory. |
| `src/memory-breaker.ts`, `src/memory-flags.ts` | Per-delivery-point flags (`off` / `shadow` / `on`) and a breaker that drops to shadow on errors. Shadow mode is how to roll out a new injection policy safely. |
| `docs/memory-ship/DECISIONS.md`, `A5-EVALUATION.md` | How the eval arms, pre-registration and guards were run. The discipline carries over. |
| `docs/memory-ship/reports/` | Measured lessons, e.g. how often topical-only matches were noise (see D6). |
| `docs/zdr.md`, `docs/owasp-mcp.md`, `docs/isolation.md` | Prior privacy and MCP security write-ups. |
| `benchmarks/` | Harness patterns (world replays, real-negative sets) for M1. |

Nothing in `archived/` builds or runs under the new workspace; the scripts exclude it.
