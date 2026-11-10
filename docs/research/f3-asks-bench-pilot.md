# F3: several questions in one ask, a powered test bench, a real-data pilot kit

Status: 2026-11-10, branch `claude/f3-asks-bench-pilot` (from `claude/lucid-hypatia-v9wqk5` at 0fbbeb56). Decisions
D485–D489. Three items from the owner-approved research list. Every paid call goes to the Anthropic API with
`HAIKU_API_KEY` through the lab provider (D97): **Anthropic-direct lab figures**, not the OpenRouter route the servers
ship. `heldout18` is not run or read. **Result: `askMulti` measured, not promoted and deleted (D485, D486); the
powered bench is adopted and was used once (D487, D488); the pilot kit is built and not run (D489). Nothing in the
default changed.**

## 0. Pre-registration (committed and pushed before any paid call)

### A. Several questions in one `ask_context` call (trial `askMulti`, D485)

**Why.** A turn in which the agent asks costs a model round trip of its own (A16: about 190 output tokens and 1.4 s,
1.5 calls a turn), and the agent's own turns are most of a task's wait. If one call can carry every question the
agent has (a person, a thing, a date), the agent may need fewer turns.

**The switch.** `askMulti` (engine config, off; a trial under D112). On, the tool takes `questions` (1 to 5 strings)
instead of `question`, and its description changes by two phrases: "a question" becomes "one or more questions", and
one sentence is added on how to pass them ("Put every question you have in one call."). The sentence on **when** to
ask is unchanged (D257, D335: wording that discourages asks loses facts). Each question is answered by the engine's
ordinary `ask`, in the order given, and the answers come back together, each under its question. Nothing else in the
engine changes.

**Harness.** Pi (`pi-ab.ts`), `--config default`, `--tenant-prompt`, market `direct` source profile, time scale 1,
`--push payload`, `claude-haiku-5-5` in every role, cards `cards-v2` + `cards-train` + `cards-train-4344` and the
checked-in intent requests replayed. Suites `train`, seeds 41–44. Arms `eden` (the default) and `eden+askMulti`, in
one process a shard, paired task by task.

**Runs.**

1. **Short** (one request a session): `--variants hidden,control`, all six train suites, one seed a shard. These are
   the same shards as B's seeds 41–44 (the arms run side by side in one process; see B).
2. **Long**: `--days 8`, one user a seed, seeds 41–44.
3. **Regrade**: every hidden answer of both arms, short and long, with `claude-sonnet-5-5` (`regrade.ts --kinds
   hidden`); every control and neutral answer Haiku called a concern, with Sonnet (`--only-concerns`). Sonnet's
   verdict replaces Haiku's where Sonnet graded; an answer Sonnet failed to grade keeps Haiku's and is counted.

**Metrics** (effect = `eden+askMulti − eden`, paired; 95% intervals by bootstrap, 5,000 draws, templates resampled
as clusters within each horizon): `ask_context` calls a task and questions a task; agent model turns a task (model
requests); wall mean (s); hidden facts raised, Sonnet-regraded (points); concerns, Sonnet-regraded; $ per 1,000 tasks
(agent billed + Eden per task + background cards). Reported pooled and per horizon.

**Rule (applied mechanically).** Promote `askMulti` into the default only if all four hold:

- **hidden not worse:** the pooled Sonnet-regraded hidden effect's point estimate is ≥ −1.5 points and its interval
  is not entirely below zero; **and** on the long horizon alone (about 46 hidden tasks, where D335 lost facts) the
  point estimate is ≥ −4.4 points (at most two facts fewer);
- **concerns not up:** the pooled Sonnet-regraded concern effect's interval is not entirely above zero;
- **turns or wall fall:** the pooled effect on model turns a task, or on wall mean, has an interval entirely below
  zero;
- **no extra paid cost (D112):** the pooled $/1k interval is not entirely above zero.

