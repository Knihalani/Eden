# N1b: `sourceYield` on the powered bench (does skipping reads at 1,000 sources cost hidden facts?)

Status: measured 2026-11-10 on branch `claude/n1b-yield-bench` (from `claude/lucid-hypatia-v9wqk5` at 12307421, N1
merged). Decisions D540–D544. Paid calls: Anthropic API only, the Modal Secret `HAIKU_API_KEY`, `claude-haiku-5-5`
in every role, `claude-sonnet-5-5` for the concern regrade, lab provider (D97): **Anthropic-direct lab figures**,
not the OpenRouter route the servers ship. **Spent: $5.079 Anthropic** of the $6 cap (six Modal runs $5.050 from
their manifests, Sonnet regrades $0.028 from their ledger). **Modal: $0.93** billed for five of this session's six
apps (`modal billing report --for today`, read at 18:23 UTC; the smoke's one 158 s shard is not in that sum, and the
last hour may be incomplete). Train suites only; `heldout18` is not run or read. Section 0 was committed and pushed
(018586ee) before any paid call, section 0b (7d1cdd83) before run 4. **Result: `sourceYield` stays in the default
(D541). No engine code changed.**

## In plain words

- **The question.** `sourceYield` (D509) stops Eden reading sources that have not been paying, which at about 1,000
  connected sources cuts connector calls by a third to two thirds. N1's two live runs both read slightly below zero
  on hidden facts (−0.4 and −1.1 points) and could not have seen a loss smaller than 4.7. Does the rule cost facts?
- **The answer: no sign of it, at a resolution of under two points.** 28 train seeds, 2,632 paired hidden tasks,
  the default against the default with the rule off: **+0.5 points with the rule (−0.8..+1.8**, intervals
  clustered by template; 57.2% against 56.7%). The run would have found an effect of **1.8 points** (80% power). The
  rule written before the run keeps the switch if the interval's lower bound is above −2.0; it is −0.8. **Kept.**
- **N1's below-zero reading was the four seeds, not the rule.** On seeds 41–44 (N1's seeds, run again) the effect
  is again negative, −1.6 (−4.9..+1.6); on the 24 new seeds it is +0.9 (−0.4..+2.1). Both intervals hold zero.
- **Calls**, Eden's connector calls a task, paired: **37.3 → 26.9 one request a session** (−10.4, −11.2..−9.6, 2,538
  hidden tasks) and **35.6 → 11.7 over a user's eight days** (−23.8, −25.0..−22.7 on the 1:1:8 mix, 8 users).
- **Dollars per 1,000 tasks.** First-party, paired: +$0.002 (−0.001..+0.005), level. Priced per call (list prices,
  assumed; steady state): Zapier MCP **$1,050 → $751** one request a session and **$1,029 → $356** over days;
  Composio $12.78 → $9.36 and $12.45 → $4.60.
- **False concerns**, Sonnet-regraded, 1,223 control and neutral pairs: 2 with the rule, 1 without (+0.1 points,
  −0.2..+0.3). Wall time level (+0.02 s, −0.00..+0.04).

## 0. Pre-registration

**Why.** N1 promoted `sourceYield` (part `sync`, D509) into the default: at about 1,000 sources it cut Eden's
connector calls from 38.6 to 26.5 a task one request a session and from 35.9 to 11.1 over a user's days. Its hidden
effect was below zero in both live runs (−0.4 as first built, −1.1 as shipped, interval −4.3..+2.2, n 458), and the
run could only have found a loss of about 4.7 points. This run measures the same pair with F3's bench (D487) at
about six times the pairs.

