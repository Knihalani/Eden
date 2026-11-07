# Fix S3b: the shipped integration shape, a new blind suite, and four benchmark gaps

Status: 2026-11-07, branch `claude/fix-s3b-lab`. Plan: [realuse-1-weak-points.md](realuse-1-weak-points.md), issues 4
and 12. Lab only: no engine file changed, no default changed, no decision row used (D205–D209 stay free). Every paid
call went to the Anthropic API with `HAIKU_API_KEY` through the lab provider (D97), `OPENROUTER_API_KEY` unset,
`claude-haiku-5-5` in every role (agent, grader, cards, intent, reader) and `claude-sonnet-5-5` only for the regrade,
on one spend ledger with a hard cap (`--spend-ledger .local/ledger.jsonl --spend-cap 4 --spend-headroom 0.3`). These
are **Anthropic-direct lab figures**; the servers ship Haiku through OpenRouter (D12). Summaries and reports are in
`packages/sim/lab/fix-s3b/`.

**Spent: $1.965** of the $4 cap (ledger labels below), including $0.378 on two day runs stopped after review found a
flaw in their design (below); nothing from those runs is reported.

## In plain words

- **The shape integrators ship works as well as Eden alone.** With its own search tools, Eden's context *and*
  `ask_context`, the agent raised the hidden fact 65.6% of the time, against 53.1% with tools and context but no
  `ask_context` (+12.5 points, interval +3.1..+21.9) and 62.5% with Eden alone (+3.1, not a difference). It was also
  0.71 s faster than tools plus context on those tasks. Issue 4's gap came from the harness leaving out the ask, not
  from Eden beside tools, so the follow-up fix ("tell the agent what the packet covers") was not needed.
- **Across a day, Eden does not repeat itself, but nothing corrects what it said earlier.** In one agent session of
  four requests and a recap, with the day's planted items moved two hours before the recap, Eden never re-delivered
  an item, and in the recap turn (the only turn after the change) it delivered no stale copy. But the agent's recap named the old time of a changed item 14 times
  (eden) and 15 times (both+ask) against 5 and 2 times the new one: the stale fact comes from the agent's own
  transcript, and Eden does not push the revision on a general "recap" request. Recall per request also fell within a
  day (both+ask −10.9 points, interval −20.3..−3.1).
- **The Haiku grader is close to a Sonnet grader.** Sonnet 5.5 agreed with it on 370 of 384 answers; most of the 14
  disagreements are Sonnet counting a hidden fact as raised (5) or a neutral answer as raising a concern (4).
- **Synced users cost about 4 MB each in the HTTP server; the old memory scenario never synced them.** Synced, each
  user added 4.1 MB of RSS and 2.8 MB of heap (about 1,520 items a user); unsynced, as `sim:perf memory` always ran,
  0.04 MB of heap.
- **A new user's cold-start enrichment costs about two cents.** Through the servers' own wiring, cards and intent for
  a user's ~1,520 items took 21–23 Haiku calls and $0.020–0.022, well inside the $0.25 per-user-day budget.
- **A new blind suite, `heldout15`, is written and cached and has not been run.**

## 1. `heldout15` (issue 12)

`packages/sim/src/lab/hidden-heldout15.ts`, written by an author subagent that read only `hidden-heldout14.ts` (the
format, neutral included), the `HiddenTask` interface, the sim world API (`world.ts`, `names.ts`, `text.ts`,
`rng.ts`) and the RealUse-1 design; it opened no engine, source, prompt or research file and ran nothing. The wiring
session read only its template names. By the author's count:

- 32 templates, 4 per life area (work, family, health, money, travel, home, admin, social), all named differently
  from heldout14's, with `hidden`, `control` and `neutral` variants.
- Decoys: 13 resolved, expired or superseded; 11 about another entity or date; 8 where the prerequisite is met.
- Word overlap with the request: 10 share no content word, 12 share only a name, 10 share one topic word.

It is registered in `SUITES`, `UNRUN_BLIND` and `NEUTRAL_SUITES`. `suites.test.ts` checks 32 tasks per variant, 32,
32 and 0 planted items, the same text across variants, and that it stays out of `all`.

The replay caches were made with `cards-enrich.ts --funnel heldout15 --seeds 41,42,43,44 --model claude-haiku-5-5`
into a copy of the checked-in files, and the new lines were appended (the old files are an exact prefix):

