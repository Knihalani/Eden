# S2: false concerns and the no-model rule paths (RealUse-1 weak point 2)

Status: results, 2026-11-07. Plan: [realuse-1-weak-points.md](realuse-1-weak-points.md) issue 2. Decisions D195–D197.

**Spent: $SPENT** (ledger `.local/ledger.jsonl`, every label `s2-*`; Anthropic direct, `claude-haiku-5-5` in every
role, `OPENROUTER_API_KEY` unset, `--spend-cap 4 --spend-headroom 0.3`). Lab transport (D97), not the shipped
OpenRouter route.

## The question

Held-out 10–13 false concerns went from 0.6% (agent alone) to 3.1% with Eden, and in the $0 funnel 68 of 137 decoys
surfaced came from rule paths that deliver before the reader reads (D151, D173). Which rule paths cost more decoys
than they find hidden facts, and does removing, vetoing or labelling them lower false concerns live?

## 1. Per-rule precision with the paid reader ($0)

LAB.md recipe 2a (the shipped default on train1–6, seeds 41–42, Haiku reader replayed; 651 replayed, 0 missed;
TOTAL hidden 311/384, decoys 137/384, as recorded). The funnel now prints this table after the D173 split
(`rulePrecisionLines`, `ask-coverage.ts`). Planted items each rule path delivered, hidden/decoys:

| rule path            | all (flagged or not) | unflagged (what the rule adds) | read and not flagged (what a reader veto removes) |
| -------------------- | -------------------- | ------------------------------ | ------------------------------------------------- |
| grounded-conflict    | 60 / 32              | 12 / 28                        | 3 / 26                                            |
| fallback             | 8 / 19 *             | 3 / 19 *                       | 0 / 15 *                                          |
| sources (sure)       | 10 / 9               | 2 / 9 *                        | 2 / 7 *                                           |
| anticipated-conflict | 6 / 4                | 2 / 4 *                        | 0 / 2 *                                           |
| grounded-clash       | 6 / 2                | 0 / 2 *                        | 0 / 2 *                                           |
| grounded-card        | 2 / 3 *              | 1 / 3 *                        | 0 / 3 *                                           |
| grounded-graph       | 3 / 1                | 0 / 1 *                        | 0 / 1 *                                           |
| anticipated-clash    | 2 / 0                | 0 / 0                          | 0 / 0                                             |
| cache (fast path)    | 0 / 2 *              | 0 / 2 *                        | 0 / 2 *                                           |

\* decoys outnumber hidden finds. Counted on rows with a delivery (`why` the delivering injection's kind; the reader's
own push left out); "flagged" is the request's last reading (the funnel's ask), so the columns are attribution, not
counterfactuals. Every rule path's marginal finds (unflagged) are decoy-heavy; across all rule paths the reader read
and did not flag 5 hidden facts against 58 decoys.

## 2. The trials and their $0 screens

Three D112 trial switches, off by default (owner repo owner, end 2026-12-07; trials table rows added in this branch):

- **`ruleVeto`** (+ `ruleVetoNamed`): a lookup's rule-path delivery (sure, a no-model ground, the fallback) for a
  request the reader push reads waits for that reading; items it read and did not flag (named: rejected by name) are
  left out; no reading (gated, late, failed) passes everything. The push's call is paid anyway: no extra model call.
  This is D151's "hold rule deliveries until the reader answers", built and measured.
- **`rulesOff`**: retire named rule paths (`RULE_PATHS`).
- **`ruleLabel`**: a rule path's packet says in its envelope it was matched, not read (`RULE_BASIS`).

Screens on recipe 2a (each `--set` against the 311/137 baseline; reader misses topped up live, ledger `s2-veto-topup`,
5 calls, $0.0019):

| arm                          | hidden  | decoys  | note                                               |
| ---------------------------- | ------- | ------- | -------------------------------------------------- |
| default                      | 311     | 137     |                                                    |
| `ruleVeto`                   | 306     | 95      | −5 hidden (all read and unflagged), −42 decoys     |
| `ruleVeto` + `ruleVetoNamed` | 306     | 95      | the same on train: the reader names its rejections |
| `rulesOff: [fallback]`       | 311     | 125     | −12 decoys, no hidden loss                         |
| `rulesOff: [grounded-card]`  | 311     | 142     | worse: the fallback answers instead                |
| `rulesOff: [sources]`        | 311     | 136     | neutral                                            |
| veto + no fallback           | 306     | 97      | the veto already removes the fallback's decoys     |

