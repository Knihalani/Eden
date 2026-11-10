# C4: Eden at 1,000 sources, part 7 (the ask stops waiting on live reads)

Status: measured 2026-11-10 on branch `claude/c4-ask-path` (from `main` at 314e2445), B1's next step
([b1-scale-path.md](b1-scale-path.md)). Decisions D430–D432. Paid calls: Anthropic API only, `HAIKU_API_KEY`,
`claude-haiku-5-5` in every role, `claude-sonnet-5-5` for the concern regrade, lab provider (D97),
`OPENROUTER_API_KEY` unset, own ledger (`.local/c4/ledger.jsonl`, hard cap $2): **Anthropic-direct lab figures**.
**Spent: $0.2731.** Every other figure is a $0 run. Machine: 4 vCPU, 15 GiB, Bun 1.4.4, `BUN_OPTIONS` unset.
Summaries of every run are in `packages/sim/lab/c4/`.

## In plain words

- **The problem.** After B1, a user with ~1,000 connected sources still had Eden spend over a second of each task on
  the agent's path, almost all of it in the agent's own `ask_context` calls. At the funnel's market latency an ask
  took **1,444 ms at the median** (five sources: about 3 ms). Two things made it wait, one after the other: the
  on-demand poll of stale synced copies (p50 574 ms, in every ask) and then the live searches of copies the user's
  item cap had cut (D264, p50 598 ms).
