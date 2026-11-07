# CL5: long-horizon realism, neutral on train, heldout16, the cost screen, and the CL baseline

Status: 2026-11-07, branch `claude/cl5-lab` (from `claude/lucid-hypatia-v9wqk5` at `2c65a6f9a`). **Lab only: no engine
file changed.** Plan: [cost-latency-plan.md](cost-latency-plan.md), hypotheses H16–H18. Decisions D251–D253.

Every paid call went to the Anthropic API with `HAIKU_API_KEY`, `claude-haiku-5-5` in every role (agent, grader,
cards, intent, reader), through the lab provider (D97), with `OPENROUTER_API_KEY` unset, on one spend ledger
(`.local/cl5/ledger.jsonl`) with a hard cap of $2: **Anthropic-direct lab figures**. **Spent: $1.187.**

## In plain words

- **The CL baseline is measured, short and long, on train with neutral tasks.** On the assumed traffic (1 task in 10
  needs a fact, 1 is a look-alike, 8 need nothing), a Haiku agent with its own search tools costs $0.375 per 1,000
  tasks one request at a time and $0.286 over a user's eight days. With Eden instead (the shipped default), the
  steady state is $0.632 and $0.575: Eden is about $0.26–0.29 per 1,000 tasks above the agent alone in both horizons.
  Eden still raises the hidden fact far more often: 70.3% against 15.1% (short), 16 of 23 against 1 of 23 (long).
- **Almost all of the gap is Eden's reader.** Eden's per-task calls are $0.278 (short) and $0.250 (long) per 1,000
  tasks; the agent with Eden is cheaper than the agent alone only on the short horizon ($0.329 against $0.375), and
  slightly dearer on the long one ($0.306 against $0.286). The background while a user works is small ($0.020 per
  1,000 tasks), and a user's one-time backfill is about two cents ($0.0200 a user, measured cold).
- **Latency: Eden is 42% of the agent's wait in both horizons.** On nothing-to-add tasks it adds 0.89 s (short) and
  1.35 s (long) at the median pair; the reader is half (short) to two thirds (long) of Eden's own path.
- **A long horizon is now realistic** (`pi-ab --days`): one user per seed, eight days of 12–20 requests, each day
  mixing hidden, look-alike and nothing-to-add requests 1:1:8, Eden's state kept across days, the agent's transcript
  reset each morning, and one-time and steady-state costs reported apart.
- **Tuning can now see nothing-to-add turns** (train builds `neutral`), and a **$0 cost screen** prints Eden's reader
  calls and dollars a task from the paid reading replayed: 0.807 calls and $0.208 per 1,000 tasks on the mix.
- **`heldout16`**, a new blind suite for the CL wave's final check, is written, registered and cached, and unread.

## 1. H16: a long horizon as one user lives it (`pi-ab --days`)

`pi-user.ts` plans each seed's user: D days (`--days`), each of `--day-size` requests (default 12–20, drawn per day),
with `dayKinds`' split of the `--mix` (1:1:8 gives one hidden and one control request in a day of 12–14, two of each
in a day of 15–20), the requests drawn without replacement from the named suites' templates (each used once per user)
and shuffled within the day. `userWorldOf` plants every hidden request's item and every control request's decoy in one
world (refs renumbered across suites, never naming a template), dresses them and clears each request's calendar slot
as `worldOf` does, and counts **slot clashes** (a planted item in another request's slot): 0 for both users here.

| | Short horizon (unchanged) | Long horizon (`--days 8`) |
| --- | --- | --- |
| Worlds | one per suite × variant × seed | one per seed (the user) |
| Eden | a partner per world stream | one partner per user: sync, cache, cards and intent kept across all days |
| Eden session | one per request | one per day (`w<seed>:user:day<d>`) |
| Agent transcript | one per request | **reset each day**, kept within the day (requests, tool results, packets); not compacted |
| Day's end | — | pi-day.ts's recap turn (never graded; its cost reported apart), after the day's planted items move their times |
| Eden's clock | +1 h a request | +10 min a request (`--gap-min`), +2 h a night (`--night-h`): about 33 h over the run, as the short horizon's 32 h a world, since the world's "now" is fixed |

**Cost accounting** (`pi-cost.ts`, `pi-cost-report.ts`; it reads any pi-ab run):

- per task: the agent's calls and Eden's per-task calls (the reader);
- background while working: each Eden stream's cards and intent after its first request (`Background.cardsUsd` less
  the new `setupUsd`), spread over that user's tasks;