`ruleLabel` changes no delivery, so it has no $0 screen. The named veto (the narrower one, D130's shape), the fallback
retirement and the label went to the live run.

## 3. Live: Pi on Haiku

Pi harness, every role `claude-haiku-5-5` via the lab provider, `--config default`, direct market profile,
`--push signals`, time scale 1, default 3,000 ms first-observe wait, cards and intent replayed (caches topped up as in
RealUse-1 part B: ledger `s2-enrich`, $0.0279). One seed per process, three conditions in each process
(`eden`, `eden+ruleVeto+ruleVetoNamed`, `eden+ruleLabel`) so every comparison is paired by task. Held-out 10–13
seeds 41–42 plus held-out 13 seeds 43–44 (320 tasks per kind), held-out 14 seeds 41–44 with neutral (128 per kind).
0 errors, 0 ungraded, `overBudget: reader 0, cards 0` in every run. Held-out 15 was not run. Paired bootstrap 95%
intervals (10,000 resamples over tasks, `packages/sim/lab/fix-s2/analyze.py`; summary `live.json`):

| suites (n per kind) | measure                   | eden  | veto (named) − eden       | label − eden              |
| ------------------- | ------------------------- | ----- | ------------------------- | ------------------------- |
| held-out 10–13 (320) | hidden facts raised      | 73.1% | −1.6 (−5.6..+2.5)         | −1.3 (−5.3..+2.8)         |
|                     | false concerns (control)  | 3.1%  | 0.0 (−1.6..+1.6)          | −0.6 (−2.2..+0.9)         |
|                     | items injected, control   | 0.77  | 0.60                      | 0.73                      |
| held-out 14 (128)   | hidden facts raised       | 75.0% | **−9.4 (−17.2..−1.6)**    | −3.9 (−10.9..+3.1)        |
|                     | false concerns (control)  | 0.8%  | 0.0 (−2.3..+2.3)          | −0.8 (−2.3..0.0)          |
|                     | neutral concerns          | 2.3%  | −0.8 (−3.9..+1.6)         | −0.8 (−3.1..+1.6)         |
|                     | wall, neutral (s)         | 5.89  | **+0.36 (+0.03..+0.71)**  | −0.05 (−0.42..+0.30)      |

Eden's per-task $ moved by under $0.04/1k in either arm (intervals span 0), so neither costs more.

**Reading.** The veto does what the funnel says to the packet (a fifth fewer decoy items on controls) and nothing to
false concerns: the agent was already dismissing those items. What it removes that mattered were right items the
reader rejected by name (foodbank-shift and teatime-visit lost on both seeds of held-out 10, one fewer item each), and
the hold costs wall time where Eden has nothing to add. The label moved nothing measurable.

FALLBACK_SECTION

## Outcomes

OUTCOMES

## Reproduce

```bash
gunzip -c packages/sim/lab/distilled/reader-haiku-train-4142-intent.jsonl.gz > .local/reader-haiku-train-4142-intent.jsonl
R="--reader replay --reader-model claude-haiku-5-5 --reader-cache .local/reader-haiku-train-4142-intent.jsonl"
bun run funnel --jobs 4 --allow-misses --json .local/haiku-default.json -- $R          # prints the per-rule table
# the trial screens were run on the branch tip before deletion (commit 6659406b):
bun run funnel --jobs 4 --allow-misses --set '{"ruleVeto":true}' -- $R
# live: one process per suite and seed (.local/s2/run.sh), e.g.
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite heldout14 --seeds 41 \
  --variants hidden,control,neutral --conditions eden,eden+ruleVeto+ruleVetoNamed,eden+ruleLabel --config default \
  --cards .local/s2/enrich/cards-merged.jsonl --intent .local/s2/enrich/intent-v2.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push signals --budget 1.5 \
  --spend-ledger .local/ledger.jsonl --spend-cap 4 --spend-headroom 0.3 --run-label s2-h14-41 --out .local/s2/pi/h14-41.json
python3 -I packages/sim/lab/fix-s2/analyze.py out.json h10_13=<h10..h13 files> h14=<h14 files>
```

Card and intent caches were topped up as in [realuse-1/B-pi-continuity.md](realuse-1/B-pi-continuity.md)'s
Reproduce (held-out 10–13 seeds 41–42 and 13 seeds 43–44, held-out 12 intent), into `.local/s2/enrich/`. A container
restart killed held-out 14 seeds 43–44 mid-run (labels `s2-h14-43`, `s2-h14-44`, $0.081 spent, results lost); they
were re-run whole (`s2-h14-43b`, `s2-h14-44b`).