- **Cards:** +180 items, 18 calls, $0.0122 (`h15-cards`).
- **Intent requests:** +226 items, $0.0230 in all:
  - 23 calls (`h15-intent`);
  - 16 single-item top-ups (`h15-intent-topup-b1`);
  - one retry for a planted item that came back with no requests (`h15-intent-retry`).

`INTENT_COVERS` gains heldout15 seeds 41–44, and `cards-disk.test.ts` checks that every planted item has requests.
The caches cost **$0.0352**.

**No funnel or agent has run on it: it is reserved for wave 2's final blind check.**

## 2. `both+ask` on Pi (issue 4)

`pi-conditions.ts`: `+ask` is a harness flag, not an engine setting, and only a `both` base takes it (`eden+ask`,
`tools+ask` throw); `askTool` gives pi-ab's agent `ask_context` beside its tools. The report pairs `both+ask` with
`both`.

```bash
# .local/ab/run.sh SEED LABEL CONDS: one seed per process, both at once
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite heldout14 --seeds $SEED \
  --variants hidden,control,neutral --conditions tools,eden,both,both+ask --config default \
  --cards packages/sim/lab/cards/cards-v2.jsonl --cards-out .local/ab/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push signals --budget 1.0 \
  --spend-ledger .local/ledger.jsonl --spend-cap 4 --spend-headroom 0.3 --run-label $L --out .local/ab/$L.json
bun packages/sim/src/lab/pi-ab-report.ts .local/ab/s3b-ask-41.json .local/ab/s3b-ask-42.json
```

Run details:

- heldout14 (read once already, for RealUse-1), seeds 41–42, 768 task runs, 0 errors, 0 ungraded.
- Time scale 1, direct profile, push signals, default `--wait`.
- **$0.508** (`s3b-ask-41`, `s3b-ask-42`).
- Report: `packages/sim/lab/fix-s3b/both-ask-report.txt`.
- n = 64 per kind and condition.

| condition | hidden raised | control false | neutral any | $/1k (agent + Eden per task) | Eden on path ms (share) | agent tool calls (hidden) |
| --------- | ------------- | ------------- | ----------- | ---------------------------- | ----------------------- | ------------------------- |
| tools     | 0.172         | 0.000         | 0.016       | 0.354                        | 0 (0%)                  | 3.02                      |
| eden      | 0.625         | 0.016         | 0.000       | 0.571                        | 2,000 (38%)             | 0.66                      |
| both      | 0.531         | 0.000         | 0.016       | 0.545                        | 951 (18%)               | 2.13                      |
| both+ask  | 0.656         | 0.031         | 0.000       | 0.539                        | 1,230 (24%)             | 1.55                      |

$/1k and tool calls are hidden-task figures; Eden on path is the mean over all 192 tasks of a condition. Background
spend (cards) adds $0.075/1k to every Eden arm.

**Paired differences** (bootstrap 95%; a difference is called only when its interval excludes zero). both+ask − both
is the report's (`both-ask-report.txt`); the other three rows are `fix-s3b/pair.py` over the same results
(`both-ask-pairs.txt`; its own bootstrap gives both+ask − both +0.125, +0.031..+0.234):

| pair            | hidden                      | control                 | neutral                 | hidden wall s            |
| --------------- | --------------------------- | ----------------------- | ----------------------- | ------------------------ |
| both+ask − both | **+0.125 (+0.031..+0.219)** | +0.031 (+0.000..+0.078) | −0.016 (−0.047..+0.000) | **−0.71 (−1.08..−0.37)** |
| both+ask − eden | +0.031 (−0.078..+0.141)     | +0.016 (−0.031..+0.078) | +0.000                  | +0.05 (−0.41..+0.50)     |
| both − eden     | −0.094 (−0.203..+0.016)     | −0.016 (−0.047..+0.000) | +0.016 (+0.000..+0.047) | **+0.76 (+0.25..+1.30)** |
| both+ask − tools | **+0.484 (+0.359..+0.609)** | +0.031 (+0.000..+0.078) | −0.016 (−0.047..+0.000) | −0.21 (−0.68..+0.27)    |

- **Mix (1:1:8, assumed):**

  | condition | raised | false | $/1k (without background) | wall p50 |
  | --------- | ------ | ----- | ------------------------- | -------- |
  | tools     | 0.017  | 0.013 | 0.338                     | 4.78 s   |
  | eden      | 0.063  | 0.002 | 0.780                     | 6.07 s   |
  | both      | 0.053  | 0.013 | 0.530                     | 5.39 s   |
  | both+ask  | 0.066  | 0.003 | 0.584                     | 5.46 s   |