- one-time per user: the enrichment before the first request (`setupUsd`), or with `--lifetime` a measured cold start
  (`cold-start.ts --users user:41,user:42`: the same user's world, no replay, the servers' `buildPartner` wiring);
- **steady state per task** = per task + background while working; **all-in over the run** = steady + one-time
  spread over the user's tasks in this run (for a short run, also weighted 1:1:8 per kind); recaps apart; reader and
  Eden connector calls a task (timeline spans), the agent's tool calls, wall p50 and mean, and a per-day table.

The two users (seeds 41 and 42) had 8 days of 14,13,16,16,12,12,15,16 and 13,13,13,17,19,13,13,17 requests: 12/12/90
and 11/11/96 hidden/control/neutral, 232 tasks per arm in all. Cold start: $0.020753 (user:41, 21 card calls, 1,501
items) and $0.019326 (user:42, 21 calls, 1,495 items).

## 2. Neutral on train, and its paid reading

`suites.ts`' `withNeutral` gives train1–6 the `neutral` variant without touching their files: the control is planted
and taken out again, so the request text, detail and every RNG draw are the control's (and the hidden's), the world is
the unplanted one, and ids read `<suite>-neutral` (`suites.test.ts` checks the world equals the unplanted one, the
texts and the ids). `NEUTRAL_SUITES` gains train1–6 (and heldout16).

- **Cards and intent:** `cards-enrich.ts --funnel train --seeds 41,42,43,44 --dry` reads 6,891 unique items with or
  without the neutral worlds (they add none), with the same 68 uncovered prefilter-passing items as before (not a
  neutral gap) and 0 items missing intent requests: the replays cover neutral as they cover hidden and control.
  (The card files hold lines for the prefilter's passes; the live harnesses' enricher also sends other items, which
  it then cards live: see §5.)