- **What changed (D430, promoted by D431: on in the default).** The ask now runs its lookup the way the push has run
  since B1. A warm copy answers from what Eden holds; the poll and the cut copies' live searches run behind, joining
  any read of the same source already in flight (the push's own poll and searches included); the ask does not wait
  for them (`askBehindWaitMs` 0). It stays honest (D127): a source still being read gets the status "searching" and
  the answer says "Still reading …: anything there that fits follows as a later packet … not an all-clear yet"; a
  poll that then fails is named as failed. If that work stores something the ask would now cite and the agent has
  not been handed, it goes out as a packet at the agent's next take.
- **What it did, live (Pi, train, seeds 41–42, 216 tasks an arm, paired, `--tenant-prompt`):**
  - **Eden's time on the agent's path: 1,163 → 62 ms a task** (paired −1,101 ms, −1,243..−969). The ask itself
    1,124 → 22 ms a task. The task's wall p50 fell 4.06 → 2.54 s.
  - **Hidden facts raised: 44/72 → 45/72** (paired +0.014, −0.069..+0.097): not worse.
  - **The ask still finds what the push missed.** Where both arms asked and no packet held the planted item, the
    ask cited it **17 of 17 → 17 of 17** (hidden) and 24 of 25 → 25 of 25 (control). Asks cited the planted item in
    fewer tasks overall (hidden 38 → 32), because the agent asked a little less (0.69 → 0.64 asks a hidden task) and,
    in two tasks, not at all; facts raised from a packet rose 36 → 40, from an ask alone fell 8 → 5.
  - **False concerns: none confirmed.** Haiku graded one control concern in each arm; Sonnet confirmed neither
    (control 0 → 0, neutral 0 → 0).
  - **Connector calls flat** (mix 39.74 → 39.79 a task, +0.06, −2.17..+2.16). **Cost down:** $0.604 → $0.507 per
    1,000 tasks on the 1:1:8 mix (first-party connectors; agent 0.314 → 0.257, cards in the background
    0.288 → 0.232); on Zapier MCP $1,112 → $1,120 (calls flat).
  - **The follow-up packet never reached the agent** in 432 tasks: the agent's next model request starts as the
    tool result lands, and what the reads behind stored that the ask would cite had nearly always been handed already.
- **At $0** (funnel, 995 noise sources, train1–6): surfaced hidden 77 → 77 (seed 41) and 77 → 77 (seed 42), decoys
  69 → 69 and 64 → 64, ask-cited +1 −0 and +0 −0, with no wait at all. With market latency (`--time 1`, train1–3):
  the ask **1,444 → 14 ms p50** (p90 1,511 → 19), the same items cited task by task. With five sources nothing
  moves: the funnel is 314/273 with the switch on and off, task by task identical.
- **A finding about the eval (D432).** `bun run eval` depends on the wall-clock date: on 2026-11-10 it reads
  precision 0.684 on `main` itself (recall 0.52, falseFireRate 0), and 0.65 with the clock pinned to 2026-11-07.
  This branch gives the same numbers as `main` under either clock.

## 1. Where the ask's time went

`latency-report.ts` on `bun run funnel --suite train1,train2,train3 --seeds 41 --jobs 1 -- --noise-sources 995
--limit 16 --time 1 --source-profile direct.json --push payload --timeline …` (the default, 96 asks):

| Piece of the ask | ran | p50 ms | p90 ms |
| --- | --- | --- | --- |
| the ask (whole) | 100% | 1,444 | 1,511 |
| `sync.freshen` (the on-demand poll, waited for) | 100% | 574 | 1,429 |
| `search` (live searches of cut copies, D264) | 100% | 598 | 1,036 |
| probes (not waited for, `probeGraceMs` 0) | 100% | 604 | 1,017 |

The poll and the search share one deadline (D140, 1.5 s), so the ask's p90 sits at the deadline. Joining the push's
in-flight searches alone could not help: the ask routes with its own words (Thompson draws apart from the push's) and
polls its own stale noise copies first.

## 2. The change

`askBehind` (D430; part `sync`, `docs/profiles/minus-sync.json`) and `askBehindWaitMs` (0):

- `ask()` calls `searchLive` with `behind` for an explicit ask (never for its own follow-up), so the poll runs behind
  (`syncPollBehind`) and the cut copies take B1's path (`pushCutBehind`'s `searchCutBehind`, through the planner).
  For an ask, `searchCutBehind` searches source by source (`cue.cutStatus`) and stores each page before noting its
  outcome, so a source reported answered was ranked on what it found. `searchLive` returns `behindLocal`: the chosen
  sources answered from a copy that was cut or not current.
- The ask waits `askBehindWaitMs` for `cue.polled` (`within`). `behindStatuses` then gives each such source the
  outcome of its live search if it has settled, "local" once its poll made it current, "searching" while the work
  runs, and "error" ("timeout" for a cut copy never searched) once the work is done and the copy is still not
  current. A whole stale copy whose poll failed is never "local" or "stale" (the 2026-11-05 audit's false all-clear;
  `review-regressions.test.ts` covers both waits).
- `reachAnswer` names "searching" sources apart from failed ones: "Still reading a, b, c and N more: anything there
  that fits follows as a later packet", and an empty answer reads "Nothing found yet. … so this is not an all-clear
  yet."
- `askLater`: once the work behind stored something new, the ask is ranked again with no second search
  (`internal.late`), and what it would cite that the answer did not, and that the ledger still holds fresh, goes
  through `verifyItems` and out as an `ask-behind:` packet (`ASK_LATE_LEAD`: found after the last answer, nothing has
  checked it against the question). Dropped for a closed session or after the next user message.

Its calls are the ones the ask made before: the poll's ("sync poll behind") and the searches' ("cut search behind")
traces sum to what the connectors received. At `--time 1` the ask's calls rose 44.99 → 46.70 a task: with D264 the
poll used up the lookup's deadline in slow asks, and 90 of 388 source searches were skipped as timeouts (reported
unreached); behind, the poll no longer eats the search's deadline (ok 191 → 261, timeouts 90 → 12). At time 0 and live
on Pi the calls are flat.

Unit tests: `ask-behind.test.ts` (4 cut sources, searches of 300 ms; off waits ≥ 270 ms and cites the fact; on, wait
20 ms: under 150 ms, "searching", "Still reading", not an all-clear, the fact in the follow-up packet, searches not
more, traced; wait 5 s: D264's answer and no follow-up; a follow-up dropped after the next request; two users'
follow-ups kept apart), and the two `askBehind` cases in `review-regressions.test.ts`.

## 3. $0 screens

Count screens, `bun run funnel --jobs 2 --suite train1..6 --seeds S --set SET -- --noise-sources 995 --limit 16`
(time 0), the default against `{"askBehind":true,"askBehindWaitMs":0}` (made while the switch was off), `ask-pair.py`:

| Seed | Arm | Hidden surfaced | Decoys surfaced | Ask-cited hidden | Paired ask-cited | Calls a task (hidden) |
| --- | --- | --- | --- | --- | --- | --- |
| 41 | default | 77/96 | 69/96 | 72 | – | 47.9 |
| 41 | `askBehind` 0 | 77/96 | 69/96 | 73 | +1 −0 | 47.8 |
| 42 | default | 77/96 | 64/96 | 74 | – | 48.7 |
| 42 | `askBehind` 0 | 77/96 | 64/96 | 74 | +0 −0 | 48.6 |

