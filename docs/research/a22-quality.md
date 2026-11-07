# A22: a line saying what each candidate shares with the request, and how noisy the intent requests are

Status: 2026-11-07, branch `claude/a22-link-line` (from `claude/lucid-hypatia-v9wqk5` at `2ce886c6`), audit wave
session A22 ([audit-1107-plan.md](audit-1107-plan.md)), after [a15-retrieval.md](a15-retrieval.md),
[a12-quality.md](a12-quality.md) and [a2-quality.md](a2-quality.md). Decisions D360–D362. Every paid call went to the
Anthropic API with `HAIKU_API_KEY` (`claude-haiku-5-5` as agent, grader and card model; `claude-sonnet-5-5` only for
regrades) through the lab provider (D97), `OPENROUTER_API_KEY` unset, on one ledger (`.local/a22/ledger.jsonl`, hard
cap $2.5): **Anthropic-direct lab figures**. Train only (seeds 41–44); no held-out suite was run. **Spent: $1.580**
(`packages/sim/lab/a22/spend.txt`). Every number below comes from a command run in this session.

## In plain words

- **The idea (A15's closing suggestion).** Since D237 the agent judges Eden's five candidates itself. A line on each
  candidate saying what Eden matched it on ("Eden: links to the request: Riverside Motors; names 18 Nov", or "18 Nov
  is inside dates it states" for "closed 14–22 November") costs no model call and about 75 bytes a packet, and might
  let the agent judge faster and better. Built as trial `linkLine` (D360) from the anchors `settle.ts` already reads.
- **It did not help, so it is deleted.** On Pi, eight runs (short, the 91 targeted templates over four seeds, and
  eight-day users), hidden facts raised, with Sonnet checking every answer Haiku called a miss: **−1.3 points (−4.5..
  +1.9, n 531)**; on the powered targeted set alone **−0.5 (−4.4..+3.3, n 364)**. False concerns after Sonnet's
  regrade: **+0.0** (n 861). Cost level (−$0.005 per 1,000 targeted hidden tasks, −0.018..+0.008; +$0.004 on the
  short mix, −0.012..+0.020; connectors unchanged).
- **Why not:** the line can't tell the planted fact from its look-alike (both share the request's names by
  construction: the planted item carries a link in 153 of 253 hidden packets, the look-alike in 145 of 217 control
  ones), and it makes the agent **ask less** (asks a task 0.61 → 0.52 on hidden, 0.74 → 0.66 on control). Facts the
  agent found only by asking fell from 19 to 13 on the targeted runs, while facts raised from the packet stayed level
  (226 → 227 of 275). It is D257's lesson again: anything that makes the packet look settled costs the asks that
  find what the push missed.
- **How noisy the intent requests are (D361).** Asking the card model again for every train item's requests, with
  the shipped prompt and full coverage ($0.199), moved the $0 funnel from 314/273 (hidden/decoys of 384) to 307/281:
  **43 hidden tasks changed (18 up, 25 down) and 34 decoy tasks (21 up, 13 down)** from the sample alone. A15's D332
  said this provisionally from a longer prompt; it holds with the shipped one. The second sample is now checked in
  (`intent-v2-draw2.jsonl.gz`), so an intent screen can report both.
- **Which earlier small deltas were real**, re-screened on both samples: `cardsLean` off loses hidden facts on both
  (−9 and −13: real, D318 stands); `intentByKind` off loses 3 on both (consistent, small); taking the nudge out costs
  9 hidden on the shipped sample but 3 on the new one, so the nudge's $0 deeper look is worth 3–9 tasks, not 9 (its
  live gain, D317, came through the agent's asks and is unaffected); A15's pushReach slots (+7) and A12's single-sample
  intent figures sit inside the 43-task churn and were not re-screened (pushReach is deleted).

## 1. The trial (D360)

`settle.ts` `linkOf(item, anchors)`: the request's entities the item names (at most three, 40 characters each, the
request's own words, never the item's), and its day: "on 18 Nov" (an event starting that day), "names 18 Nov" (the
date written out), or "18 Nov is inside dates it states" (a range such as "14–22 November" in the item). Rendered as
`Eden: links to the request: … | ` before the candidate's title, through `safeLine` (one line, `|` made `/`), and
dropped by `shownText`. Only on the push's candidates packet; nothing when the item shares nothing. The code is in
commit `3a3e51b9` (`settle.ts`, `render.ts`, `partner.ts`, `config.ts`, `link-line.test.ts`).

### $0 screens

`bun run funnel --jobs 4` with and without `--set '{"linkLine":true}'`: identical, 314/273 (the line changes
words, not what is delivered). `--packets` with the trial on (`packages/sim/lab/a22/linkscreen.py`,
`linkscreen.txt`): of 1,581 candidate lines on hidden tasks 588 carry a link (1,584 and 598 on control); the planted
item carries one in 153 of the 253 hidden packets that hold it, the look-alike in 145 of 217 control packets. Packet
size 1,566 → 1,641 bytes on average (635 candidate packets). `bun run eval` on the final tree (the trial deleted):
precision 0.591, recall 0.52, falseFireRate 0, as before (the switch was off in the default throughout).

