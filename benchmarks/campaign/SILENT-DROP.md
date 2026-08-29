# Silent-drop host (Wave 5.4) + oblivious cents (Wave 5.2)

Analogue TURN_CENTS / ISLAND_CENTS. **Not a live Claude Code invoice.** The cents delta is analogue, not a campaign public WIN.

Measured 2026-08-27T10:27:12.853Z via `bun run benchmarks/campaign/silent-drop.ts --fast`.
Headless host **always drops** `updatedToolOutput` (R1); `additionalContext` kept; S1b PreToolUse deny still fires.

## Oblivious compilable stretch (S1b on)

Agent issues the full 3-call sequence (Read → Grep → Bash). Bash is the island-cost analogue (ISLAND_CENTS=0.3 if executed).
Eden: first call executes + transparent serve; remainder denied (no island). Raw: all three execute, island billed.

| Meter | Raw (ctrl) | Eden (trt) | Δ | Verdict |
|---|---|---|---|---|
| cents | 3.3000 | 3.0000 | -9.09% analogue | analogue vs raw (not a campaign WIN) |
| turns | 3.00 | 3.00 | 0.00% | INDISTINGUISHABLE |
| wall_ms | 95.99 | 44.01 | -54.15% | WIN |

Break-even: Eden cents ≤ raw (or INDISTINGUISHABLE within ±1% **and** suppressions > 0). **PASS** (Δcents -9.09% analogue vs raw; suppressions=2). Not a live Claude Code invoice.

Pre-registered expect: host drops rewrite; remainder deny must not corrupt; suppressions counted; cents WIN or INDISTINGUISHABLE within ±1%

## Unique-sequence red-team (no live program)

| arm | cents | denies |
|---|---|---|
| raw | 3.0000 | 0 |
| eden | 3.0000 | 0 |

Exact cents parity, zero denies.

## Materiality

Negative-control band unchanged: ±1% (`summarize(..., { lossTolerancePct: 1 })`).
