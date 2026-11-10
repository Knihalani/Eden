# F3: several questions in one ask, a powered test bench, a real-data pilot kit

Status: 2026-11-10, branch `claude/f3-asks-bench-pilot` (from `claude/lucid-hypatia-v9wqk5` at 0fbbeb56). Decisions
D485–D489. Three items from the owner-approved research list. Every paid call goes to the Anthropic API with
`HAIKU_API_KEY` through the lab provider (D97): **Anthropic-direct lab figures**, not the OpenRouter route the servers
ship. `heldout18` is not run or read.

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

## Results

(Filled in after the runs.)