### Live, Pi

`packages/sim/lab/a22/run.sh LABEL payload eden,eden+linkLine …`: A15's harness (Haiku agent and grader, cards and
intent replayed, direct connector profile, payload notices, time scale 1) with the tenant's house rules in every arm
(`--tenant-prompt`, D271); both arms in one process, paired by task. Sonnet regraded every control and neutral
concern (`--only-concerns`) and every Haiku miss on hidden tasks (`--only-misses`); "Sonnet-corrected" below takes
Sonnet's verdict on a Haiku miss and keeps Haiku's "raised" (`a22/hidden.py`; A12 found Sonnet agreed with 172 of 180).

| Runs | n hidden | Hidden, Sonnet-corrected | Hidden, Haiku | Concerns, regraded (n) | $/1k (hidden; mix) | Asks a task (hidden) |
| --- | --- | --- | --- | --- | --- | --- |
| short, `--limit 12`, seeds 41–42, hidden/control/neutral | 144 | 0.729 → 0.715, −1.4 (−7.6..+4.9) | −2.1 (−9.0..+4.9) | +0.0 (288) | −0.003; mix +0.004 (−0.012..+0.020) | 0.51 → 0.45 |
| targeted (A2's 91 templates), seeds 41–44, hidden/control | 364 | 0.714 → 0.709, **−0.5 (−4.4..+3.3)** | −1.4 (−5.5..+3.0) | +0.0 (364) | −0.005 (−0.018..+0.008) | 0.61 → 0.52 |
| long, `--days 8`, users 41–42 | 23 | 0.696 → 0.565, −13.0 (−30.4..+4.3) | −17.4 (−39.1..+0.0) | +0.0 (209) | all-in 0.250 → 0.251 | |
| **all eight runs** | **531** | **0.718 → 0.704, −1.3 (−4.5..+1.9)** | −2.3 (−5.8..+1.3) | **+0.0 (861)** | | |

Where the planted item reached the agent on the targeted runs (`a2/uptake.py`, Haiku-graded raised of reached):
packet 226/275 → 227/275, ask only 19/26 → 13/23, neither 0/63 → 0/66. Wall time a task −0.05 s (−0.13..+0.04) on
hidden, −0.09 s (−0.17..−0.01) on control: fewer asks. Eden's critical path level (18 ms both). Connectors over a
user's days (`pi-cost-report`, all-in on the 1:1:8 mix, $ per 1,000 tasks): first-party 0.250 → 0.251, Composio
0.343 → 0.344, Zapier MCP 8.257 → 8.257; Eden's connector calls 0 a task in both arms (background 0.16). Tables:
`packages/sim/lab/a22/{short-arms,tgt-arms,long-cost,uptake,pooled}.txt`.

Not better on its axis (hidden level-to-lower, the asks it suppresses are where the nudge's gain lives), so D112
deletes it.

## 2. The intent requests, re-drawn (D361)

`cards-enrich.ts --funnel train --seeds 41,42 --intent` with the shipped prompt (`INTENT_VERSION` 2, Haiku 5.5): 3,541
items, 3,538 with a line after three top-ups at `--batch 3` (the model drops a few items from ten-item batches; a first
pass covered only 345 of 384 planted items and read 289/272). `packages/sim/lab/a22/intent-spread.txt`:

| `--set` | shipped sample: hidden / decoys (+ −) | draw2: hidden / decoys (+ −) |
| --- | --- | --- |
| default | 314 / 273 | 307 / 281 (against shipped: hidden +18 −25, decoys +21 −13) |
| `cardsLean` false | 305 / 265 (h +7 −16, d +8 −16) | 294 / 271 (h +5 −18, d +9 −19) |
| `intentByKind` false | 311 / 273 (h +1 −4, d +1 −1) | 304 / 280 (h +0 −3, d +1 −2) |
| both | 302 / 263 (h +6 −18, d +9 −19) | 289 / 271 (h +5 −23, d +9 −19) |
| `askNudge` false | 305 / 267 (h +0 −9, d +0 −6) | 304 / 275 (h +0 −3, d +0 −6) |

Reading it: a lever's delta measured on one sample is not its delta (the nudge's deeper look, +9 on one, +3 on the
other); a delta that keeps its sign and size on both is (`cardsLean`). The default itself moves 7 hidden and 8 decoys
between two draws of the same prompt, so a lever on the intent index that moves the funnel by fewer than about 10
tasks on one sample is not yet a result.

## 3. Decisions

- **D360** trial `linkLine` (owner: the repo owner via A22; entered and ended 2026-11-07): rejected and deleted.
- **D361** a re-draw of the intent requests with the shipped prompt moves 43 hidden tasks; D332 is no longer
  provisional; the second sample is checked in and intent-index levers are screened on both.
- **D362** lab only: `packages/sim/lab/a22/` (run and regrade scripts with `--tenant-prompt`, `hidden.py` for the
  Sonnet-corrected paired hidden rate, `linkscreen.py`), `intent-v2-draw2.jsonl.gz`.

## Next most valuable step

A2, A12, A15 and this note all point the same way: what moves hidden facts live is the agent asking, and anything that
makes the packet look more settled (a "nothing found" note, more items, a stated link) lowers the asks. The lever left
is on the ask's side: what the ask answers when the nudge fires (its deeper look reads the pool's 6th–15th by anchor;
it could read the intent index at a looser bar, A15's idea 9, where a loose match costs a seat in an answer the agent
asked for, not in the packet).