- **Uptake (hidden, both+ask):** the planted item reached the agent in a packet on 32 tasks (raised on all 32), only
  through an ask on 8 (raised 0.875), and neither way on 24 (raised 0.125).
- **Reading.** both − eden reproduces RealUse-1's direction (−8.6 there, −9.4 here, this time with an interval that
  touches zero). Adding the ask turns the gap into a tie with eden, at below eden's cost and Eden time on the path.
  With the ask available, the agent searched less (1.55 tool calls against 2.13). The both+ask control rate (2 of
  64) and the both − eden pair are within noise at this n.

## 3. Benchmark gaps (issue 12)

### (a) Regrade with a stronger grader

`regrade.ts` now sends a `claude-*` grader through the lab provider on the ledger (no OpenRouter key needed) and
splits agreement by task kind (`regrade-kinds.ts`). For thinking off, the lab's Anthropic client now sends
`between_tools` for Sonnet 5.5, which rejects `disabled`; Sonnet 5.5's price ($2 / $10 per MTok) is now listed.

```bash
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results .local/ab/s3b-ask-41.json \
  --graders claude-sonnet-5-5 --spend-ledger .local/ledger.jsonl --spend-cap 4 --spend-headroom 0.3 \
  --run-label s3b-regrade-41 --out .local/ab/regrade-41.json
```

The regrade covered seed 41 of section 2's run: 384 answers, all readable, 0 errors, **$0.543**. Summary:
`packages/sim/lab/fix-s3b/regrade-41.json`.

| kind    | agree     | Sonnet only true | Haiku only true | true (Sonnet / Haiku) |
| ------- | --------- | ---------------- | --------------- | --------------------- |
| hidden  | 122 / 128 | 5                | 1               | 65 / 61               |
| control | 126 / 128 | 0                | 2               | 0 / 2                 |
| neutral | 122 / 128 | 4                | 2               | 4 / 2                 |
| all     | 370 / 384 | 9                | 5               |                       |

By condition (`regrade-by-condition.txt`, from `regrade-by-condition.py`), Sonnet would change the hidden rates by one answer for eden (+1 of 32), tools (+1) and both+ask (−1),
and by three for both (+3). For eden on neutral it finds 3 answers of 32 raising a concern where Haiku found none.
The Haiku grader errs slightly toward strictness on hidden and neutral; no comparison of arms changes direction.

### (b) Synced users in `sim:perf memory`

Until now `packages/sim/src/server.ts` built the default engine (sync on) but never ran its sync. Users were tracked
and never backfilled, so `sim:perf memory` has always measured unsynced users.

- `--sync on` runs the sync as the shipped server does (`startSync`) and adds `POST /sim/sync-warm`, which ticks the
  sync until every tracked user is warm.
- `perf-cli.ts memory --synced` warms each step's users before taking its reading. Its default steps are 100, 250 and
  500 users; `--steps` sets them.
- The old default is unchanged, so earlier figures stay comparable.

```bash
bun run sim:perf memory --synced    # .local/perf/mem-synced.json
bun run sim:perf memory             # .local/perf/mem-unsynced.json (the old scenario, rerun for comparison)
```

Eden-only memory is each reading minus the zero-user reading (the in-process sim worlds: 1,127 / 1,131 MB RSS):

| mode     | users | Eden RSS MB | Eden heap MB | MB per user (RSS / heap) | warm-up                     |
| -------- | ----- | ----------- | ------------ | ------------------------ | --------------------------- |
| synced   | 100   | 400.4       | 287.8        | 4.00 / 2.88              | 138 ticks, 1,788 calls, 52 s |
| synced   | 250   | 969.1       | 697.1        | 3.88 / 2.79              | 210 ticks, 2,679 calls, 81 s |
| synced   | 500   | 2,093.8     | 1,383.3      | 4.19 / 2.77              | 108 ticks, 4,458 calls, 87 s |
| unsynced | 1,981 | 5.8         | 75.1         | 0.003 / 0.038            | –                           |

- **Slopes through the origin.** Synced: 4.12 MB RSS and 2.77 MB heap per user. Unsynced: −0.02 and 0.04, which is
  noise around zero.
- **How many items each user holds.** A sim user's world lists about 1,520 items, so the synced heap works out to
  about 1.8 KB per item.