**Harness.** Pi (`pi-ab.ts`), `--config default`, `--tenant-prompt`, market `direct` source profile, time scale 1,
`--push payload`, `--noise-sources 995 --notify-share 0.05`, `claude-haiku-5-5` as agent, grader, card model and
reader, cards `cards-v2` + `cards-train` + `cards-train-4344` and the checked-in intent requests replayed (they
cover seeds 41–44; on seeds 45–68 cards and their requests are made in-run by Haiku, D444). One seed a shard on
Modal: `lab_fanout.py --preset bench-yield` (new, `fanout_plan.PRESETS`), the planner's waves under 60 agent
streams, halved on retried 429s (D487). The image is the commit that holds this section.

**Arms** (one process runs both arms of its shard, paired task by task):

| arm | settings over the default |
| --- | --- |
| `eden` | none (the shipped default, `sourceYield` on) |
| `eden~off-yield` | `{"sourceYield":false}` |

The effect reported is **`eden − eden~off-yield`**: what the rule does. Negative hidden means the rule loses facts.

**Runs** (in this order; N1's shapes, so the two notes read against each other):

1. **Smoke**: train, seed 41, `--limit 2`, cap $0.05. Not in any result.
2. **Short, seeds 41–44**: `--limit 16 --variants hidden,control` (96 hidden and 96 control tasks a seed an arm).
   Cap $1.12 ($0.28 a shard; N1's same shards spent $0.19–0.22).
3. **Short, seeds 45–48**: `--limit 16 --variants hidden` (96 hidden tasks a seed an arm). Cap $0.72 ($0.18 a
   shard; the estimate is $0.11–0.13). This wave prices a seed whose cards are made in-run.
4. **Short, seeds 49–68**: the same shape, 20 shards, cap **at most $2.90** ($0.145 a shard), set from wave 3's
   measured cost a shard plus 20%.
5. **Long, seeds 41–46**: `--days 8`, one user a seed (about 132 requests a user: about 12 hidden, 12 control, 100
   neutral). Cap $1.02 ($0.17 a shard; N1's spent $0.11–0.15).
6. **Regrade**: every control and neutral answer the Haiku grader called a concern, both arms, runs 2 and 5, with
   `claude-sonnet-5-5` (`regrade.ts --only-concerns`); Sonnet's verdict replaces Haiku's. Cap $0.15.

So **28 short seeds, 2,688 hidden pairs**, and about 74 more over days, if every task finishes.

**Changes allowed, on cost alone and decided before the affected shards' results are read.** If wave 3 shows a
hidden-only seed costs more than $0.121 (so that run 4's 20 shards would not fit $2.90 with 20% to spare), seeds
are dropped from the top (68 downwards) and the note says how many. If, after runs 2–5 are paid for, at least $0.40
of the $6 is left beyond the regrade's $0.15, long seeds 47–48 are added (cap $0.17 a shard). A shard that hits its
cap stops early; its unfinished tasks drop from both arms' pair and the note says how many. Nothing else changes.

**Metrics** (paired by task; 95% intervals by bootstrap, 5,000 draws, **templates resampled as clusters**,
`bench_report.py`; pooled resamples a template with all its tasks on both horizons):

- **Primary: hidden facts raised**, Haiku-graded (D456: Sonnet does not move such a pair's effect), points, pooled
  over runs 2–5; per horizon and for seeds 41–44 against 45–68 beside it; the task-level and seed-clustered
  intervals, McNemar's exact test, the design effect and the run's **minimum detectable effect** (2.80 × the
  clustered standard error).
- Eden's connector calls a task in the task's window, short and long (1:1:8 mix), paired task-level bootstrap
  (`a8/pair.py`).
- $ per 1,000 tasks first-party (agent billed + Eden per task + background cards) with its clustered interval, and
  priced on market.py's connector plans (`pi-cost-report.ts`; list prices, assumed).
- False concerns on control and neutral tasks, Sonnet-regraded; wall mean; `ask_context` calls a task.

**Rule (written before any run; applied mechanically).**

- **Keep `sourceYield` in the default** if the pooled hidden effect's template-clustered 95% interval has its
  **lower bound above −2.0 points**.
- **Otherwise switch it off in `DEFAULT_CONFIG`** and keep it as an off trial (owner and end date in the trials
  table, D112), with the reason recorded: the bench could not rule out a loss of 2 points or more.

The rule reads the hidden effect only. Calls, dollars and concerns are reported beside it and do not enter it.

**What the run can and cannot show (arithmetic from N1's measured variance, before the run).** N1's short pair had
a half-width of 3.8 points at 384 pairs (design effect 1.0, about 13% of pairs discordant). At 2,762 pairs that
scales to about **±1.4 to ±1.6 points**, a minimum detectable effect of about 2.1. So the rule keeps the switch
only if the point estimate comes out above about −0.5: a true effect of zero passes about three times in four, a
true effect of −1 passes about one time in four, and a true loss of 2 points or more passes about one time in
forty. An "off" verdict therefore means "not shown safe at this size", not "shown to lose facts", and the note
will say which of the two the interval supports.

**Spend.** Anthropic hard cap **$6**; the caps above sum to $5.96. Modal under $6 (`modal billing report`; a 24 GiB
shard of about five minutes is about $0.03 at list prices, an estimate).

### 0b. Amendment (committed before run 4; on cost alone, no hidden result of any run had been read)

Runs 1, 2, 3 and 5 are paid: $0.020, $0.793, $0.534 and $0.805, **$2.152** in all; no request was retried on a 429.
Wave 3 priced a hidden-only seed with in-run cards at $0.129–0.138 (mean $0.134), above the $0.121 the
registration allowed for, and it showed something the registration had not counted: a shard stops when its
**committed** spend (booked calls plus the reservations of the calls in flight on its 12 streams, about $0.02)
reaches its cap less the 10% headroom. Seed 45 spent $0.138 and stopped 23 task runs short at a $0.18 cap; a cap of
"cost plus 20%" ($0.160, stopping at $0.144) would cut most shards' last templates.

Registered: drop seeds 67–68 and run 18 shards at $0.160 ($2.88). **Done instead: all 20 seeds (49–68) at wave
3's cap, $0.18 a shard ($3.60).** A shard cannot spend past $0.162, so run 4 cannot pass $3.24 and the session
cannot pass $2.152 + $3.24 + $0.15 (regrade) = $5.54 before the long seeds 47–48, which are added as registered only
if at least $0.40 is then left beyond the regrade (their two shards cannot spend past $0.306). The session's
Anthropic spend therefore stays under $6 by the shards' own stops, though the nominal caps now sum to more than $6.
This keeps the 28 seeds of the target and loses fewer tail tasks; it is a departure from the registered text and
is recorded as one. The rule, the arms, the metrics and every other shape are unchanged. Run 5 ran before run 4
(its cap did not depend on wave 3). Users 44 and 45 of run 5 reached their caps near the end: 10 and 15 task runs
were refused and drop from their pairs.

## 1. Runs

`packages/sim/lab/n1b/run.sh` (`lab_fanout.py --preset bench-yield`), 24 GiB shards, one seed each; the image is
commit 018586ee for runs 1–3 and 782a025c for runs 4–6 (the same engine and lab code; the second adds
`report.sh`). 23,910 model requests in the five result runs, **0 retried on a 429**; the halving rule never fired.

| run | seeds | shape | shards at once | task runs (refused at the cap) | $ | a shard |
| --- | --- | --- | --- | --- | --- | --- |
| smoke | 41 | `--limit 2`, hidden and control | 1 | 48 (6) | 0.020 | 158 s |
| short-41 | 41–44 | `--limit 16`, hidden and control | 2 | 1,536 (1 error) | 0.793 | 210–218 s |
| short-45 | 45–48 | `--limit 16`, hidden | 4 | 768 (25) | 0.534 | 183–194 s |
| long | 41–46 | `--days 8` | 6 | 1,470 (25) | 0.805 | 330–378 s |
| short-49 | 49–68 | `--limit 16`, hidden | 5 | 3,840 (136) | 2.625 | 174–206 s |
| long-47-48 | 47–48 | `--days 8` | 2 | 508 (52) | 0.274 | 371–375 s |
| regrade | | Sonnet, 21 answers Haiku called concerns | | | 0.028 | |

**Deviations from the pre-registration.**

- **Run 4's cap and seeds** (section 0b, committed before it ran): all 20 seeds at $0.18 a shard in place of 18 at
  $0.160. Its spend, $2.625, is under the registered $2.90.
- **Long seeds 47–48 were added** as registered: after runs 2–5 and the first regrade $4.79 was spent, $1.07 left
  beyond the regrade's reserve.
- **Cap hits.** 239 of 8,122 task runs (2.9%; 238 refused at a shard's cap, one error) drop from their pairs: 2,538 of
  2,688 short hidden pairs and 94 long ones remain. They are the last tasks of a stream in both arms. Users 47
  and 48 lost the most (52 runs of 508): their cap was the registered $0.17.
- **Order.** Run 5 ran before run 4. The regrade's script passed run 2's shards a second time when seeds 47–48
  were regraded, so its flagged answers were graded and paid for twice (the ledger holds 27 calls for 21 answers);
  the verdicts used are the last pass.
- No held-out suite was run or read. No result was read before the last shard of the run it belongs to was paid
  for, and no hidden effect before run 4 was started.

## 2. Hidden facts (`packages/sim/lab/n1b/bench.txt`, `bench-horizons.txt`; `eden − eden~off-yield`)

| scope | n pairs | templates | hidden, clustered | task-level | by seed | design effect | MDE | with / without |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **pooled (the rule)** | 2,632 | 135 | **+0.5 (−0.8..+1.8)** | −0.8..+1.8 | −1.2..+2.1 | 0.93 | 1.8 | 57.2 / 56.7 |
| short, 28 seeds | 2,538 | 96 | +0.5 (−0.7..+1.7) | −0.8..+1.8 | −1.2..+2.1 | 0.89 | 1.8 | 57.0 / 56.5 |
| short, seeds 41–44 (cards replayed) | 384 | 96 | −1.6 (−4.9..+1.6) | | | | | 61.5 / 63.0 |
| short, seeds 45–68 (cards in-run) | 2,154 | 96 | +0.9 (−0.4..+2.1) | | | | | 56.2 / 55.3 |
| long, 8 users | 94 | 77 | +1.1 (−7.9..+9.7) | −7.6..+9.7 | −8.4..+10.6 | 1.02 | 12.5 | 62.8 / 61.7 |

Points; Haiku-graded as registered. McNemar's exact test on the pooled pairs (taken as independent): the rule alone
raised the fact in 162 tasks, the default without it alone in 148, p 0.46. The design effect is under one: the
rule's effect does not vary by template (the bootstrap's floor with these templates is ±0.4), so seeds did narrow
it, as F3 found for `fewer`. The half-width reached is 1.3 points against the 1.4–1.6 projected.

**The rule, applied.** The pooled interval's lower bound is −0.8, above −2.0: **`sourceYield` stays on in
`DEFAULT_CONFIG`** (D541). What the interval supports: a loss of 0.8 points or more is excluded at the 95% level,
and so is a gain above 1.8; the effect is not told from zero. Over days alone the run says little (±8.8, 94
pairs): the long horizon's safety rests on the pooled figure and on N1's $0 screen (37 of 46 with and without).

**Seeds 41–44 against the rest.** The four seeds N1 ran read −1.6 here, as they read −1.0 there, on new agent
draws; the 24 others read +0.9. The two groups' intervals overlap and neither excludes zero, so this is not a
measured difference between replayed and in-run cards. It does say that four seeds' sign is not evidence: N1's
"below zero in both runs" was two draws of the same 384 tasks (D544).

## 3. Calls, dollars, concerns

Eden's connector calls a task in the task's window, paired (`pair-short.txt`, `pair-long.txt`; a8/pair.py,
task-level bootstrap; the agent itself makes no connector call in these arms):

| horizon | without the rule | with it | effect |
| --- | --- | --- | --- |
| short, hidden tasks (n 2,538) | 37.27 | 26.88 | −10.39 (−11.17..−9.63) |
| short, control tasks (n 383, seeds 41–44) | 39.11 | 27.20 | −11.92 (−14.00..−9.84) |
| long, 1:1:8 mix (n 934: 94 hidden, 96 control, 744 neutral) | 35.59 | 11.74 | −23.85 (−24.98..−22.75) |

N1 measured −12.0 (−13.5..−10.6) and −24.7 (−26.0..−23.5) on four and six seeds.

$ per 1,000 tasks. First-party (agent billed + Eden per task + background cards), paired with clustered intervals
(`bench.txt`): pooled **+0.002 (−0.001..+0.005)**, 0.562 with the rule against 0.560; short seeds 41–44 +0.003
(−0.006..+0.012); seeds 45–68 +0.002 (−0.003..+0.007), 0.639 against 0.637 (in-run cards); long +0.000
(−0.003..+0.003), 0.469 both. Priced on market.py's connector plans (list prices, assumed), steady state
(`pi-cost-short.txt`, `pi-cost-long.txt`: each arm's own finished tasks, not paired, so the first-party row there
differs from the paired figure by the tasks each arm lost at the cap):

| plan | short: without / with | long: without / with |
| --- | --- | --- |
| Composio | 12.78 / 9.36 | 12.45 / 4.60 |
| Unified.to | 31.07 / 22.45 | 30.40 / 10.80 |
| Arcade.dev | 407.1 / 291.6 | 399.3 / 138.2 |
| Pipedream Connect | 488.5 / 349.8 | 479.1 / 165.7 |
| Zapier MCP | 1,049.5 / 751.4 | 1,029.5 / 355.7 |

False concerns on control and neutral tasks, Sonnet's verdict on the 21 answers Haiku flagged (none failed to
grade): pooled 2 with the rule against 1 without in 1,223 pairs, +0.1 points (−0.2..+0.3); short 0 against 1 in
383; long 2 against 0 in 840 (+0.2, +0.0..+0.6; N1's long run had 1 against 0). Wall mean +0.019 s
(−0.004..+0.042) pooled; `ask_context` calls +0.008 a task (−0.008..+0.025).

## 4. What this leaves

- `sourceYield` needs no further hidden-fact run at this size. A loss under 0.8 points is not excluded, and one
  that small would cost about four times this run to see (arithmetic from the measured variance, not run).
- The long horizon's concerns (3 Sonnet-kept in 1,501 control and neutral tasks with the rule over N1 and this
  run, 0 without) are the one figure that leans against the rule; each interval touches zero. Worth reading
  the three answers before the next change to the "not searched" wording.
- **Caps on the fan-out** (D543): a shard stops at its cap less 10% counting calls in flight, so a cap should be
  about (expected spend + $0.002 a stream) / 0.9. The registered caps here were too tight by that amount.

## Reproduce

```bash
python3 -m venv .local/venv-modal && .local/venv-modal/bin/pip install 'modal[api-proxy-support]==1.6.3'
R=packages/sim/lab/n1b
$R/run.sh smoke; $R/run.sh short41; $R/run.sh short45; $R/run.sh long
$R/run.sh short49 3.60; $R/run.sh long 47-48 0.34
LONG_RUNS=n1b-long,n1b-long-47-48 $R/report.sh regrade      # Sonnet on flagged concerns, cap $0.15
LONG_RUNS=n1b-long,n1b-long-47-48 $R/report.sh              # bench*.txt, pair-*.txt, pi-cost-*.txt, manifests
```
