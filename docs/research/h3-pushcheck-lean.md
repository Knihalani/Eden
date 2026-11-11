# H3: the push check, leaner

Status: 2026-11-11, branch `claude/h3-pushcheck-lean` (from main 793a4c47), session H3. Train only; heldout19 is
never read or run. Paid calls go to Anthropic directly with `HAIKU_API_KEY` through the lab's spend ledger
(`.local/h3/ledger.jsonl`, D97): **Anthropic-direct lab figures**. Cap $15. Numbers marked **[EST]** are arithmetic
or judgement; every other number comes from a command in this note.

Goal (the parent's brief): cut the push check's paid cost per 1,000 tasks, or its added latency, by at least 20%,
with quality held.

## 1. Pre-registration (committed before the screen's and the Pi pair's paid calls)

### 1a. The screen

Base: `bun run funnel --suite train --seeds 42 --jobs 1 -- --neutral --check live --check-dump base42.dump.jsonl`
(the shipped default, live Haiku 5.5 check; 563 recorded checks). `packages/sim/lab/h3/split-screen.ts` re-asks every
recorded pool live under each arm, the arms interleaved row by row in the same lanes:

- **W**: the shipped check (15 items of 200 characters).
- **D**: the 15 less any item whose source and title (case folded) an earlier item already has (`pushCheckDedupe`).
- **D12, D11, D10**: D's first 12, 11 and 10 items.

**Rule.** The arm that reads fewest items among those that pass goes to Pi. An arm passes if its $ a check is at
most 0.80 of W's in the same run, and against W: planted named on hidden rows at least W − 4, the look-alike named
on control rows at most W + 4, and neutral rows given any yes at most W + 4. None passes: no Pi run, the switch and
its code are deleted, the findings kept.

### 1b. The Pi pair (only if an arm passes; its exact command is an addendum committed before its first call)

`pi-ab`, P3's recipe as M13's (`packages/sim/lab/m13/pi.sh`): Haiku 5.5 agent, grader, card, reader and check
models, cards replayed, `--tenant-prompt`, payload notices, the `direct` profile; `eden` against `eden~D` (the arm's
settings). **Bar:** hidden facts raised, template-clustered 95% lower bound above −1.5 points (Sonnet regrade of the
hidden answers if the Haiku grade's bound falls under it); Sonnet-confirmed concerns on control and neutral not up;
the check's $ per 1,000 tasks at least 20% lower (or its wait 20% lower) on the pair's own ledger. Pass: the arm's
settings join `DEFAULT_CONFIG` (D814). Fail: the switch, its code and tests are deleted.