## Reproduce

```bash
cat packages/sim/lab/cards/cards-{v2,train,train-4344}.jsonl > .local/a22/cards-all.jsonl
git checkout 3a3e51b9        # the trial
bun run funnel --jobs 4 --json .local/a22/base.json
bun run funnel --jobs 4 --set '{"linkLine":true}' -- --packets $PWD/.local/a22/packets-link.jsonl
python3 -I packages/sim/lab/a22/linkscreen.py .local/a22/packets-link.jsonl
L=packages/sim/lab/a22/run.sh; T=$(cat packages/sim/lab/a2/targeted-templates.txt)
$L a22-short-41 payload eden,eden+linkLine --seeds 41 --variants hidden,control,neutral --limit 12 --budget 0.3  # and 42
$L a22-tgt-41 payload eden,eden+linkLine --seeds 41 --variants hidden,control --templates $T --budget 0.4       # 41..44
$L a22-long-41 payload eden,eden+linkLine --seeds 41 --days 8 --budget 0.2                                      # and 42
R=packages/sim/lab/a22/regrade.sh
$R a22-tgt-41 regrade-a22-tgt-41 --only-concerns; $R a22-tgt-41 miss-a22-tgt-41 --only-misses                  # each run
python3 -I packages/sim/lab/a22/hidden.py eden+linkLine eden .local/a22/runs/a22-tgt-4{1,2,3,4}
python3 -I packages/sim/lab/cl8/pooled.py eden+linkLine eden .local/a22/runs/a22-tgt-4{1,2,3,4}
python3 -I packages/sim/lab/cl4/arms.py --arms eden,eden+linkLine .local/a22/runs/a22-tgt-4{1,2,3,4}
python3 -I packages/sim/lab/a2/uptake.py .local/a22/runs/a22-tgt-4{1,2,3,4}
bun packages/sim/src/lab/pi-cost-report.ts .local/a22/runs/a22-long-41.json .local/a22/runs/a22-long-42.json
# the re-draw (repeat with --batch 3 until no item is left to enrich), then each lever on both samples:
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cards-enrich.ts --dir .local/a22/redraw --funnel train \
  --seeds 41,42 --intent --model claude-haiku-5-5 --spend-ledger .local/a22/ledger.jsonl --spend-cap 2.5 --cap 0.5
zcat packages/sim/lab/distilled/intent-v2-draw2.jsonl.gz > .local/a22/draw2.jsonl
bun run funnel --jobs 4 --intent $PWD/.local/a22/draw2.jsonl --set '{"cardsLean":false}' --json OUT.json
python3 -I packages/sim/lab/a15/score.py BASE.json OUT.json
```

## Caveats

- Train only; the held-out suites were not run. The long runs have 23 hidden tasks.
- "Sonnet-corrected" keeps Haiku's "raised" unchecked (A12's sample agreed 172 of 180).
- The link's wording was chosen once, not tuned; a line that also said what the request turns on would need the
  item's meaning, which is the reader's job (D237 removed it from the push).
- **Review findings on the measured trial code (commit `3a3e51b9`), recorded rather than re-run:** (1) the link was
  computed on the candidate's compacted excerpt, not the whole item (`renderPacket` cuts the text before calling
  `link`), so an item naming the request's entity only past the cut got no line, and the 153/253 and 145/217 counts
  are over excerpts; `askNudge`'s `settles` reads whole items. (2) "names 30 Oct" came from `namesDay`, which also
  matches a bare ordinal ("the 30th") and ignores the year, so the line could claim a date the item does not name in
  Eden's own voice. (3) The comment's byte bound was wrong: three 40-character entities of multi-byte text can make
  the line 500+ bytes, past the packet's 400-byte slack (the measured mean was +75 bytes a packet). None of these
  could turn the measured shape around (more links would, if anything, suppress more asks), but a revival computes
  the link on the whole item, claims only a written day and month in the right year, and bounds the line in bytes.
- Haiku-graded per-set intervals in §1 are `cl8/pooled.py`'s bootstrap (`pooled.txt`); `cl4/arms.py`'s tables use
  their own (targeted hidden −1.4, −5.8..+3.0, in `tgt-arms.txt`).
- The intent spread is one re-draw: two samples bound the noise, they do not measure its distribution.
