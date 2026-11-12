# The final benchmark pipeline (served by subagents, D1101)

`go.sh` runs the final comparison: Eden before the F wave (006b505c), Eden final and the agent alone. One suite,
seeds 41-44, hidden, control and neutral, with `pi-ab --agent-sim single`. Every model call goes through one queue
transport directory, answered by Claude Code subagents. **Quote every number as "served by subagents (D1101),
single-shot"**: compare arms within the run, never against API or real-loop numbers. Subagents are more diligent than
the API's Haiku (D1140), so levels read high.

```bash
FINAL=<commit> SUITE=heldout20 bash packages/sim/lab/final/go.sh                 # the final read, once
FINAL=HEAD SUITE=dev20 SEEDS=41 PREFIX=reh bash packages/sim/lab/final/go.sh      # a rehearsal
DRY_ONLY=1 FINAL=<commit> SUITE=heldout20 PREFIX=dry bash packages/sim/lab/final/go.sh  # start-up check, ~15 s
```

`DRY_ONLY=1` builds the trees, checks the task hashes and dry-starts every arm (no model call, nothing queued), then
stops. Run it at the freeze. On dev20 it took 13 s.

Optional settings:

| variable | what it sets |
| --- | --- |
| `FINAL_CONFIG` | the final arm's configuration: a preset name or a JSON object of overrides (F12's candidate) |
| `MT_LIMIT`, `MT_SEEDS` | the multi-turn sample's tasks a world (default 20) and seeds (default the first) |
| `REALISM=heavy` | adds step 2c, raw against final under `--realism heavy` (F8, D1103), after the main arms |
| `SPLIT` | streams a world (default 8) |

The steps run in this order, so a run that hits the subagents' weekly cap still holds the owner's targets:

1. the two trees;
2. the final tree's coverage on the world clock;
3. the single-shot raw and final arms;
4. the multi-turn sample (raw against final, the real Pi loop: the agent's own turns, tools and tokens for the cost
   and speed targets);
5. the before tree's coverage and its single-shot arm (`SKIP_BEFORE=1` drops it);
6. optionally the realism stage;
7. the report, which reads whatever finished.

`FINAL_CONFIG` as a JSON object also reaches the final tree's coverage (cold-start's `--set`), so a card-form change
in it is carded in its own form. A preset name cannot reach it: promote the profile into `DEFAULT_CONFIG` instead.

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

Spawn workers as `queue-worker` agents (Read, Write and Bash only). `worker.md` tells them, in so many words, to
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

## Driving tips and pitfalls (from the rehearsal)

**Roles and batches.**

- Keep roles apart with `take --model PREFIX`, not `--role`. `claude-haiku` covers `agent`, `eden.check`,
  `eden.cards` and `eden.reader`; `claude-sonnet` is the grader alone.
- `queue-worker` defaults to haiku: spawn graders with model `sonnet` and MPREFIX `claude-sonnet`.
- Batch sizes that worked:
  - cards, 4 a batch (each about 20 items), with `--max-chars 120000`;
  - checks and agent calls, 8;
  - grades, 10.

  F9 found checks equally faithful at 20–30 a batch.

**Phases.**

1. Coverage asks only for `eden.cards`.
2. Single-shot asks for `agent` and `eden.check`, then a wave of `grader`. When only `grader` is pending, give most
   slots to sonnet workers.
3. Multi-turn sends each task's agent calls one after another; `--split 8` keeps about a hundred in flight.

**Workers.** A worker stops after 12 batches or about five idle minutes: start another while work is pending.
Requests left in `taken/` by a worker that died go back with `batch.ts requeue --dir Q --older-min 5`.

**Resume.** Re-running the same command skips every output that exists: a world's `.done` marker, an arm's `.json`.
Answers already in `q/done/` replay at once.

- An arm that crashed midway: delete its `<arm>.*` files and run again. Without that, pi-ab's `.partial.jsonl` journal
  refuses a run that lacks `--resume`.
- Do not time a run on a queue another FINAL already filled: its replays take no time.

**Pitfalls already fixed in go.sh.**

- A $1 spend cap refused calls. The ledger reserves estimates even at $0, so the cap is now 100000.
- One cold-start process for all users took hours; it is now one process a world.
- `readerPushWaitMs` capped the push at 60 s. It is lifted now, and `check-order.py` asserts the order.

**One arm a batch (F7 §13).** `worker.md` takes with `--single-arm`, so a batch holds one arm's requests of one role
(the arm is `EDEN_LAB_QUEUE_RUN`, set per arm by go.sh) and a mixed-up answer cannot land in another arm. Every answer
`put` rejects for its shape goes back to pending and is logged in `q/invalid.jsonl`; report.txt counts them by arm.

**Pitfall not caught by any check.** In D1160's hand-driven pilot a worker swapped two answers between ids. `put`
validates an answer's format, not whether it answers its own request, so read a sample of answers if a number
looks odd.
