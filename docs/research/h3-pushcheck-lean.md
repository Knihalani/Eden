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

## 2. The screen's result, and the Pi pair's addendum (before its first call)

**Screen** (`split-screen.ts`, base42's recorded pools re-asked live, 553 rows with a recorded answer: 189 hidden,
183 control, 181 neutral; five arms interleaved, 16 lanes; $0.000234 a check for W):

| Arm | $ a check (vs W) | Wall p50 / p90 s | Planted named | Look-alike named | Neutral with a yes | Items named | Unreadable |
| --- | --- | --- | --- | --- | --- | --- | --- |
| W (shipped) | 0.000234 | 0.89 / 1.34 | 149 | 36 | 53 / 179 | 598 | 7 |
| D | 0.000204 (−12.8%) | 0.87 / 1.23 | 153 | 36 | 44 / 179 | 474 | 5 |
| D12 | 0.000194 (−17.1%) | 0.87 / 1.24 | 150 | 34 | 49 / 178 | 490 | 7 |
| D11 | 0.000184 (−21.4%) | 0.86 / 1.19 | 152 | **41** | 52 / 181 | 484 | 0 |
| D10 | **0.000175 (−25.2%)** | 0.86 / 1.21 | 151 | 35 | 52 / 180 | 452 | 7 |

D12 fails the cost clause (bar 0.000187), D11 the look-alike clause (41 against a ceiling of 40). **D10 passes**
every clause and goes to Pi as `pushCheckDedupe: 10`.

**Pi pair, exactly** (`packages/sim/lab/h3/pi.sh LABEL 10 …`, one process a run, two at a time, in this order):
`train` and `reworded` (`--suite train` / `--suite reworded`), seeds 41, 42, 43, 44 (`--seeds N`),
`--variants hidden,control,neutral`; 8 runs. Then `bun packages/sim/src/lab/i3-regrade.ts --results <the runs'
out.json> --conditions eden,eden~D --spend-ledger .local/h3/ledger.jsonl --spend-cap 15 --run-label h3-sonnet`, and
`python3 -I packages/sim/lab/p3/report.py --pair eden~D:eden --cluster template <run dirs>`. If the deadline (04:00
UTC) would cut the run, the pair is read on whole seeds (both suites) finished by 03:00 UTC, the rest unrun.

Read (§1b's bar): hidden raised (Sonnet), D − default, clustered lower bound > −1.5 points; Sonnet-confirmed concerns
(control and neutral) not up; the check's $ per 1,000 tasks from the pair's ledger (role `eden.check`, by arm) at
least 20% lower. Reported beside it: the check's p50 and p90, Eden's and the agent's $ per 1,000 tasks, wall, asks.

Amended before any result was read: pi-ab's per-process cap defaults to $0.60, about one run's cost (M13: $0.62–0.65
a run), so the first two runs were stopped after about 30 seconds and restarted with `--budget 1.2` (`pi.sh`); their
partial output was deleted unread.