- **Arithmetic, not measured.** At 4.1 MB RSS a user, 15 GB holds about 3,700 synced users of this size. RealUse-1
  part E estimated 5,100–7,400 per 16 GB machine from about 2 MB per 500-item user.
- **One small anomaly.** The unsynced 2,000-user step read 1,981 users: some of the load generator's users never
  reached the server.
- Both summaries are in `packages/sim/lab/fix-s3b/`.

### (c) A multi-turn day (`pi-ab --day K`)

`pi-day.ts` and `pi-ab --day K` run one agent transcript and one Eden session per K requests of a stream:

- **The agent keeps its context.** It carries its messages, and the packets Eden gave it stay where it saw them
  (`placePackets`).
- **Each day ends with a recap turn,** measured and never graded: "Before I act on today's plans: give me a short
  recap of anything I should watch out for across everything we discussed today, with the specific times".
- **The world changes once, just before the recap.** Every clock time in the day's planted items moves (`shiftClocks`,
  and `shiftMeta` for a calendar start), the sources are reindexed, and with `--push` they signal the change.
- **Why only then.** The reviewer showed that moving an item after each request could put it into a later request's
  slot and change that request's grade. The two runs made with that first design were stopped and are not reported
  ($0.378, `s3b-day-41`, `s3b-day-42`).
- **Caveats.** A changed item misses the replay caches and is carded live. `lateItems` is not measured. The change
  lands after the recap hour's `sync.tick()`, so without `--push` Eden sees it before the recap only through an
  on-demand poll, which would lean a no-push day run toward stale; the runs here used `--push signals`.

```bash
.local/ab/run.sh 41 s3b-day2-41 tools,eden,both+ask --day 4    # and 42; the same flags as section 2 plus --day 4
```

heldout14 seeds 41–42, hidden, control and neutral, 16 days of 4 requests per condition and kind (576 graded runs, 0
errors, 0 ungraded, 144 recaps), **$0.412**. Summaries are in `packages/sim/lab/fix-s3b/` (`days.json`,
`day-report.txt`, `day-vs-single.txt`). Sums over 16 days per cell:

| condition | kind    | delivered | repeat (of changed) | `(shown above)` | ask repeats | changed | stale deliveries | recap old / new time |
| --------- | ------- | --------- | ------------------- | --------------- | ----------- | ------- | ---------------- | -------------------- |
| eden      | hidden  | 64        | 0 (0)               | 6               | 1           | 56      | 0                | **14 / 5**           |
| eden      | control | 63        | 0 (0)               | 9               | 1           | 54      | 0                | 6 / 9                |
| eden      | neutral | 35        | 0 (0)               | 7               | 0           | 0       | 0                | –                    |
| both+ask  | hidden  | 68        | 0 (0)               | 0               | 0           | 56      | 0                | **15 / 2**           |
| both+ask  | control | 64        | 0 (0)               | 4               | 1           | 54      | 0                | 8 / 6                |
| both+ask  | neutral | 35        | 0 (0)               | 0               | 0           | 0       | 0                | –                    |
| tools     | hidden  | –         | –                   | –               | –           | 56      | –                | 0 / 0                |
| tools     | control | –         | –                   | –               | –           | 54      | –                | 0 / 1                |

- **Repeats.** Eden never delivered an item twice in a day, and in the recap turn, the only turn after the change,
  it delivered no changed item's old text (it barely re-delivered changed items at all).
  `(shown above)` appeared 6–9 times per cell for eden: its ask answers deduplicate against earlier packets.
- **Stale facts.** On hidden days the recap names a changed item's old time far more often than its new one, under
  both Eden arms. The tools agent never named either: it rarely raised the planted item in the first place (rate
  0.172). The old time comes from the day's transcript; Eden does not deliver the revision on the recap, because the
  recap's words do not match the changed item and a re-delivery needs the item to rank.
- **The text check is approximate.** Any old clock time of the item counts, and another item could share it.
- **Grades within a day, against the same tasks run one per session (section 2):**

  | condition | kind   | day − single rate           | day − single wall         |
  | --------- | ------ | --------------------------- | ------------------------- |
  | both+ask  | hidden | **−0.109 (−0.203..−0.031)** | **−0.92 s (−1.32..−0.55)** |
  | eden      | hidden | −0.062 (−0.172..+0.047)     | **−0.88 s (−1.38..−0.40)** |
  | tools     | hidden | +0.000                      | **−1.26 s (−1.80..−0.70)** |

  Control and neutral changed by at most 1 of 64.