Otherwise the switch, its code and its tests are deleted in this branch and the result stays in this note. With about
810 hidden pairs the hidden interval is about ±2.6 points (M4): "not worse" here means no sign of a loss at that
resolution, and the note says so.

### B. A powered test bench (D487), used once (D488)

**Why.** Today's part decisions rest on effects of about two points measured at ±2 to ±6. A 2-point paired effect
needs about 1,000–2,000 paired tasks, and tasks that share a template share their errors (arXiv 2411.00640), so an
interval that treats tasks as independent is too narrow.

**Tooling (built and unit-tested at $0 before the run).**

- `lab_fanout.py --preset NAME`: named, checked-in run shapes (`fanout_plan.PRESETS`), so a powered run is one
  command.
- **Concurrency.** The planner counts each shard's agent streams (arms × worlds) and starts shards in waves that keep
  the streams running at once at or under `--max-streams` (default 60: the level M1's one-at-a-time rerun and M4 ran
  with no retried 429). After each wave it reads the shards' own request summaries; if more than 2% of requests were
  retried on a 429, the next wave's width is halved (never below one shard).
- `bench_report.py`: from the shards' `out.json` (and Sonnet regrades beside them), for each pair of arms: tasks
  clustered by template; the paired effect with a **cluster bootstrap** (templates resampled, 5,000 draws) beside the
  naive task-level interval and a seed-clustered one; the exact paired McNemar test (reported, with the note that it
  assumes independent pairs); the design effect; and the **minimum detectable effect** of the run (the effect that a
  two-sided 5% test finds with 80% power: 2.80 × the clustered standard error).

