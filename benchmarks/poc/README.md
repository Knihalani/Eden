# Eden 10x improvement lab

> **Compile era: retired.** This lab served Eden's earlier tool-path compiler. Eden is now passive memory for coding agents ([README](../../README.md)); the compile-era documents are in [archived/compile-era/](../../archived/compile-era/README.md).

Every idea here was hypothesised from code+market research, proven with a
benchmark or test against REAL production code, and — where marked **shipped**
— promoted into production. Run everything: `./run-all.sh`.

Ground rules: drive production code, never reimplement it; model only what
cannot be measured (DB/network hops) and label it; every script prints a
verdict.

## Proven AND shipped to production

| # | Idea | Measured result | Shipped as |
|---|---|---|---|
| B | Memoized shape extraction | 64× faster repeat passes (88→1.4 ms / 4k cmds) | `shapes.ts` memo + call sites; tests |
| 2/G | Hot path: wave memo + cache-fill off critical path | ~10.6 µs → <1 ns graph work per call; 1 DB RTT off every miss | `playback.ts` `wavesFor`, fire-and-forget fill |
| F | Billing-path bytes | 12–26% of densify cost removed per receipt | `densifyPayload(rawBytes)` + playback accounting |
| I | OpenAI-log import fidelity | 0 candidates → compiled tools from OpenAI exports | `ingest.ts`: auto-detect routing + conversation grouping |
| J | Scored warming | today's last-6 warming = no warming; scorer adds +3–5 pts hit rate | `warmWorkspaceBundle` recency×frequency over 60-id window |
| 4/A | ETag revalidation + shared public pool | 74% fewer upstream requests; ÷W cross-tenant public fetches | `cache.ts` envelopes + `rcp:` allowlisted pool (`api.github.com`, credential-free only) |
| C | Deterministic-first islands | witnessed glue calls skip gpt-4o-mini entirely | `island.ts` `withWitnessMemo` wired into `wrapIsland`; tests |
| 5 | Prompt-cache-native serving | 5.3× input-spend vs today, 7.2× vs naive | `anthropic.ts` `applyCacheBreakpoints` (tools/system/tail); opt-out `EDEN_PROMPT_CACHE=0` |
| 6 | Multi-agent installer | Claude + Gemini + OpenCode + Codex coverage | `setup.ts` auto-detect writers + `--all-agents`; cross-platform `openBrowser` |
| 3 | Ready-node scheduling | 1.53× on jittery mixed tools; wave barriers eliminated | `playOneReady`, opt-in `EDEN_SCHED=ready`; 4 contract tests |
| 8* | Self-healing loop | drift detect → re-mine → shadow-validate proven | pieces in prod (canary/deopt/shadow); loop wiring remains product work |
| 1 | Import-to-candidate cold start | candidate ~16 ms from cold OTel export | pipeline proven; front-door UX remains product work |
| **S1** | **Transparent execution** | read-only compiled routines served by PostToolUse output replacement: zero schemas, zero agent decisions, fails open everywhere; Bash-native `{stdout,stderr,interrupted}` form (research R1: bare strings are silently dropped) | `packages/cli/src/transparent.ts` wired into hookd; tests incl. shape + truncation-cap |
| **S2** | **Filesystem manifest** (`eden manifest` → `eden.tools.md`) | progressive disclosure ~25 tok/program, no transport | `packages/cli/src/manifest.ts`; snapshot tests |
| **S-bench** | Surfacing economics (POC S) | MCP catalog vs JIT vs manifest vs transparent: −43% / −100% / −100% schema tax; transparent removes all model decisions | `pocS-surfacing.ts` |

## Next hypotheses (researched, not yet built)

- **K — Zero-round-trip steering.** Claude Code's May-2026 hooks can replace
  tool output (`hookSpecificOutput.updatedToolOutput`). When steering matches,
  Eden can answer the agent's *old* Bash call directly with compiled receipt
  facts instead of waiting for it to call the MCP tool — the stretch dies
  without a single wasted round trip.
- **L — Receipt-level dedupe across batched ids** sharing identical sub-steps
  (e.g., same base PR data fetched per-item in a 100-item batch).
- **M — Compile-pass parallelism**: cluster/failure/fork mining are independent
  read-only passes over the same traces; large imports could interleave them.

## Verification

- Production patches covered by the workspace suite: `./scripts/test.sh`
  (972+ pass, 0 fail at time of writing), typecheck clean.
- Benchmarks are deterministic (seeded PRNG) except where real network timing
  applies (poc3/poc4/pocG use real timers/sockets; medians over ≥9 trials).
