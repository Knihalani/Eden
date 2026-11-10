# N1b: `sourceYield` on the powered bench (does skipping reads at 1,000 sources cost hidden facts?)

Status: pre-registered 2026-11-10 on branch `claude/n1b-yield-bench` (from `claude/lucid-hypatia-v9wqk5` at
12307421, N1 merged). Decisions D540–D544. Paid calls: Anthropic API only, the Modal Secret `HAIKU_API_KEY`,
`claude-haiku-5-5` in every role, `claude-sonnet-5-5` for the concern regrade, lab provider (D97):
**Anthropic-direct lab figures**, not the OpenRouter route the servers ship. Train suites only; `heldout18` is not
run or read. **No paid call was made before this section was committed and pushed.**

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
