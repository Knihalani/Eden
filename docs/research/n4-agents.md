# N4: a stronger agent, and a new user's first minutes

Status: 2026-11-10, session N4, in progress. Decisions D520–D524. Every paid call goes to the Anthropic API with
`HAIKU_API_KEY` through the lab provider (D97): **Anthropic-direct lab figures**, not the OpenRouter route the servers
ship. Train only (seeds 41–48); heldout18 stays unread. Caps: Anthropic $20, Modal $15.

## 0. Pre-registration

Written before any main-run call. Three probe runs came first (`probe-sonnet`, `probe-opus`, `probe-opus2`: train,
seed 41, hidden, `--limit 1`, 12 task runs each; $0.40 in all) to learn whether the harness could run the models at
all and what a task costs: Sonnet 5.5 about $0.012 a task run, Opus 5.5 about $0.021. No rate from them is quoted
as a result.

### (A) Does Eden still help a stronger agent, and what does its packet cost there?

**Harness.** Pi (`pi-ab.ts`) through `packages/sim/lab/n4/run.sh`: `--config default`, `--tenant-prompt` (D271) in
every arm, `--push payload`, the market `direct` source profile, time scale 1, cards replayed from the three
checked-in files, intent requests replayed (D158). Arms `tools` (the agent with one search tool a source) and `eden`.
**Only the agent's model changes**: `claude-sonnet-5-5`, `claude-opus-5-5`, and `claude-haiku-5-5` on the same tasks
as the reference. Eden's card model, its reader and the grader stay `claude-haiku-5-5`; every concern on a control
task is regraded by `claude-sonnet-5-5` (`regrade.ts --only-concerns`).

**Thinking.** Haiku runs with thinking disabled; Sonnet 5.5 refuses "disabled" and runs `between_tools` (A2). Opus
5.5 refuses both (probed) and runs `adaptive` at effort `low`, the nearest setting it accepts: an Opus row is an
agent that may think, and is labelled so.

**Prices.** Agent cost is each request's own usage priced per token class: Sonnet 5.5 $2/$10 and Opus 5.5 $4/$20 a
million tokens, cache writes 1.25x input, **cache reads 0.05x** on both (the session's brief; not re-read from the
API reference here); Haiku 5.5 $0.10/$0.50, reads 0.1x.

**Runs** (one seed a process, two processes at a time; each with a hard `--budget`):

| Run | Agent | Seeds | Shape | Task runs | Budget a process |
| --- | --- | --- | --- | --- | --- |
| `a-sonnet-short-S` | Sonnet 5.5 | 41–44 | `--variants hidden,control --limit 4` | 4 × 96 | $1.35 |
| `a-opus-short-S` | Opus 5.5 | 41–44 | `--variants hidden,control --limit 2` | 4 × 48 | $1.15 |
| `a-haiku-short-S` | Haiku 5.5 | 41–44 | `--variants hidden,control --limit 4` | 4 × 96 | $0.10 |
| `a-sonnet-long-S` | Sonnet 5.5 | 41, 42 | `--days 1 --day-size 16` | 2 × 2 arms × a day | $0.80 |
| `a-opus-long-41` | Opus 5.5 | 41 | `--days 1 --day-size 16` | 2 arms × a day | $1.30 |
| `a-haiku-long-S` | Haiku 5.5 | 41, 42 | `--days 1 --day-size 16` | 2 × 2 arms × a day | $0.10 |

`--limit N` takes each suite's first N templates, so Opus's tasks are a subset of Sonnet's and Haiku's. The task
counts are set by the $20 cap, not by a power calculation: 96 hidden pairs for Sonnet and 48 for Opus see an effect
the size Haiku shows (about +60 points) and cannot see a few points. The long runs are one day a user: they are
there for the cost of a session whose earlier packets are read back from the cache, and their hidden counts are too
small to carry a quality claim on their own.

**What is read, and the rules.**

1. **Hidden facts**: `eden` − `tools`, paired task by task, short and long pooled (`cl4/pooled.py`, 95% interval).
   "Eden still helps this agent" if the interval's lower bound is above 0. Reported beside the Haiku agent's effect
   on the same tasks and beside the `tools` arm's own rate (how much better the stronger agent searches alone).
2. **False concerns**: control concerns after the Sonnet regrade, both arms. "Not worse" if `eden` raises at most
   one more than `tools` per agent.
3. **Cost**: $ per 1,000 tasks, agent + Eden's per-task calls + grader excluded, `eden` − `tools`, with connector
   calls free and on the per-call plans A8 priced (`pi-cost-report.ts`); the packet's share read by token class
   (cache write, cache read, output). No pass rule: the question is the size and its sign at each price.
4. **Wall** seconds per task, both arms.

A run that stops on its budget is reported with the task runs it finished, paired on those.

No engine change follows from (A) whatever it reads: it is a measurement (D520).

### (B) A new user's first minutes

To be written in §0b before any (B) paid call.
