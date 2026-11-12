# The final benchmark pipeline (served by subagents, D1101)

`go.sh` runs the final comparison: Eden before the F wave (006b505c), Eden final and the agent alone. One suite,
seeds 41-44, hidden, control and neutral, with `pi-ab --agent-sim single`. Every model call goes through one queue
transport directory, answered by Claude Code subagents. **Quote every number as "served by subagents (D1101),
single-shot"**: compare arms within the run, never against API or real-loop numbers. Subagents are more diligent than
the API's Haiku (D1140), so levels read high.

```bash
FINAL=<commit> SUITE=heldout20 bash packages/sim/lab/final/go.sh                 # the final read, once
FINAL=HEAD SUITE=dev20 SEEDS=41 PREFIX=reh bash packages/sim/lab/final/go.sh      # a rehearsal
```

Optional settings:

| variable | what it sets |
| --- | --- |
| `FINAL_CONFIG` | the final arm's configuration: a preset name or a JSON object of overrides (F12's candidate) |
| `MT_LIMIT`, `MT_SEEDS` | the multi-turn sample's tasks a world (default 20) and seeds (default the first) |
| `REALISM=heavy` | adds step 2c, raw against final under `--realism heavy` (F8, D1103), after the main arms |
| `SPLIT` | streams a world (default 8) |

The steps are:

1. the two trees;
2. per-tree coverage on the world clock;
3. the three single-shot arms (raw, before, final);
4. the multi-turn sample (raw against final, the real Pi loop: the agent's own turns, tools and tokens for the cost
   and speed targets);
5. optionally the realism stage;
6. the report.

The report holds:

- quality with paired intervals, label splits and the stage of each hidden fact;
- a late-check adjusted row [EST]: P(check later than 1.5 s on the API) = 0.21 from F7's p50/p90; a late check fails
  open to the unchecked head of the pool;
- F7's per-role pricing;
- quality, cost and speed side by side (`cost.py`):
  - Eden and agent $ per 1,000 tasks;
  - card backfill a world plus CL3's trickle a heavy user-month;
  - connector fees by plan;
  - push wait;
  - connector calls.

Outputs go to `.local/final/<PREFIX>/`:

- `go.log`;
- the queue in `q/`;
- the coverage in `cov-*.jsonl`;
- the arms in `raw|before|final.json` and their `.tl` timelines;
- `report.txt`.

Every step skips what already exists, so the same command resumes a stopped run.

## Driving the queue

A script cannot spawn subagents, so the session that started `go.sh` serves the queue with looping workers. Each
worker is a background Agent, given the prompt `worker.md` with its placeholders filled:

| placeholder | value |
| --- | --- |
| `WNAME` | the worker's own name |
| `QDIR` | `.local/final/<PREFIX>/q` |
| `NBATCH` | requests a batch |
| `MPREFIX` | `claude-haiku` or `claude-sonnet` |

Spawn workers as `general-purpose` agents, the narrowest type available. `worker.md` tells them, in so many words, to
use only Read, Write and Bash for batch.ts, and never an mcp__ or session tool. F5 saw a worker call create_session,
and in the rehearsal one called interrupt_session: during the final, a worker that interrupts a session would cost the
run.

Use `model: "haiku"` for workers on `claude-haiku` (the agent, the push check, cards and intent). Use
`model: "sonnet"` for workers on `claude-sonnet` (the grader). A worker stops after 12 batches ("rotate") or about
five idle minutes ("idle"); start another in its place while `go.sh` is still running. To see the queue:

```bash
env -u OPENROUTER_API_KEY bun packages/sim/lab/subagent/batch.ts status --dir .local/final/<PREFIX>/q
```

A worker that died holding a batch: `batch.ts requeue --dir Q --older-min 20`.

Batch sizes that worked in the rehearsal:

- cards: 4 a batch, each about 20 items;
- push checks: 8 a batch;
- agent answers: 8 a batch;
- grades: 10 a batch.

`take --max-chars 120000` keeps a batch within a haiku worker's reading.

## What it measures, and how it differs from B19

- **Single-shot agent:** one call that sees the house prompt, Eden's packets, its ask answer and the tools' results
  for a fixed keyword query (F9). It is not the Pi loop.
- **Push check on time:** the check and the first observe wait for the queue (`pushCheckWaitMs` and `@w` set to ten
  hours), so every check lands before the agent's call. Through the API, about 1.5 s, it sometimes did not.
- **`--split 8`:** each world's tasks run as eight streams, each with its own partner, the same in both Eden arms.
  Within a partner, cross-task state such as `sourceYield` sees an eighth of the requests.
- **Coverage:** each tree records its own coverage on the world's clock (`cold-start.ts`, one process a world). It
  covers only the hidden, control and neutral worlds, not the days users, since single-shot runs one request a
  session.
- **Stage attribution:** it comes from the same run's push pools (`pushPools` in the timeline), not a separate funnel
  pass.

## Rehearsal (dev20, seed 41, 2026-11-12; FINAL = HEAD, so before and final run identical product code)

The run had 480 tasks an arm: 160 each of hidden, control and neutral, over dev20a–d. heldout20 at seeds 41–44 is the
same size if it has 40 templates, as heldout19 did (not checked: heldout20 stays unread).

What it took:

- **Coverage: 11 min, 09:18–09:29 UTC.** 24 worlds, 170 card requests answered.
- **Arms: about 20 min.** That figure includes a restart: the first attempt hit `--spend-cap 1`. The queue books $0,
  but the ledger still reserves each call's estimate against the cap, so the cap is now 100000. Answers already in
  the queue replayed on the restart.
- **In all, about 31 min of driving**, about 39 worker agents (24 haiku, 15 sonnet) and 2,178 unique requests: 705
  agent, 1,014 grader, 289 push check, 170 cards. 0 tasks were ungraded.

What it showed:

- **Before and final read identically, task for task**, because their prompts were identical and the queue replayed
  each answer. With different product code, only the tasks whose Eden context differs can differ, so the paired
  intervals measure the templates, not answer noise.

For the final read, with before ≠ final and four base worlds:

- Expect about 1.8× the unique requests: about 4,000 (agent about 1,440, grader about 1,440, check about 600,
  cards 400–700).
- That is about 550–600 batches.
- Plan 60–90 min with about 20 workers at once (this session's cap is 20 concurrent subagents).
