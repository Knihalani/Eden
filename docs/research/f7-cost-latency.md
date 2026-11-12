# F7: the push check's cost and wait, leaner

Status: 2026-11-12, branch `claude/f7-cost-latency` (from main 006b505c), session F7. Train, reworded and longtail
only; heldout19 is never read or run, heldout20 never looked for. Paid calls go to Anthropic directly with
`HAIKU_API_KEY` through the lab transport and its spend ledger (`.local/f7/ledger.jsonl`, D97): **Anthropic-direct
lab figures**. Cap $40. No Modal. Numbers marked **[EST]** are arithmetic or judgement; every other number comes from
a command in this note.

## 1. Pre-registration: the screen (committed before its paid calls)

Base: the shipped default's live check on train and reworded seed 43 with neutral tasks
(`bun run funnel --suite train|reworded --seeds 43 --jobs 1 -- --neutral --check live --check-dump …`; 1,092 recorded
checks, $0.229). `packages/sim/lab/f7/screen.ts` (H3's split screen with a lean prefix) re-asks every recorded pool
live under each arm, interleaved row by row in the same lanes:

- **W**: the shipped check.
- **Y**: `pushCheckLeanStop`: the same pool and instructions, one clause asking for every yes first, and the reply
  stopped at its first `"act":false`.
- **YD**: Y on the pool less same-source, same-title copies (H3's D, 15 items at most).

**Rule.** An arm goes to the Pi pair if, against W in the same run: planted named on hidden rows at least W − 6,
the look-alike named on control rows at most W + 6, neutral rows with any yes at most W + 6 (the bars are H3's ±4 on
189 rows of a kind, scaled to about 360), and its output tokens a check at most 0.75 of W's. Of the arms that pass,
Y goes if it passes (one change); YD only if Y fails. None passes: the switch and its code are deleted, findings kept.
