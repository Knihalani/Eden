# A2: quality under the candidates default

Status: 2026-11-07 (audit wave A, session A2; plan: [audit-1107-plan.md](audit-1107-plan.md)). Decisions D266–D270.
Every paid call went to the Anthropic API with `HAIKU_API_KEY` through the lab provider, on the ledger
`.local/a2/ledger.jsonl` (cap $3): **Anthropic-direct lab figures**, not the OpenRouter route the servers ship. Train
only (seeds 41–42); no held-out suite was run.

## In plain words

- **Where hidden facts are lost under the default** (the agent judges up to 5 candidate excerpts, no reader call):
  1. **The fact never reaches the agent** (about 13% of hidden tasks live, 79 of 384 in the $0 funnel). In the funnel,
     29 of those 79 are in the push's 15-item pool but ranked 6th or lower (the old reader read the whole pool and
     flagged 24 of them: this is the −4 to −5 points against the reader setup), and 50 are not in the pool at all
     (retrieval and intent misses the reader setup shares: an intent request not yet written when the request
     arrives, or under the match thresholds).
  2. **The fact is in the packet and the answer does not raise it** (16 of 140 targeted tasks, 17 of 109 short ones).
     About half of these are the Haiku grader missing a fact the answer states: a Sonnet regrade of the 38 such answers
     in the targeted runs (default and lift arms) called 18 raised. Some of the rest are excerpts that cut the fact
     (the planted line keeps 93% of the fact's words on average; 38 of 253 lines keep less than 80%).
  3. **Look-alikes**: of the 13 concerns a Sonnet regrade kept over every arm and run, 10 are one template,
     `restricted-datastore-grant`, where the answer correctly says the decoy's access request was approved and the
     grader still counts it; the others are `publicity-consent-register`, `support-cover-clash` (control) and
     `energy-fix-exit-fees` (neutral), once each.
- **Three fixes were built, screened at $0 and run live; none raised the hidden-fact rate, so all three are deleted**
  (code in commit `d096b7ba`):
  - **Re-ranking the candidates with no model** (one item per title, items naming the request's date moved up): the
    planted item reached the packet more often, in the funnel (+11 of 384 hidden, +6 decoys) and live (140 → 149 of
    182 targeted tasks), but the facts raised did not move: **−0.6 points pooled over six runs (−4.6..+3.4, n 349)**.
  - **Asks that skip what the agent already holds**: +17 hidden in the funnel, but the answers doubled in size, cost
    rose (+$0.021 per 1,000 tasks on the mix, −0.001..+0.041; neutral +$0.027, +0.000..+0.052) and hidden did not
    rise (−0.7, −6.9..+6.2).
  - **Excerpts that keep the constraint sentence first**: the fact's words kept rose a little (0.929 → 0.940), hidden
    did not (−2.7, −8.2..+2.7).
- **Why a packet gain does not show up live:** the agent raised a fact in the packet about 9 times in 10 either way, and
  the gain is a few tasks in a hundred; at these sample sizes a 3-point effect is inside the noise of one run, and the
  ask path (facts the agent finds by asking) moved the other way in some runs. The funnel's "surfaced" count is an
  upper bound on what the agent says, not a forecast.
- **A stronger agent:** Sonnet 5.5 as the Pi agent on 29 paired tasks raised the same hidden facts as Haiku (11 of 14),
  used the look-alike correctly on the one control its grader flagged, and cost about 30 times as much a task. The
  candidates hold with it; the sample is small.
- **Nothing in the shipped default changed**, so its cost is the CL wave's: the default's short 1:1:8 mix here was
  $0.374 per 1,000 tasks on seed 41 and $0.376 pooled over seeds 41–42 (CL's blind short figure was $0.378 on
  heldout16, another suite: a sanity check, not a pair).

## 1. The $0 screen: where planted items go

`bun run funnel` on train (cards and intent replayed, reader stub) with two diagnostics added for this session:

- each push pass now reports its candidate pool to a lab hook (`onPushPool`: the pool's ids in order, `readerGate`'s
  constraint test per item, the ids it handed; no content), and each funnel row says where the planted item sits in
  it (`pushPoolAt`, `pushHanded`: hidden in the pool 283/384, handed 253);
- `hidden-funnel.ts --pool-dump FILE` writes each task's pool with each item's title, text, card and flags (handed,
  automated sender, `readerGate`'s constraint test) and the planted item's place.

| | hidden surfaced | decoys surfaced |
| --- | --- | --- |
| default (candidates) | 305/384 | 267/384 |
| reader default (`--preset minus-candidates`, recipe 2a, 0 misses) | 322/384 | 139/384 |

Task by task, 24 hidden tasks are surfaced only with the reader and 7 only with candidates; all 24 are planted items
the reader flagged at pool rank 5 or lower. Planted rank in the pool (hidden, 384 tasks): 0: 154, 1: 63, 2: 21, 3:
12, 4: 6, then 31 at ranks 5–12; 35 not in a pool, 62 with no pool. `--ask-diag` splits the planted items no ask
reaches: no intent request held at the ask (the card was not yet written), coverage under `intentMinCoverage`, no
shared term (fix-s3a's buckets).

What sits above the planted item at ranks 5+ (`packages/sim/lab/a2/sim.py`, `feat.py` over the dump): repeated
titles (a weekly "Focus time", four "Expense policy" mails), calendar entries of other days, promotional mail. Demoting
automated senders would lose 30 planted items that are themselves automated (a pharmacy's "prescription ready", a
club's "membership expired"); constraint-worded or carded first loses as CL6 found (199 against 253 in the first
five). The rule that held across every parameter tried: one item per title, then up to two items naming a date the
request names after the first three (253 → 264 planted, 219 → 225 decoys, same item count).

Excerpts (`--packets`, `cl8/screen/keep.py`): the planted line keeps 0.929 of the fact's words on average, 189 of 253
lines all of them. Counting a part that may state a constraint (`mayConstrain`) 1.5 more when an excerpt is cut gave
0.940 and 197 (14 lines better, 6 worse); weights 1, 2 and 3 gave 0.929, 0.937, 0.938.

Full table: `packages/sim/lab/a2/funnel-screen.txt`.

## 2. Live (Pi, Haiku 5.5 agent and grader, payload notices, direct profile, time scale 1)

Arms over `default` (`packages/sim/lab/a2/run.sh`): `lift` (`pushCandidateLift`), `past` (`askPastShown`), `both`,
`ls` (lift and `pushCandidateStress`). Runs: short (one request a session, `--limit 12`, hidden/control/neutral,
seeds 41 and 42, 864 runs each), targeted (the 91 templates whose handed set the lift changes in the funnel, seeds 41
and 42, 819 runs each), long (`--days 8`, users 41 and 42). Tables: `short-pay-arms.txt`, `tgt-pay-arms.txt`,
`long-pay-arms.txt`; pooled pairs (`cl8/pooled.py`, concerns regraded by Sonnet with `--only-concerns`): `pooled.txt`.

| pair | runs | hidden raised (points) | concerns, regraded (points) | $/1k mix |
| --- | --- | --- | --- | --- |
| lift − default | short ×2, targeted ×2, long ×2 (n 349) | −0.6 (−4.6..+3.4) | +0.0 (−0.5..+0.5) | short +0.000 (−0.019..+0.019); targeted −0.010 (−0.028..+0.008); long +0.006 (−0.003..+0.014) |
| ls − default | targeted ×2 (n 182) | −2.7 (−8.2..+2.7) | +0.5 (+0.0..+1.4) | −0.014 (−0.031..+0.004) |
| past − default | short ×2 (n 144) | −0.7 (−6.9..+6.2) | +0.0 (−1.0..+1.0) | **+0.021 (−0.001..+0.041); neutral +0.027 (+0.000..+0.052)** |
| both − default | short ×2 (n 144) | −3.5 (−9.7..+2.8) | −0.3 (−1.4..+0.7) | **+0.021 (+0.001..+0.042)** |

Where the planted item reached the agent (`uptake.py`; packet = cited by a packet the agent saw, ask = only by an
`ask_context` answer; raised as Haiku graded it):

| | default: packet | ask only | neither | lift: packet | ask only | neither |
| --- | --- | --- | --- | --- | --- | --- |
| short, 144 hidden | 92/109 | 16/16 | 0/19 | 93/111 | 14/14 | 0/19 |
| targeted, 182 hidden | 124/140 | 8/10 | 0/32 | 127/149 | 5/8 | 0/25 |

The lift's packet gain is the funnel's (+9 of 182 targeted); the raised count does not follow it. The Sonnet regrade
of the in-packet misses (`regrade.ts --only-misses`, new; 38 answers, $0.054) called 8 of 16 (default) and 10 of 22
(lift) raised: corrected, 132 → 140 and 132 → 142, still level.

## 3. A stronger agent

`A2_MODEL=claude-sonnet-5-5 run.sh a2-sonnet-pay-41 payload eden --seeds 41 --variants hidden,control --limit 4`
(the Pi agent on Sonnet 5.5; pi-ai's "thinking disabled" is refused by Sonnet 5.5, so the lab now sends
`between_tools`, `anthropicThinkingOff` in free.ts). The $0.40 run cap stopped it at 35 runs, 29 graded and paired
with the Haiku agent's same tasks (`a2-short-pay-41`): hidden raised 11/14 both, planted item in the packet on the
same 11; control concerns 1/15 (Sonnet) against 0/15 (Haiku), the one being `rail-strike-leeds`, where the answer says
the strike was suspended and the date is safe to book (a grader error by reading). Agent cost $0.3586 against $0.0120
for the same 29 tasks (about 30×), output tokens 19,315 against 14,216.

## 4. Decisions

- **D266** `pushCandidateLift` rejected and deleted.
- **D267** `askPastShown` rejected and deleted.
- **D268** `pushCandidateStress` rejected and deleted.
- **D269** the attribution above, the lab's measurement changes (the candidates report, `--pool-dump`,
  `--only-misses`, `--conditions`), and the rule that a funnel gain in packet reach of this size is screened live on
  the tasks it changes (targeted `--templates`) before a full run.
- **D270** the Sonnet agent check: candidates hold with a stronger agent on this sample; no engine change.

## Next most valuable step

The 50 planted items that are in no pool (13% of hidden tasks, shared with the reader setup) are larger than the gap
these levers chased. Most have intent requests in the replay that were not yet held when the request arrived (the
card lands one request later) or match under `intentMinCoverage`. A screen of intent coverage at request time
(cards written at sync, not at first sight) is the next lever; it moves the funnel's pool, which the reader setup and
the candidates both read.

## Reproduce

```bash
cat packages/sim/lab/cards/cards-{v2,train,train-4344}.jsonl > .local/a2/cards-all.jsonl
bun run funnel --json .local/a2/base.json                                         # and --set '{...}' on d096b7ba
bun packages/sim/src/lab/funnel.ts --jobs 4 -- --pool-dump $PWD/.local/a2/pool.jsonl --packets $PWD/.local/a2/pk.jsonl
L=packages/sim/lab/a2/run.sh                                                      # the switches: commit d096b7ba
$L a2-short-pay-41 payload eden,eden~lift,eden~past,eden~both --seeds 41 --variants hidden,control,neutral \
  --limit 12 --budget 0.45                                                        # and 42
$L a2-tgt-pay-41 payload eden,eden~lift,eden~ls --seeds 41 --variants hidden,control,neutral \
  --templates $(cat packages/sim/lab/a2/targeted-templates.txt) --budget 0.5      # and 42
$L a2-long-pay-41 payload eden,eden~lift --seeds 41 --days 8 --budget 0.2         # and 42
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results R.json --graders claude-sonnet-5-5 \
  --only-concerns --spend-ledger .local/a2/ledger.jsonl --spend-cap 3 --out .local/a2/runs/regrade-NAME.json
python3 -I packages/sim/lab/cl8/pooled.py eden~lift eden .local/a2/runs/a2-{short,tgt,long}-pay-4{1,2}
python3 packages/sim/lab/a2/uptake.py .local/a2/runs/a2-tgt-pay-4{1,2}
```

## Spend (`packages/sim/lab/a2/spend.txt`)

| What | $ |
| --- | --- |
| short, four arms, seeds 41–42 | 0.784 |
| targeted, three arms, seeds 41–42 | 0.757 |
| long, two arms, users 41–42 | 0.210 |
| Sonnet agent check (35 runs) | 0.399 |
| Sonnet regrades (concerns, in-packet misses) | 0.120 |
| **Total** | **2.270** |

## Caveats

- Train only; the held-out suites were all read before this session. The funnel's re-rank rule was chosen on the same
  train pools it was measured on (it held across every parameter tried, but it is not a blind number).
- The targeted runs select the tasks a lever changes, so their rate is not the suite's; they compare arms on the same
  tasks.
- Hidden rates are Haiku-graded except where a Sonnet regrade is named; about half of Haiku's in-packet misses were
  grader errors in the sample regraded.
- The Sonnet check is 29 tasks, one seed.