- **Why recall falls.** With its earlier turns in context, the agent made fewer `ask_context` calls (0.33 a hidden
  task for eden, against 0.66 when each request is its own session).
- **Wall times come from separate runs** made at different times, so they compare loosely; the drop is in every
  arm, Eden-free tools too.
- **What this suggests (not tried here).** A re-delivery of revised items on a recap- or summary-shaped request, and
  a look at why packets matter less once a transcript is long.

### (d) Cold-start enrichment cost per user

`cold-start.ts` builds the servers' own `buildPartner`, with the default configuration, the role budgets
(`DEFAULT_LIMITS`) and the $25 tenant cap. The card role is Haiku on Anthropic (lab transport), and nothing is
replayed: a new user's sync backfills from nothing and the enrichment runs on what it stored until it is idle.

```bash
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cold-start.ts --users train1:41 \
  --spend-ledger .local/ledger.jsonl --spend-cap 4 --spend-headroom 0.3 --run-label cold-train1-41
#   then --users train3:42,train5:43 --run-label cold-train35
```

| user      | items | sync calls | enrich wall | calls | tokens in / out | $        | sent / carded / with requests | over budget |
| --------- | ----- | ---------- | ----------- | ----- | --------------- | -------- | ----------------------------- | ----------- |
| train1:41 | 1,517 | 18         | 112 s       | 22    | 80.0k / 32.9k   | 0.021982 | 435 / 85 / 364                | 0           |
| train3:42 | 1,518 | 18         | 112 s       | 23    | 83.2k / 32.9k   | 0.022058 | 442 / 85 / 382                | 0           |
| train5:43 | 1,525 | 18         | 100 s       | 21    | 76.6k / 29.6k   | 0.019968 | 419 / 95 / 356                | 0           |

- **Mean $0.0213 and 22 calls per user** ($0.0640 and 66 calls for the three, the same on the ledger's `cold-*`
  labels).
- About 29% of a user's items are sent to the model; the rest are lean-skipped or prefiltered (`stats` in
  `packages/sim/lab/fix-s3b/cold-start.json`).
- Cold start uses about 9% of the $0.25 per-user-day budget and never hit it.
- On OpenRouter's price-sorted route the same tokens would be priced differently: this is the Anthropic-direct cost.

## Spend (ledger `.local/ledger.jsonl`)

| label | what | calls | $ |
| --- | --- | --- | --- |
| h15-cards, h15-intent, h15-intent-topup-b1, h15-intent-retry | heldout15 caches | 58 | 0.0352 |
| smoke-day | a 4-task `--day` smoke | 57 | 0.0249 |
| s3b-ask-41, s3b-ask-42 | both+ask live | 2,884 | 0.5084 |
| s3b-regrade-41 | Sonnet regrade | 384 | 0.5426 |
| s3b-day-41, s3b-day-42 | first `--day` design, stopped (not reported) | 1,989 | 0.3784 |
| s3b-day2-41, s3b-day2-42 | `--day 4` | 2,143 | 0.4121 |
| cold-train1-41, cold-train35 | cold start | 66 | 0.0640 |
| **total** | | | **1.965** |

## Code (all lab or lab-only)

| file | change |
| --- | --- |
| `pi-conditions.ts`, `pi-ab.ts` | `+ask`, `askTool`, `--day` |
| `pi-day.ts` (new) | the day mode's logic and measures |
| `regrade.ts`, `regrade-kinds.ts` (new) | Anthropic graders on the ledger; agreement by kind |
| `server.ts`, `perf-cli.ts` | `--sync on`, `/sim/sync-warm`, `warmAll`; `memory --synced`, `--steps` |
| `cold-start.ts` (new) | cold-start cost through `buildPartner` |
| `suites.ts`, `neutral.ts`, `cards-disk.ts` | heldout15 registered and covered |
| `packages/llm/src/anthropic.ts` | Sonnet 5.5 price; thinking off sent as `between_tools` for it (lab client, D97) |

Tests cover each: `pi-conditions`, `pi-day`, `regrade-kinds`, `perf-sync`, `suites`, `cards-disk` and `anthropic`.
The reviewer's first pass asked for changes:

- a typecheck error and a 121-column line;
- `--day`'s mid-day changes, its per-task session id and the recap's event;
- `meta.start` not moved with the text;
- dropped partial days.

All were fixed before the reported day runs.