- **The paid reader replay** (recipe 2a's cache) missed 608 neutral prompts. One metered live top-up (`bun run funnel
  -- --neutral --reader live`, ledger run `cl5-neutral-reader-topup`, $0.0765) added 306 lines, checked in as
  `packages/sim/lab/distilled/reader-haiku-train-4142-neutral.jsonl.gz` (plain md5 `aefb37aac34e826279f2e25db8d68b39`).
  Concatenated after the main cache, the funnel replays with 0 misses, hidden and decoy figures unchanged (313/384,
  127/384, 643 replayed, 0 missed). Neutral (seeds 41–42, 384 tasks): any packet 114/384, reader flagged any 41/384,
  ask 4.10 items a task, 2.59 connector calls a task.

## 3. H17: `heldout16`, the blind suite for the final check

Written by an author subagent that read only `hidden-heldout15.ts` (the format), the `HiddenTask` interface, the sim
world API (`world.ts`, `names.ts`, `text.ts`, `rng.ts`) and this goal; it opened no engine, ranking, prompt, research
or other suite file, and ran only a typecheck and a planting check. This session read its template names and its
counts only. By the author's count: 32 templates, 4 per life area (work, family, health, money, travel, home, admin,
social), none named as in heldout15; decoys 12 resolved, expired or superseded, 11 another entity or date, 9
prerequisite met; overlap 11 no shared content word, 11 a name only, 10 one topic word.

Its planted items' refs were changed after the review from `h16-<template>` (the pattern heldout13–15 use) to the
base world's `<kind>-<index>`, since the tools arm sees refs and a template name or an `h16-` prefix would tell the
agent; the wiring change reads no template and leaves the card and intent hashes (title and text) as they were.
Registered in `SUITES`, `UNRUN_BLIND` and `NEUTRAL_SUITES` (`suites.test.ts`: 32/32/0 planted at seeds 41 and 44, the
same texts across variants, out of `all`). Caches, `cards-enrich.ts --funnel heldout16 --seeds 41,42,43,44`, appended
to the checked-in files (each old file an exact prefix of the new):

- cards: +157 items, 16 calls, $0.0101 (`cl5-h16-cards`), into `cards-v2.jsonl`;
- intent: +226 items, $0.0244: 23 calls (`cl5-h16-intent`), 50 single-item top-ups (`cl5-h16-intent-topup-b1`) and
  one retry of a planted hidden item that came back with no requests (`cl5-h16-intent-retry`), into
  `intent-v2.jsonl.gz` (plain md5 `cf37764b2b64b7d522d1cd10daf6d8aa`, 8,011 lines);
- `INTENT_COVERS` gains heldout16 seeds 41–44; `cards-disk.test.ts` checks every planted item has requests.

**No funnel or agent has run on it.** It is reserved for the CL combination's final blind check.

## 4. H18: the cost screen

`bun run funnel ... -- --neutral --reader replay` now ends with `COST SCREEN` lines (`cost-screen.ts`, LAB.md recipe
2b): per kind and on the 1:1:8 mix, the reader's calls a task and their dollars as made (`readerCalls`, `readerUsd`,
new fields on every funnel row), connector calls a task and the ask's mean wall. The default on train seeds 41–42
(12 s at `--jobs 4`, $0):

| Kind | n | Reader calls a task | Reader $ / 1k tasks (as made) | Connector calls a task |
| --- | --- | --- | --- | --- |
| hidden | 384 | 0.84 | 0.2378 | 2.67 |
| control | 384 | 0.84 | 0.2422 | 2.70 |
| neutral | 384 | 0.80 | 0.1999 | 2.59 |
| **mix 1:1:8** | | **0.807** | **0.2079** | 2.61 |

Against the live Pi baseline below (Eden's per-task $0.278 short, $0.250 long; 1.01 and 0.91 reader calls a task) the
screen reads 75–83% of the dollars and 80–89% of the calls: the funnel asks once per task where Pi's agent asks when
it chooses (and on neutral tasks more often). Use it to rank levers that change how often or how expensively Eden
reads (H1–H5, H9, H14); levers on the agent (H8, H10–H13) need the live A/B, and a change to the reader's input misses
the cache (a small metered top-up, then replay).

## 5. The CL baseline (current default vs tools, Pi, train with neutral)

Both horizons: `--conditions tools,eden --config default`, train1–6, seeds 41 and 42 (one process each), the direct
market profile, `--push signals`, time scale 1, cards replayed from the checked-in caches merged
(`.local/cl5/cards-all.jsonl` = `cards-v2` + `cards-train` + `cards-train-4344`), intent replayed (`intent-v2.jsonl.gz`
by default, D158). Short: the first 16 templates of each suite (`--limit 16`) × hidden, control, neutral: 576 tasks
per arm, n = 192 per kind. Long: `--days 8`, 232 tasks per arm. 0 errors, 0 ungraded in every run.

```bash
# packages/sim/lab/cl5/run.sh LABEL [flags] wraps the common flags; from the repo root:
cat packages/sim/lab/cards/cards-v2.jsonl packages/sim/lab/cards/cards-train.jsonl \
  packages/sim/lab/cards/cards-train-4344.jsonl > .local/cl5/cards-all.jsonl
packages/sim/lab/cl5/run.sh cl5-short-41 --seeds 41 --variants hidden,control,neutral --limit 16 --budget 0.55
packages/sim/lab/cl5/run.sh cl5-short-42 --seeds 42 --variants hidden,control,neutral --limit 16 --budget 0.55
packages/sim/lab/cl5/run.sh cl5-long-41 --seeds 41 --days 8 --budget 0.35
packages/sim/lab/cl5/run.sh cl5-long-42 --seeds 42 --days 8 --budget 0.35
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cold-start.ts --users user:41,user:42 --days 8 \
  --spend-ledger .local/cl5/ledger.jsonl --spend-cap 2 --spend-headroom 0.1 --run-label cl5-cold \
  --out .local/cl5/runs/cold-user.json
R=.local/cl5/runs
bun packages/sim/src/lab/pi-cost-report.ts $R/cl5-short-4{1,2}.json                    # short-cost.txt
bun packages/sim/src/lab/pi-cost-report.ts $R/cl5-long-4{1,2}.json --lifetime $R/cold-user.json   # long-cost.txt
bun packages/sim/src/lab/pi-ab-report.ts $R/cl5-short-4{1,2}.json                       # short-report.txt
bun packages/sim/src/lab/pi-ab-report.ts $R/cl5-long-4{1,2}.json                        # long-report.txt
```

The four runs were concurrent (two long, two short) on the 4-core box. Reports: `packages/sim/lab/cl5/`.

### Cost, $ per 1,000 tasks

| | Short: tools | Short: eden | Long: tools | Long: eden |
| --- | --- | --- | --- | --- |
| Agent (mean per task) | 0.375 | 0.329 | 0.286 | 0.306 |
| Eden per task (reader, as made) | — | 0.278 | — | 0.250 |
| Eden background while working | — | 0.000 | — | 0.020 |
| **Steady state** (mean) | 0.375 | 0.607 | 0.286 | 0.575 |
| **Steady state, 1:1:8 mix** | 0.375 | **0.632** | 0.286 | **0.575** |
| One-time backfill per user | — | $0.0378 (in-run, 18 worlds a seed) | — | $0.0200 (cold start, measured) |
| **All-in over the run, 1:1:8 mix** | 0.375 | 0.763 | 0.286 | 0.748 (116 tasks a user) |
| Recap probes (total $, not tasks) | — | — | 0.0085 | 0.0102 |

- **The in-run backfill is mostly live, even with cards replayed** (found by the review): the default's enricher sends
  items the checked-in card files hold no line for (they hold the prefilter's passes; with intent on, more items are
  sent), and those are carded live. `cl5-long-41.cards.jsonl` holds 447 live lines, 370 of them null cards and 410
  with requests. So the in-run setup was $0.0180 and $0.0188 a long-horizon user, about 90% of the measured cold
  start, and $0.0378 a seed on the short horizon; the long horizon's all-in uses the cold start. This is how every
  earlier pi-ab run with `--cards` behaved (RealUse-2's "cards and intent backfill" column); a replay that covered
  those items would cut harness spend, not what a real user costs.
- The long run's tasks are already the 1:1:8 mix, so its mix and plain means agree. Short: the mix weighs per-kind
  means; `pi-ab-report.ts` gives the same 0.375 and 0.632 and the same backfill (its `bkfill` 0.131 = all-in less
  steady).
- All-in over a lifetime: $0.020 a user is $0.020 per 1,000 tasks at 1,000 tasks a user, so the steady state is the
  figure the goal is about; at 116 tasks (this run) it adds $0.17.
- Per day (long): no growth across days, as the transcript resets each morning (eden agent $0.212–0.407 per 1,000
  tasks by day, tools 0.178–0.449; long-cost.txt).

### Facts raised, false concerns, wall time

| | Short: tools | Short: eden | Long: tools | Long: eden |
| --- | --- | --- | --- | --- |
| Hidden fact raised | 29/192 (15.1%) | 135/192 (70.3%) | 1/23 (4.3%) | 16/23 (69.6%) |
| False concern, look-alike | 0/192 | 1/192 | 0/23 | 2/23 |
| Any concern, nothing planted | 1/192 | 1/192 | 0/186 | 1/186 |
| Wall p50, mix (s) | 4.87 | 6.08 | 1.92 | 3.32 |
| Eden's share of the critical path | — | 42% (2,267 ms mean) | — | 42% (1,602 ms mean) |
| Reader's share of Eden's path (neutral) | — | 46.4% | — | 67.8% |
| Reader calls a task | — | 1.01 | — | 0.91 |
| Eden connector calls a task | — | 6.73 | — | 4.94 |
| Agent tool calls a task | 3.37 | 0.96 | 1.38 | 0.37 |

Paired differences (eden − tools, bootstrap 95% over tasks, pi-ab-report.ts):

- Short: hidden rate +55.2 points (+47.4..+63.0); wall hidden −0.23 s (−0.57..+0.12), control +0.23 s (−0.12..+0.57),
  neutral +0.89 s (+0.55..+1.23); $/1k hidden +0.185, control +0.243, neutral +0.268 (all intervals above 0).
- Long: hidden +65.2 points (+43.5..+82.6, n = 23); control false concerns +8.7 (+0.0..+21.7, n = 23); neutral +0.5
  (+0.0..+1.6); wall neutral +1.35 s (+1.04..+1.66); $/1k neutral +0.290 (+0.256..+0.325).
- Reader on Pi (short): 579 calls, p50 1,103 ms, mean out 167 tokens.
- Long-horizon day measures (`daysPooled`): Eden delivered 171 items over 16 days, 20 of them again within a day and
  all 20 changed since (revised copies), 18 "updated:" packets, 0 stale deliveries; recaps naming a changed item's old
  time only 5 (eden) and 2 (tools), its new time 7 and 2.

### What the baseline says for the goal

- The goal (all-in below the agent alone) needs Eden's steady state to fall by about $0.26 (short) to $0.29 (long)
  per 1,000 tasks. Eden's per-task calls are $0.25–0.28 of that, so even a free reader leaves the long horizon
  above tools unless the agent's own cost also falls with Eden (it does short, −$0.046, and not long, +$0.020).
- Why the long horizon's agent costs less with tools than the short (0.286 against 0.375): it makes fewer tool calls
  (1.38 against 3.37 a task; with Eden 0.37 against 0.96). A likely cause, not checked task by task: the day's
  transcript already holds what earlier requests searched.
- The neutral tasks are where Eden costs the most time (+0.89 s, +1.35 s) and where the reader is most of Eden's path:
  H8–H10 (no ask after an empty push, an ask answered from the push) target exactly that.

## Spend (ledger `.local/cl5/ledger.jsonl`)

| Ledger runs | What | $ |
| --- | --- | --- |
| cl5-neutral-reader-topup | train neutral reader top-up, seeds 41–42 | 0.0765 |
| cl5-h16-cards, cl5-h16-intent, cl5-h16-intent-topup-b1, cl5-h16-intent-retry | heldout16 caches | 0.0344 |
| cl5-cold | cold start, user:41 and user:42 | 0.0401 |
| cl5-smoke-long | the long mode's smoke (seed 41, 14 requests) | 0.0298 |
| cl5-short-41, cl5-short-42 | short baseline | 0.7216 |
| cl5-long-41, cl5-long-42 | long baseline | 0.2844 |
| **Total** | | **1.187** |

## Code (all lab)

`pi-user.ts` (+test), `pi-cost.ts` (+test), `pi-cost-report.ts`, `cost-screen.ts` (+test), `hidden-heldout16.ts`;
`pi-ab.ts` (`--days`, `--day-size`, `--mix`, `--gap-min`, `--night-h`; `setupUsd`; recap costs), `pi-day.ts`
(`recapOf`), `ab-common.ts` (`Background.setupUsd`), `suites.ts` (`withNeutral`, heldout16), `neutral.ts`,
`hidden-funnel.ts` (`readerCalls`, `readerUsd`), `funnel.ts` (the screen's lines), `cards-disk.ts` (heldout16 in
`INTENT_COVERS`), `cold-start.ts` (`user:SEED`).

## Caveats

- Long horizon n is small for rates (23 hidden, 23 control per arm); it is built for cost and latency, and its rates
  are a check that nothing broke, not an estimate to tune on.
- The short horizon ran the first 16 templates of each suite (half of train) to stay inside the $2 cap.
- The world's "now" does not move across a user's days; only Eden's clock does (10 min a request, 2 h a night).
- A day's planted items keep their moved times after the recap; a moved item could land in a later request's slot.
  Not counted at run time (0 slot clashes at build time).
- The short horizon's "one-time" in-run figure sums 18 worlds' backfills a seed that share one card cache: it is the
  harness's backfill, not one user's; the long horizon's measured cold start ($0.020) is the per-user figure.
  `--lifetime` now refuses a run without `--days`, a cold start of another user shape, and two rows for one seed.
- In day mode (`--day`, `--days`) every request of a day shares one Eden session, and the timeline's spans go to the
  task running when they land: a late trace or reader call of request i is counted on request i+1 (or the recap).
  The reader's dollars are charged to the task that started the call; its span count and other trace costs can move
  one request later. Pre-existing in `--day`; it moves cost between requests of a day, not out of the run.