Delivered (the push) +0 −0 in both seeds. No planted item arrived only in a follow-up: in the funnel the ask comes
after the push's work behind has settled.

Latency, `--time 1`, train1–3, seed 41 (`latency-time1.txt`):

| Arm | ask p50 / p90 / p99 ms | ask-cited hidden / control | calls a task |
| --- | --- | --- | --- |
| default (D264) | 1,444 / 1,511 / 1,526 | 37 / 38 of 48 | 44.99 |
| `askBehind`, wait 300 ms | 313 / 319 / 349 | 37 / 38 | 46.70 |
| `askBehind`, wait 0 | 13.7 / 18.9 / 31.9 | 37 / 38 | 46.9 |

At 300 ms the work behind never settled in time (`ask.wait` p50 300, p90 301): the wait was the ask's whole time,
hence 0. Five sources, train1–6 seeds 41–42, switch on (promoted) against `--set '{"askBehind":false}'`: 314/273 both,
"hidden +0 −0, decoys +0 −0", ask-cited 305/261 both.

## 4. Live: Pi, train, seeds 41–42 (one arm and half a seed per process)

`pi-ab --noise-sources 995`, train1–3 and train4–6 halves, `--limit 6`, hidden/control/neutral, `--push payload`,
direct profile, time scale 1, `--tenant-prompt`, Haiku in every role, cards and intent replayed; `eden` (the default
then) against `eden~ab` (`{"askBehind":true,"askBehindWaitMs":0}`). 216 tasks an arm, paired by task (`a8/pair.py`,
`b1/path-pair.py`, `c4/ask-uptake.py`, `c4/route.py`).

| Arm | Hidden | Concerns control / neutral (Sonnet-confirmed) | Eden calls a task (mix) | Ask a task | Eden on the path | Mix $/1k first-party | Mix $/1k Zapier MCP |
| --- | --- | --- | --- | --- | --- | --- | --- |
| default | 44/72 | 1 / 0 (0 / 0) | 39.74 | 1,124 ms | 1,163 ms | 0.604 | 1,112.15 |
| `askBehind` | 45/72 | 1 / 0 (0 / 0) | 39.79 | 22 ms | 62 ms | 0.507 | 1,120.18 |

Paired, trial − default (bootstrap 95%): hidden +0.014 (−0.069..+0.097); control +0.000 (−0.042..+0.042); neutral
+0.000; connector calls on the mix +0.06 (−2.17..+2.16); mix $/1k −0.097 (−0.121..−0.073); Eden's path −1,101 ms
(−1,243..−969). By seed, the path: 41 −1,102 (−1,287..−916). The agent read fewer input tokens a hidden task
(2,909 → 2,712) on fewer asks; the rest of the agent's $/1k drop is not isolated here.

How the planted item reached the agent (hidden tasks; raised of each):

| Arm | In a packet | In an ask answer only | Neither |
| --- | --- | --- | --- |
| default | 36/43 | 8/21 | 0/8 |
| `askBehind` | 40/43 | 5/19 | 0/10 |

The tasks that moved (`route.py`'s pairing, `pi-ask-both.txt`): in two the trial's agent made no ask at all
(`mum-no-ibuprofen` seed 41, `india-evisa-on-hold` seed 42); the rest swap between packet and ask from run to run in
both directions. Where both arms asked and no packet held the planted item, the ask cited it in every hidden task in
both arms (17/17), and in 24/25 → 25/25 control tasks. Asks a task: hidden 0.69 → 0.64, control 0.89 → 0.81, neutral
1.08 → 1.10. Follow-up (`ask-behind:`) packets taken by the agent: 0 and 0; items left untaken at the task's end:
2 → 3.

Priced on market.py's connector plans (list prices, assumed), mix steady, $ per 1,000 tasks (`pi-cost-*.txt`):

| Plan | default | `askBehind` |
| --- | --- | --- |
| First-party APIs | 0.604 | 0.507 |
| Composio | 13.53 | 13.53 |
| Unified.to | 32.92 | 33.06 |
| Arcade.dev | 431.44 | 434.49 |
| Pipedream Connect | 517.60 | 521.29 |
| Zapier MCP | 1,112.15 | 1,120.18 |

Five sources, for scale: A21 measured Eden's path at 17 ms a task (not rerun here); 1,000 sources now 62 ms.

## 5. Decision

The brief's rule: promote only if hidden facts are not worse (paired) and Eden's path time falls. Hidden +0.014
(not worse), the path −1,101 ms with an interval far from zero, concerns not up after the regrade, calls flat, cost
down: **promoted (D431)**, with `askBehindWaitMs` 0. A trial switch opened and promoted the same day, so no trials-table
row (as D405/D406). Departs from D127's "an ask never passes `behind`" and from D264 on the ask; D127's honesty holds
through `behindStatuses` and the "searching" note.

## 6. What is left

- **The follow-up packet is plumbing that never fired live.** It stays for correctness (an ask must not drop what its
  reads behind find), but in Pi it arrived after the agent's next request every time. If a later measurement shows
  asks losing facts to it, a short wait for sources whose search is nearly done is the lever, not a fixed wait.
- **The answer's "Still reading" line** costs tokens on almost every ask at 1,000 sources (the sources it names are
  mostly noise copies). Not measured on its own.