**The run.** Pi, the harness of A. Suites `train`, short horizon, one seed a shard. Arms: `tools`, `eden`,
`eden~minus-fewer` (`pushCandidatesSettled` 0, the `fewer` part of `PARTS`, D404), and on seeds 41–44 also
`eden+askMulti` (A's short run).

- Seeds **41–48**: `--variants hidden,control` (192 hidden and 192 control tasks a seed an arm).
- Seeds **49–68**: `--variants hidden` (192 hidden tasks a seed an arm).
- So 28 seeds, **5,376 hidden pairs** a comparison if every task finishes, and 1,536 control pairs.
- Cards and intent requests are replayed on seeds 41–44. **On seeds 45–68 no cache covers the worlds: cards and their
  requests are made in-run by Haiku** (M1 measured such seeds about 11 points lower in every Eden arm, D444). Both
  groups are reported apart as well as pooled.
- A smoke shard first (train1, seed 41, `--limit 4`, cap $0.05) proves the image, the Secret, the preset and the
  merge. If the first full wave's cost a seed is above the estimate ($0.50 with control, $0.19 hidden only) by more
  than 25%, seeds are dropped from the top (68 downwards) to stay inside the cap, and the note says how many.

**Questions and rules.** For each of (1) `eden − tools` and (2) `eden~minus-fewer − eden`:

- Primary: hidden facts raised (Haiku-graded; D456 found Sonnet does not move such pairs' effect), points, with the
  template-clustered 95% interval.
- Target: a half-width of at most **1.5 points**. If the clustered interval is wider (192 templates bound it however
  many seeds run), the note reports the width reached and the MDE; no seeds are added past the cap.
- (1) is **confirmed** if the clustered interval is entirely above zero. (2) `fewer` is **kept** unless removing it
  raises hidden facts with a clustered interval entirely above zero; it is reported as **costing facts** in that case
  and becomes a recommendation for its own trial, not a change made here. $/1k and wall are reported with intervals;
  control concerns (seeds 41–48) are Sonnet-regraded (`--only-concerns`) and reported.
- Nothing in the default changes on B's results.

### C. A real-data pilot kit (D489): built, not run

Tooling for the owner to point Eden at one consenting test account locally: an import through the existing Gmail and
Calendar connector presets with every text through `sanitizeForStore`, a CLI to write real tasks and mark which
facts mattered, runs of the agent alone and with Eden on those tasks, and a report. **This session uses no real data
and connects to no real account**; the kit is tested on sim data only, and no paid call is made for it.

### Spend

Anthropic hard cap **$12 in all**, as separate ledgers and caps that sum to at most $11.60:

| item | cap |
| --- | --- |
| smoke shards | $0.15 |
| B short, seeds 41–44 (4 arms, hidden + control; A's short arms ride here) | $2.40 ($0.60 a shard) |
| B short, seeds 45–48 (3 arms, hidden + control) | $1.80 ($0.45 a shard) |
| B short, seeds 49–68 (3 arms, hidden) | $4.40 ($0.22 a shard) |
| A long, seeds 41–44 (2 arms, `--days 8`) | $0.40 ($0.10 a shard) |
| A regrade (Sonnet, every hidden answer of two arms) | $2.20 |
| B regrade (Sonnet, concerns only) | $0.25 |

A shard that hits its cap stops early; its unfinished tasks drop from every arm's pair and the note says how many.
Modal spend is read from `modal billing report` and kept under $25.

## In plain words

**Spent: $9.44 Anthropic** of the $12 cap (runs $7.59 from the shards' manifests, Sonnet regrades $1.84 from their
ledgers), **Modal $0.52** for this session's five apps (`modal billing report --for today`, read at 11:10 UTC; the
last hour may not be in it). Anthropic-direct lab figures (D97), Haiku 5.5 in every role. 33 containers, **59,108
model requests, 0 retried on a 429**.

- **A. Several questions in one ask: measured, not promoted, deleted (D485).** The agent did use it: `ask_context`
  calls fell from 0.48 to 0.29 a task and model turns by 0.07 a task (−0.09..−0.05), wall by 0.07 s (−0.11..−0.02).
  Hidden facts were level, Sonnet-graded: **−0.4 points (−2.8..+2.1, n 813)**; concerns 0 in both arms. But the agent
  asked **more questions in all** (0.48 → 0.83 a task: it splits one compound question into three or four), each
  answer is more text for the agent to read, and the cost rose by **+$0.036 per 1,000 tasks (+0.028..+0.043)**, about
  14%. The rule needed no extra paid cost (D112); it failed that clause, so the switch, its code and its tests are
  gone. The saving it bought, 0.07 s a task, is small because Haiku already makes its asks in parallel in one turn.
- **B. The bench works, and it changes how sure we are.** 28 seeds, 5,153 paired hidden tasks.
  - **The default against the agent alone: +47.0 points (+41.2..+52.6), confirmed.** The interval is ±5.7, not the
    ±1.5 the task count suggests: tasks of one template rise and fall together, so 5,153 tasks carry the information
    of about 340 independent ones (design effect 15). **More seeds cannot narrow it** (the floor with 192 templates
    is ±5.5); ±1.5 would need about 2,600 templates (arithmetic from the measured variance, not run). Eden is also
    1.14 s faster a task (−1.29..−0.98), 0.38 model turns fewer, and **+$0.069 per 1,000 tasks** dearer
    first-party (+0.057..+0.082); Sonnet-regraded false concerns 0 of 1,536 in both arms.
  - **Cards made in-run cost 11 points.** Seeds 41–44 (cards and requests replayed): 67.2% against 10.5%, +56.6
    (+50.8..+62.5). Seeds 45–68 (no cache; Haiku cards each item in-run, closer to a new user): 54.2% against 8.9%,
    +45.3 (+39.4..+51.2), and +$0.081/1k against +$0.030. M1 saw the same gap on four seeds (D444); this is 24.
  - **Default minus `fewer` (D404): kept, at the edge.** Removing it raises hidden facts by **+1.0 point
    (−0.2..+2.1, n 5,014)**: the ±1.5 target was reached here (half-width 1.2; the run's minimum detectable effect
    is 1.7 points). The interval touches zero, so by the rule `fewer` stays. It saves $0.010 per 1,000 tasks
    (+0.006..+0.014 without it) and 4 Sonnet-kept false concerns in 1,536 control tasks (0 with it). Read plainly:
    `fewer` buys about 3% of the bill and may cost about one hidden fact in a hundred; this run cannot tell 1.0
    from 0.
- **C. The pilot kit is built and tested on simulated data; it has not touched a real account.** `bun run pilot`
  (docs/PILOT.md): import through the Gmail and Calendar presets with every text through `sanitizeForStore`, the
  owner's own requests and facts, the Pi harness alone and with Eden on them, blind marks, a paired report, and
  `forget`. Data stays in a directory outside any git repository; a run prints what it would send to Anthropic and
  starts only with `--send-to anthropic`.

## 1. Runs

Pi, `--config default`, `--tenant-prompt`, `direct` profile, time scale 1, `--push payload`, Haiku 5.5 in every role,
one seed a shard, `lab_fanout.py --preset bench-fewer` at commit e4acb716 (`packages/sim/lab/f3/run.sh`).

| run        | seeds | arms                                         | tasks a seed an arm         | at once | $     | a shard   |
| ---------- | ----- | -------------------------------------------- | --------------------------- | ------- | ----- | --------- |
| smoke      | 41    | tools, eden, minus-fewer, askMulti; train1   | 8 (`--limit 4`)             | 1       | 0.011 | 22 s      |
| f3-b-41    | 41–44 | tools, eden, minus-fewer, askMulti           | 384 (hidden, control)       | 1       | 1.944 | 131–143 s |
| f3-a-long  | 41–44 | eden, askMulti                               | a user's 8 days (114–123)   | 4       | 0.319 | 218–252 s |
| f3-b-45    | 45–48 | tools, eden, minus-fewer                     | 384 (hidden, control)       | 1       | 1.524 | 154–168 s |
| f3-b-49    | 49–68 | tools, eden, minus-fewer                     | 192 (hidden)                | 3       | 3.797 | 136–171 s |
| regrade A  |       | Sonnet: 1,626 hidden answers, 22 concerns    |                             |         | 1.816 |           |
| regrade B  |       | Sonnet: 24 concerns                          |                             |         | 0.028 |           |

A train seed with hidden and control tasks cost $0.12 an arm ($0.000316 a task run on seeds 41–44, $0.000331 on
45–48 with in-run cards).

**Deviations from the pre-registration.**

- **Cap hits.** Every hidden-only shard (seeds 49–68) reached its $0.22 cap less its headroom near its end: 435 of
  11,520 task runs (3.8%) were refused and drop from their pairs (5,153 of 5,376 hidden pairs for `eden − tools`,
  5,014 for `fewer`). The lost tasks are the last templates of a stream, so they are fewer on those seeds, not
  missing from the bench (every template has at least 17 pairs). User 44's long run lost its last 4 requests in
  both arms the same way.
- **Pooling.** The report resamples a template with all its tasks across both horizons, not within each: the
  stricter form.
- **Graders in B.** Hidden answers are Haiku-graded in every arm, as registered; Sonnet's verdicts are used only on
  the concerns (`--sonnet concerns`), since only A's two arms had their hidden answers regraded.
- A's short arms ran inside B's seeds 41–44 shards, as registered. No held-out suite was run or read.

## 2. A: `eden+askMulti − eden` (`packages/sim/lab/f3/askmulti.txt`; Sonnet-graded; clustered by template)

| scope                | hidden, Sonnet       | hidden, Haiku        | concerns, Sonnet | $/1k                      | wall s                    | model turns               | ask calls                 | questions                 |
| -------------------- | -------------------- | -------------------- | ---------------- | ------------------------- | ------------------------- | ------------------------- | ------------------------- | ------------------------- |
| **pooled (rule)**    | **−0.4 (−2.8..+2.1)** | −2.1 (−4.7..+0.5)   | 0.0 (0 and 0)    | +0.036 (+0.028..+0.043)\* | −0.065 (−0.106..−0.023)\* | −0.072 (−0.094..−0.049)\* | −0.193 (−0.227..−0.159)\* | +0.351 (+0.282..+0.421)\* |
| short (n 768 hidden) | −0.8 (−3.3..+1.7)    | −2.3 (−4.9..+0.4)    | 0.0              | +0.043 (+0.033..+0.052)\* | −0.079 (−0.132..−0.027)\* | −0.097 (−0.126..−0.068)\* | −0.249 (−0.292..−0.205)\* | +0.416 (+0.331..+0.502)\* |
| long (n 45 hidden)   | +6.7 (−2.3..+16.3)   | +2.2 (−9.1..+13.3)   | 0.0              | +0.012 (+0.006..+0.019)\* | −0.018 (−0.055..+0.021)   | +0.011 (−0.012..+0.034)   | −0.013 (−0.044..+0.018)   | +0.139 (+0.083..+0.197)\* |

Rates, pooled: hidden Sonnet 65.3% with `askMulti`, 65.7% without; calls a task 0.29 against 0.48; questions 0.83
against 0.48; $/1k 0.291 against 0.255. Sonnet graded these two arms' 1,626 hidden answers and 22 concerns and failed
on none.

**The rule, applied.** Hidden not worse: yes (pooled −0.4 ≥ −1.5, interval not below zero; long +6.7 ≥ −4.4).
Concerns not up: yes. Turns or wall fall: yes (both). No extra paid cost: **no** ($/1k interval entirely above
zero). **Not promoted; deleted.** Over a user's days the switch changed almost nothing but cost: asks are rare there
(0.11 a task), and it turned them into more questions without saving a turn.

What was deleted: `askMulti` in `EngineConfig`; `ASK_CONTEXT_MULTI_DESCRIPTION`, `ASK_MULTI_MAX`, `askQuestions`,
`joinAnswers` and their test in `@eden/protocol`; the MCP server's list schema and its tests; pi-ab's multi-question
tool; the `bench-askmulti` preset. The code is in commit e4acb716. Not tried: the same tool with a note to keep
questions few, or answers cut to a shared budget; both change what the agent reads, which is where D335 lost facts.

## 3. B: the bench at scale (`packages/sim/lab/f3/bench.txt`; clustered by template, 192 templates)

| pair, scope                         | n     | hidden, clustered       | task-level     | by seed        | design effect | MDE | $/1k                      | wall s                    |
| ----------------------------------- | ----- | ----------------------- | -------------- | -------------- | ------------- | --- | ------------------------- | ------------------------- |
| `eden − tools`, pooled              | 5,153 | +47.0 (+41.2..+52.6)\*  | +45.5..+48.5   | +45.3..+48.9   | 15.1          | 8.1 | +0.069 (+0.057..+0.082)\* | −1.136 (−1.292..−0.983)\* |
| seeds 41–44 (replayed cards)        | 768   | +56.6 (+50.8..+62.5)\*  | +52.9..+60.4   | +53.0..+59.9   | 2.5           | 8.4 | +0.030 (+0.017..+0.043)\* | −0.985 (−1.138..−0.829)\* |
| seeds 45–68 (cards in-run)          | 4,385 | +45.3 (+39.4..+51.2)\*  | +43.7..+46.9   | +44.4..+46.2   | 13.9          | 8.5 | +0.081 (+0.068..+0.094)\* | −1.182 (−1.346..−1.019)\* |
| `eden~minus-fewer − eden`, pooled   | 5,014 | +1.0 (−0.2..+2.1)       | −0.1..+2.0     | +0.2..+1.7     | 1.3           | 1.7 | +0.010 (+0.006..+0.014)\* | +0.010 (−0.011..+0.032)   |
| seeds 41–44                         | 768   | +0.1 (−2.7..+3.0)       | −2.6..+2.8     | −1.6..+2.2     | 1.2           | 4.2 | +0.008 (+0.001..+0.015)\* | −0.049 (−0.095..−0.006)\* |
| seeds 45–68                         | 4,246 | +1.1 (−0.2..+2.3)       | −0.0..+2.2     | +0.3..+2.0     | 1.2           | 1.8 | +0.011 (+0.006..+0.015)\* | +0.028 (+0.005..+0.053)\* |

Hidden in points; MDE in points (80% power, two-sided 5%); `*` the clustered interval excludes zero. Rates, pooled:
hidden 56.1% with Eden against 9.1% alone; 57.0% without `fewer` against 56.0% with it. McNemar (pairs taken as
independent): `eden − tools` 2,520 against 98; `fewer` 379 against 331, p 0.078. Model turns a task 1.40 against 1.78
(−0.377, −0.435..−0.322). Sonnet-regraded concerns on the 1,536 control tasks of seeds 41–48: `tools` 0, `eden` 0,
`eden~minus-fewer` 4 (+0.3 points, +0.0..+0.7).

**What clustering shows.** For `eden − tools` the between-template variance of the paired difference is 0.151 and
the within-template variance 0.137: some templates Eden always wins and some it never does, in every seed. The mean
over 192 templates therefore has a floor of ±5.5 points however many seeds run, and a task-level interval (±1.5
here) is 3.9 times too narrow. For a part's effect the picture is the opposite: `fewer`'s between-template variance is
0.002 against 0.139 within, so seeds do help (design effect 1.3), and ±1.5 needs about 15 seeds a template.

**The rules, applied.** (1) `eden − tools`: confirmed (interval entirely above zero); the ±1.5 target is not
reachable with 192 templates, and the width reached is ±5.7. (2) `fewer`: kept (the interval is not entirely above
zero); the target was reached (±1.2).

**Against M1** (D441–D443, eight seeds): `eden − tools` short on seeds 41–44 was +55.6 (+51.7..+59.5, tasks
resampled within seed); here +56.6 with the wider clustered interval. `fewer`'s hidden effect was +0.1 (−1.8..+1.9, n
1,496); here +1.0 (−0.2..+2.1, n 5,014). Its saving was $0.011/1k pooled; here $0.010.

## 4. Concurrency

The planner counted 48 streams a shard on seeds 41–44 (4 arms × 12 worlds), 36 on 45–48 and 18 on 49–68, and ran
1, 1 and 3 shards at once under the 60-stream limit; the long run's four shards (2 streams each) ran together. The
second and third runs queued behind the first on the checkout's lock. No wave met the rate limit (0 of 59,108
requests retried on a 429), so the halving rule never fired; it is unit-tested. From the first bench shard's start
to the last one's end was 44 minutes (the long run included), for 71 minutes of bench container time.

## 5. Recommendations (nothing in the default changed)

1. **Quote the default's gain with its clustered interval**, and for the user-facing number prefer the in-run-card
   seeds (+45 points, a new user) beside the replayed-card ones (+57).
2. **To tighten the headline number, write templates, not seeds:** a suite of new templates run on a few seeds
   narrows it; 20 more seeds do not.
3. **`fewer`:** leave it. A trial that settles 1 point needs about four times this run (about $16, estimate).
4. **In-run cards (−11 points):** the largest measured lever left is card and request quality for a user with no
   cache, which is every real user at first.
5. **Asks:** the agent's ask turn is not shortened by batching. The remaining idea is A16's answer-ahead (Eden
   pre-runs the likely ask), not the tool's shape.

## Reproduce

```bash
python3 -m venv .venv-modal && .venv-modal/bin/pip install 'modal[api-proxy-support]==1.6.3'
packages/sim/lab/f3/run.sh         # the fan-outs at e4acb716, the Sonnet regrades, the three reports
cd packages/sim/modal && python3 -I -m unittest    # the planner's and the report's tests, $0
bun test packages/sim/src/pilot/                   # the pilot kit on sim data, $0
```