- **The eval's clock (D432).** `bun run eval` should pin its clock, as `run.test.ts` and the funnel do; until then
  quote it with the date, or pin it with `packages/sim/lab/c4/clock.ts`.
- **A flaky test seen once.** `push-cut-behind.test.ts`'s "connector searches not more" failed once in four full
  `bun run check` runs on this branch under load, and never in 12 concurrent runs of the file on this branch or on
  `main`; not chased.

## Reproduce

```bash
unset BUN_OPTIONS
.local/c4/lat.sh t1-base '{}'    # = bun run funnel --suite train1,train2,train3 --seeds 41 --jobs 1 --set SET --json …
#   -- --noise-sources 995 --limit 16 --time 1 --source-profile …/direct.json --push payload --timeline …; latency-report
.local/c4/lat.sh t1-ab0 '{"askBehind":true,"askBehindWaitMs":0}'
F="bun run funnel --jobs 2 --suite train1,train2,train3,train4,train5,train6"
$F --seeds 41 --set '{"askBehind":false}' --json n41-base.json -- --noise-sources 995 --limit 16   # and 42
$F --seeds 41 --set '{}' --json n41-ab0.json -- --noise-sources 995 --limit 16
python3 -I packages/sim/lab/c4/ask-pair.py n41-base.json n41-ab0.json
R=packages/sim/lab/c4/run.sh; C="--limit 6 --variants hidden,control,neutral --noise-sources 995 --budget 0.3"
SUITE=train1,train2,train3 $R c4-base-41a eden~off --seeds 41 $C --variant-config '{"off":{"askBehind":false}}'
SUITE=train1,train2,train3 $R c4-ab-41a eden --seeds 41 $C
# and 41b (train4,5,6), 42a, 42b; then
S=.local/c4/runs; B=$S/c4-base-41a,$S/c4-base-41b,$S/c4-base-42a,$S/c4-base-42b; A=… the same for c4-ab
python3 -I packages/sim/lab/b1/path-pair.py base=$B ab=$A
python3 -I packages/sim/lab/a8/pair.py base=$S/c4-base-41a:eden,… ab=$S/c4-ab-41a:eden~ab,… --pair base,ab
python3 -I packages/sim/lab/c4/ask-uptake.py base=$B ab=$A; python3 -I packages/sim/lab/c4/route.py base=$B ab=$A
bun packages/sim/src/lab/pi-cost-report.ts $S/c4-base-41a.json …   # and ab
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results $S/c4-ab-41a.json --graders claude-sonnet-5-5 \
  --only-concerns --spend-ledger .local/c4/ledger.jsonl --spend-cap 2 --spend-headroom 0.1 --out $S/regrade-ab-41a.json
bun --preload ./packages/sim/lab/c4/clock.ts packages/eval/src/cli.ts   # the eval on 2026-11-07 (D432)
```

The runs above were made before the promotion, as `eden` (switch off, the default then) and `eden~ab` (switch on);
after D431 the same pair is `eden~off` and `eden`, as written above. `lat.sh` is in `.local/` (not committed); its
command is in its comment line above.

## Spend

| Run | $ |
| --- | --- |
| default, seed 41 (halves) / 42 (halves) | 0.0316 + 0.0379 / 0.0294 + 0.0460 |
| `askBehind`, seed 41 / 42 | 0.0295 + 0.0328 / 0.0239 + 0.0396 |
| Sonnet regrades (concerns only) | 0.0024 |
| **Total (ledger)** | **0.2731** |
