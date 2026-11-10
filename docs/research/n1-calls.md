# N1: fewer connector calls at 1,000 sources (learned source yield, a lazy push, search reuse, batched probes)

Status: measured 2026-11-10 on branch `claude/n1-calls` (from `claude/lucid-hypatia-v9wqk5` at 3e10a6fe; the base's
later tips merged in at c3271fe7 and again before the last push; the gates were re-run on the final tree). Decisions D505–D509. Paid calls: Anthropic API only, the
Modal Secret `HAIKU_API_KEY`, `claude-haiku-5-5` in every role, `claude-sonnet-5-5` for the concern regrade, lab
provider (D97): **Anthropic-direct lab figures**, not the OpenRouter route the servers ship. **Spent: $3.894
Anthropic** of the $8 cap (five Modal runs $3.855, regrades $0.039; `manifest-*.json`). Modal: $0.66 billed for this
session's apps in the one full hour the billing report covered; the last quarter hour (six 16 GiB shards of about
six minutes) is not in it, about $0.2 more (**an estimate**). Train suites only; `heldout18` is not run or read. The
local-copy approach (F1's cold tier) is rejected by the owner and is not used or extended here: nothing in this note
keeps an item past the user's cap. Every other figure is a $0 run on a 4 vCPU, 15 GiB box, Bun 1.4.4, `BUN_OPTIONS`
and `OPENROUTER_API_KEY` unset. Summaries of every run are in `packages/sim/lab/n1/`.

## In plain words

- **The problem.** A user with about 1,000 connected sources cost ~40 connector calls for every task, almost all of
  them reads of sources that have nothing to do with what the user is asking: on a platform that bills each call
  that is about $1,000 per 1,000 tasks on the dearest plan, against ~$91 for the agent alone (A21's figure).
- **Where the calls were** (measured here, $0, per task): about 13 live searches of copies the item cap had cut, 16
  probes beside the push (a request's people and topic, sent to more sources), 5 probes beside the ask, and 13–16
  listings to refresh stale copies. Nine in ten went to noise connectors.
- **What now ships (D505, D509: `sourceYield`, on in the default).** Eden keeps, for each user and source, a count
  of the live reads the source answered since anything from it last reached the agent. Two learned rules then skip
  a read. A source read four times running with nothing used is left alone until the count fades (it halves every
  week). And, because with a thousand sources no single source is read often enough for that to matter, the user's
  reads are pooled by what the request had going for the source: nothing at all, or only shared words. Once a
  user's reads of that kind have clearly not been paying (surely under one use in twenty), sources that have never
  had anything used are no longer read on that kind of evidence. A source the request names a person or thing from
  is always read, and so is any source that has ever given the agent something. A skipped source still answers
  from the copy Eden holds; an ask says which sources it did not search and does not call that an all-clear.
- **What it did, live** (Pi, train, 995 noise connectors, 5% of connectors sending change notices, Haiku 5.5, paired
  by task, the rule as it ships):
  - **Connector calls: 38.6 → 26.5 a task one request a session** (−12.0, −13.5..−10.6) **and 35.9 → 11.1 a task
    over a user's eight days** (−24.7, −26.0..−23.5). A new user pays the first tasks in full while the rule
    learns; from the fourth day at $0 a request costs 6–11 calls.
  - **Hidden facts raised: 62.4% → 61.4%** (−1.1 points, −4.3..+2.2, 458 pairs, intervals clustered by template):
    no sign of a loss, at a resolution that would have found one of about 4.7 points.
  - **False concerns:** one in 1,045 control and neutral tasks against none, Sonnet-regraded (Haiku had graded 5
    against 0 one request a session; Sonnet confirmed none of them).
  - **Cost:** first-party $0.456 → $0.454 per 1,000 tasks (level). On a per-call plan, over days: Composio $12.09 →
    $4.22, Zapier MCP **$1,000 → $324 per 1,000 tasks**; one request a session Zapier $1,056 → $741.
  - **Stale and deleted deliveries** ($0, 16 users × 20 sessions): stale 15 → 12 of ~142 updates, deleted delivered
    3 → 3, deleted cited 14 → 14, with none or a fifth of change notices lost.
  - Nothing moves for a five-source user: the usual funnel is 314/274 with the rule on and off, task by task.
- **What was tried and deleted.**
  - **A lazy push (D506).** The push sent no live search; only the agent's own ask did. Calls fell further (37.2 →
    17.7 a task short, 36.0 → 12.1 over days), and over days no fact was lost. But one request a session hidden
    facts fell 2.3 points (−6.5..+1.8), stale copies delivered rose 15 → 19 of 142 at $0 (a live search re-reads an
    item at its source; without it the held copy goes out), and where nothing asks, recall fell from 0.53 to 0.40.
    So the push's background searches do buy facts and freshness. Deleted.
  - **Reusing a search's answer for 30 minutes (D507).** A user's searches do not repeat: 47.3 → 47.3 calls a task,
    57.2 → 57.2 over days. Deleted (the owner also cut it).
  - **One search of a source a lookup (D508).** Dropping a probe to a source the lookup already searches did not
    cut calls (47.3 → 49.3): the probes' budget went to other sources. Deleted.
- **What is left.** The rule never skips a read for a request that names a person some noise source also mentions.
  On the user-day bench, whose every request names a person, it saves about 1% (915 → 904 calls a day). And the
  background (~240 sweep and poll listings a user a day there) is untouched by anything here.


## 0. Pre-registration (committed and pushed before any paid call)

**The problem.** With about 1,000 connected sources Eden makes ~40 connector calls a task (A21, C4, F1), which on a
connector platform that bills per call is ~$1,100 per 1,000 tasks on Zapier MCP against ~$91 for the agent alone.

**What the $0 screens already showed (section 2; every figure there is from a command run in this session).** Four
hypotheses were built as trial switches and screened with no model:

| Hypothesis | Switch | $0 result | Goes live? |
| --- | --- | --- | --- |
| H1 learned per-source yield | `sourceYield` | calls 47.3 → 27.3 and 48.0 → 25.2 a task (short), 57.2 → 9.7 a request (8 days), no hidden fact lost, stale and deleted deliveries not up | yes |
| H2 lazy push | `pushLazy` 1 | calls 47.3 → 29.3 and 48.0 → 29.5 (short), 57.2 → 32.6 (8 days); surfaced facts level only because the screen asks once a request; stale deliveries 15 → 19 of 142 | yes, to measure what the push's searches buy; it already fails the stale rule |
| H3 search reuse within N minutes | `searchFreshMs` 30 min | calls 47.3 → 47.3, 57.2 → 57.2: a user's searches do not repeat | no: deleted (D507) |
| H4 one search of a source a lookup | `probeBatch` | calls 47.3 → 49.3, 48.0 → 49.8: the probes' budget is spent on other sources | no: deleted (D508) |

**Harness.** Pi (`pi-ab.ts`), `--config default`, `--tenant-prompt`, market `direct` source profile, time scale 1,
`--push payload`, `--noise-sources 995`, `--connector-mix 0.05,0.05` (5% of connectors push and have a change feed, 5%
a feed only, 90% neither: the owner's estimate, an assumption), `claude-haiku-5-5` in every role, cards `cards-v2` +
`cards-train` + `cards-train-4344` and the checked-in intent requests replayed. Suites `train`, one seed a shard on
Modal (`packages/sim/lab/n1/go.sh`), at most two Anthropic shards at a time.

**Arms** (one process runs all arms of its shard, paired task by task):

| arm | settings over the default |
| --- | --- |
| `eden` | none (the shipped default) |
| `eden~yield` | `{"sourceYield":true}` |
| `eden~lazy` | `{"pushLazy":1}` |

**Runs.**

1. **Short** (one request a session): `--limit 16 --variants hidden,control`, six train suites, seeds 41–44: 96 hidden
   and 96 control tasks a seed an arm (384 hidden pairs an arm).
2. **Long**: `--days 8`, one user a seed, seeds 41–46 (about 132 requests a user: about 14 hidden, 14 control, 104
   neutral).
3. **Regrade**: every control and neutral answer the Haiku grader called a concern, in every arm, with
   `claude-sonnet-5-5` (`regrade.ts --only-concerns`); Sonnet's verdict replaces Haiku's.

**Metrics** (effect = arm − `eden`, paired): hidden facts raised (points); regraded concerns on control and neutral
tasks; Eden's connector calls a task (in the task's window, and with its background); $ per 1,000 tasks first-party
and priced on the connector plans (`pi-cost-report.ts`, market.py's list prices, assumed); wall mean and Eden's time
on the agent's path. Intervals: 95% bootstrap with **templates resampled as clusters** (`bench_report.py`, 5,000
draws) for hidden facts, concerns, $ and wall; the task-level paired bootstrap of `a8/pair.py` for connector calls.
Reported per horizon and pooled.

**Rule (applied mechanically, per lever).** Promote into the default only if all hold:

- **hidden not worse:** the pooled hidden effect's point estimate is ≥ −2.0 points and its template-clustered
  interval is not entirely below zero;
- **calls fall:** the paired effect on Eden's connector calls a task has an interval entirely below zero on both
  horizons;
- **stale and deleted deliveries do not rise:** `quality-cli` (16 users × 20 sessions, 213 updates, 128 deletions,
  5/5/90, signal-only notices, 0% and 20% of notices lost): stale delivered, deleted delivered and deleted cited each
  at or below the default's count (already measured at $0: section 2);
- **concerns not up:** the pooled regraded concern effect's interval is not entirely above zero;
- **no extra paid cost (D112):** the pooled first-party $/1k interval is not entirely above zero.

Otherwise the switch, its code and its tests are deleted in this branch and the result stays in this note. With
about 470 hidden pairs the hidden interval will be several points wide: "not worse" means no sign of a loss at that
resolution, and the note will say what the run could have detected.

**Spend.** Anthropic hard cap $8 in all for this session, as per-shard caps: short $2.4 (4 shards), long $2.4 (6
shards), regrade at most $0.3. Modal credits under $15.

### 0b. Amendment (committed before the confirmation run; written after the short run was read, before the long run finished)

The reviewer's pass on the trial code (section 7) found that `sourceYield` as first built counted a live read when
it was sent, once for each lookup that joined the call: one connector call was often booked twice (the push and the
ask it starts share it), a failed call counted as a read with nothing used, and reads of sources the rule can never
skip filled the pools. The rule therefore learned about twice as fast as the calls it claims to count. Fixed before
any decision: a read is booked only when the connector answered, once a source a turn, only for a warm copy; a whole
copy keeps its on-demand poll; the pools remember a bounded number of reads. At $0 the fixed rule saves less on the
short horizon and nearly as much over days (funnel 47.3 → 33.3 and 48.0 → 31.0 calls a task, no fact lost; 8 days
57.2 → 13.1 a request, hidden 37/46 both; stale 12/142 against 15/143, deleted 3/14 both).

The runs registered above measure the rule **as first built** (`eden~yield` at commit 4dfc651c for the short run and
its successor for the long run, the same engine code). They stand as registered and decide `pushLazy`. For
`sourceYield` the decision is taken on a **confirmation run of the fixed code**, same harness, arms `eden` and
`eden~yield` only, short seeds 41–44 (`--limit 16 --variants hidden,control`) and long seeds 41–46 (`--days 8`), with
the same rule. The first-built arm's figures are reported beside it and not pooled with it. Caps: short $1.2, long
$1.2 (inside the session's $8).

## 1. Where the calls are

`bun run funnel … -- --noise-sources 995 --limit 16 --call-split` (new: one line a process), seed 41, the default,
calls a task in the task's window (`call-split.txt`; two processes, train1–3 and train4–6):

| Per task | train1–3 | train4–6 |
| --- | --- | --- |
| All calls (the funnel's `calls/task` is 47.3 over both) | 49.6 | 45.2 |
| Noise connectors: searches / listings | 30.4 / 12.9 | 28.2 / 9.8 |
| The world's five: searches / listings | 3.7 / 2.7 | 4.4 / 2.7 |
| By what made them: on-demand polls | 15.5 | 12.6 |
| the push's probes | 15.6 | 15.9 |
| live searches of cut copies (push and ask) | 13.0 | 11.8 |
| the ask's probes | 5.5 | 5.0 |
| Distinct sources searched | 23.9 | 23.2 |
| Searches repeating a (source, text) this user sent before | 1.2 | 0.8 |

So the largest single group is the probes, not D264's searches: with `probeYield` the first person's probe goes to
every source, bounded by `probeCalls` (8), and the probe economy's arms (128 a user) cannot learn a thousand
sources. About 24 distinct sources take 34 searches (H4's bound), and about one search a task repeats an earlier
one of the same user (H3's bound).

## 2. $0 screens

Every arm is `--set` over the default. Short: `bun run funnel --jobs 2 --suite train1..6 --seeds S -- --noise-sources
995 --limit 16` with 5% of connectors notifying (96 hidden and 96 control tasks a seed; `funnel-995.txt`). Long:
`days-calls.ts --noise-sources 995` (new), seeds 41–44, 8 days, 462 requests, one ask a request, cards replayed
(`days.txt`). Stale and deleted: `quality-cli` at a cap of 300 items so the five sources' copies are cut
(`freshness.txt`). The rows marked † ran before the merge of the base's later tip with F1's `--connector-mix
0.05,0.05`; `--notify-share 0.05` (D509) marks the same connectors, and the default and both live arms read the same
on either tree.

| Arm | Short: calls a task (41 / 42) | Surfaced hidden (41 / 42) | 8 days: calls a request | Surfaced over days (hidden / decoys of 46) | Stale / updates | Deleted delivered / cited | Recall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| default | 47.3 / 48.0 | 77 / 77 of 96 | 57.2 | 37 / 35 | 15/143 | 3/14 | 0.529 |
| `sourceYield` (as it ships) | 33.3 / 31.0 | 77 / 77 (+0 −0) | 13.1 | 37 / 35 | 12/142 | 3/14 | 0.522 |
| `sourceYield` as first built † | 27.3 / 25.2 | 77 / 77 (+0 −0) | 9.7 | 37 / 35 | 12/141 | 3/14 | 0.520 |
| `pushLazy` 1 | 29.3 / 29.5 | 77 / 76 (+0 −1) | 32.6 | 38 / 36 | 19/142 | 3/14 | 0.404 |
| `pushLazy` 2 (no push poll either) † | 21.4 / 21.8 | 76 / 75 | 23.2 | 37 / 36 | 35/129 | 3/14 | 0.389 |
| `searchFreshMs` 30 min † | 47.3 / 48.0 | 77 / 77 | 57.2 | 37 / 35 | – | – | – |
| `probeBatch` 2 † | 49.3 / 49.8 | 77 / 77 | – | – | – | – | – |

The freshness figures are the same with 20% of notices lost (`freshness.txt`). Over days the shipped rule's calls a
request, by day: 28.3, 18.0, 17.8, 6.6, 10.7, 5.6, 9.3, 8.5 (the default: 34.0, then 54.9–62.3): the first day is
the pools' warm-up. What is left at 13.1 a request: the world's own sources' searches 4.3 and listings 1.0,
noise searches 6.4 and listings 1.5. With the five-source worlds nothing is booked (no copy is cut, so no
live read is made): `bun run funnel --jobs 4` is 314/274 with the rule on and off, +0 −0.

Dead ends inside H1, each screened and dropped before the live runs:

- **A per-source run alone** (the brief's first form): 47.3 → 49–50 calls a task, nothing. Lookups draw their
  no-evidence sources by lot (Thompson sampling over a flat prior), so each of 995 sources is read about 0.4 times
  in a user's 16 tasks and no run ever fills. Hence the pooled rates.
- **A cap on reads the request has a name for** (`sourceYieldNamedRun` 4): saved 5 more calls a request over days
  but lost recall where sources are few (quality-cli 0.528 → 0.496, deleted cited 14 → 12): a user's own mailbox
  is named in most requests and goes four reads without a use easily. Removed; a named read is never skipped.
- **Counting the user's used sources' reads in the pools:** the pool of reads on words never emptied (the user's
  own mail is read on words and used, so the rate stayed high) and noise sources kept being read: 57.2 → 40.4.
  The pools now count only sources with nothing used yet, which are the ones they may skip: 57.2 → 13.1.
- **A third pool for named reads:** identical results to two pools on the funnel, over days and on quality-cli.
  Removed.

The user-day bench (`source-days.bench.ts 1000 20 8`, days 2–8, `user-day.txt`): all calls 914.7 → 903.6 a user a
day with the rule (searches 445.7 → 437.0, on-demand listings 227.3 → 224.0, background 241.7 → 242.6). Every
request of that bench names a person and its noise items name the same people, so its live reads are reads on a
name, which the rule never skips. That is the rule's known limit (section 6).

## 3. The switches

**`sourceYield`** (D505; part `sync`, `docs/profiles/minus-sync.json`; `source-yield.ts`, `SourceYield`):

| Piece | Where | What |
| --- | --- | --- |
| The record | `SourceYield`, per tenant/user and source | A run of live reads with nothing used (`empty`, halving every `sourceYieldHalfLifeMs`, a week), whether anything of the source ever reached the agent (`used`), and two pools a user: reads on no evidence and reads on words alone, each counting reads of sources with nothing used yet and how many of those sources then had a first item used. In memory, content-free, 4,096 sources a user, 1,000 users a tenant, dropped by `forget`. |
| A read | `noteLiveRead`, from `searchLive`, `searchCutBehind` and the probes | Booked when the connector answered ("ok"), once a source a turn, only for a warm copy's source. A failure, a timeout, a guard's refusal and a page from the fan-out's cache are not reads. |
| A use | `handOut` | Every path that gives the agent an injection: the packet's or the answer's sources end their runs. |
| The evidence | `evidenceFor` | 2: the request names an entity the source's items mentioned (the source map). 1: the routing boost is above zero (the request's words among the source's held items, D265, or in its sketch, D322). 0: nothing. |
| The skip | `spentSources`, in `searchLive` | A warm copy is spent for this request when its run is at `sourceYieldRun` (4) and the evidence is not a name, or when it has never had a use and the pool of the request's kind of evidence is spent (`poolSpent`: after 24 reads, the upper 90% bound of the Beta posterior of uses per read under `sourceYieldFloor`, 0.05). A spent copy gets no search behind, no probe (it joins the probes' `local` set and answers from what is held) and, if the cap cut it, no on-demand poll (`sourceYieldPolls`); a whole copy keeps its poll. |
| The ask | `UNSEARCHED`, `reachAnswer` | A cut copy the ask did not search has status "unsearched" (never "local", D127). The answer reads "Not searched past what is held of a, b, c and N more: nothing found there has been used lately", and an empty answer is "Nothing found in what was searched. … so this is not an all-clear." |

**`pushLazy`** (D506, deleted; code in 08af3ffc): 1, a lookup behind that is not an explicit ask sent no search
behind for cut copies and its probes answered cut copies from what is held; 2, it started no on-demand poll either.
**`searchFreshMs`** (D507) and **`probeBatch`** (D508), deleted; code in e7c92d82.

## 4. Live: the registered runs (`pushLazy`, and `sourceYield` as first built)

Pi, train, `--noise-sources 995`, 5% of connectors notifying, `--push payload`, direct profile, time scale 1,
`--tenant-prompt`, Haiku 5.5 in every role, cards and intent replayed; one seed a shard on Modal, two at a time,
no request retried on a 429 in any wave. Short: `--limit 16 --variants hidden,control`, seeds 41–44. Long: `--days
8`, seeds 41–46. Effects are arm − `eden`; hidden, concerns (Sonnet-regraded: Sonnet graded 17 answers and kept 3, one in the yield arm and two in the lazy arm),
$ and wall with template-clustered intervals (`bench-first.txt`); calls by `a8/pair.py`
(`pair-short-first.txt`, `pair-long-first.txt`).

| Arm − `eden` | Hidden, short (n 384) | Hidden, long (n 74) | Hidden, pooled (n 458) | Regraded concerns, pooled (n 1,045) | Calls a task, short | Calls a task, long (1:1:8) | First-party $/1k, pooled | Wall s, pooled |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `eden~yield` (first built) | −0.5 (−4.2..+3.4) | 0.0 (−6.8..+6.6) | −0.4 (−3.9..+2.9) | +0.1 (0.0..+0.3) | −12.2 (−13.6..−10.7)\* | −26.7 (−28.0..−25.6)\* | −0.005 (−0.010..−0.001)\* | −0.008 (−0.042..+0.027) |
| `eden~lazy` | −2.3 (−6.5..+1.8) | 0.0 (−7.2..+7.4) | −2.0 (−5.7..+1.7) | +0.2 (0.0..+0.5) | −19.5 (−20.4..−18.6)\* | −24.0 (−24.8..−23.2)\* | +0.002 (−0.003..+0.007) | −0.049 (−0.087..−0.010)\* |

Rates: `eden` raised 63.0% short and 52.7% long; calls a task 37.2 short (yield 25.0, lazy 17.7) and 36.0 long (9.3,
12.1). Eden's time on the agent's path, mean ms a task: short 215 / 201 / 112, long 25 / 24 / 19. One request a
session the lazy arm cost +$0.008 per 1,000 tasks (+0.000..+0.016): the agent's own tokens. Priced on market.py's
plans (list prices, assumed), steady, $ per 1,000 tasks (`pi-cost-*-first.txt`):

| Plan | `eden` short / long | `eden~yield` (first built) | `eden~lazy` |
| --- | --- | --- | --- |
| First-party APIs | 0.405 / 0.431 | 0.394 / 0.408 | 0.413 / 0.416 |
| Composio | 12.29 / 12.05 | 8.57 / 3.60 | 6.29 / 4.55 |
| Unified.to | 30.12 / 29.49 | 20.85 / 8.38 | 15.11 / 10.75 |
| Arcade.dev | 396.6 / 387.9 | 273.1 / 106.7 | 196.4 / 138.2 |
| Pipedream Connect | 475.9 / 465.4 | 327.6 / 128.0 | 235.5 / 165.7 |
| Zapier MCP | 1,022.6 / 1,000.0 | 703.9 / 274.7 | 505.9 / 355.8 |

**The rule, applied to `pushLazy`.** Hidden not worse: the pooled point estimate is −2.0, at the bound, with an
interval that reaches −5.7. Calls fall: yes. Stale and deleted do not rise: **no** (stale 15 → 19 of 142 at $0).
Concerns not up: yes. No extra cost: yes pooled. It fails; `pushLazy`, its code and its tests are deleted (D506).
What it measured stands as a finding: over a user's days, where earlier requests' searches have already filled
the copy, the push's own live searches bought no fact (39 of 74 in both arms); one request a session they bought
about two points and they are what keeps a delivered copy current.

## 5. Live: the confirmation run (`sourceYield` as it ships)

Arms `eden` and `eden~yield` at commit 0e06e94c (the fixes of section 7), the same harness, seeds and shapes
(`bench-confirm.txt`, `pair-*-confirm.txt`, `pi-cost-*-confirm.txt`). Sonnet graded 18 answers Haiku had called
concerns and kept 1.

| `eden~yield` − `eden` | Short (384 hidden, 384 control) | Long (74 hidden, 74 control, 587 neutral) | Pooled |
| --- | --- | --- | --- |
| Hidden facts, points | −1.0 (−4.7..+2.9); 63.0% against 64.1% | −1.4 (−11.1..+8.0); 52.7% against 54.1% | **−1.1 (−4.3..+2.2)**, n 458 |
| Regraded concerns, points | 0.0 (0 against 0) | +0.2 (0.0..+0.5; 1 against 0) | +0.1 (0.0..+0.3), n 1,045 |
| Eden's connector calls a task | **−12.0 (−13.5..−10.6)\***; 38.6 → 26.5 | **−24.7 (−26.0..−23.5)\*** on 1:1:8; 35.9 → 11.1 | – |
| First-party $ per 1,000 tasks | −0.003 (−0.012..+0.005) | −0.001 (−0.004..+0.002) | −0.002 (−0.006..+0.002) |
| Wall mean, s | −0.008 (−0.079..+0.059) | −0.030 (−0.056..−0.005)\* | −0.019 (−0.055..+0.020) |
| `ask_context` calls a task | −0.003 (−0.055..+0.048) | +0.005 (−0.008..+0.019) | +0.001 (−0.027..+0.029) |

Eden's time on the path: 120 → 118 ms a task short, 26 → 27 ms long. The run's minimum detectable hidden effect is
4.7 points pooled (5.3 short, 13.8 long): "not worse" here means no loss of that size. The exact paired counts:
the rule alone raised the fact in 28 tasks, the default alone in 33 (McNemar p 0.61, pairs taken as independent).
Haiku-graded, the short control concerns were 5 against 0 (+1.3 points, +0.3..+2.9); Sonnet confirmed none of the
five. The agent's answers relayed the "not searched" wording to the user in 3 of 768 short tasks. Priced, steady, $
per 1,000 tasks:

| Plan | `eden` short / long | `eden~yield` short / long |
| --- | --- | --- |
| First-party APIs | 0.443 / 0.468 | 0.452 / 0.459 |
| Composio | 12.72 / 12.09 | 9.06 / 4.22 |
| Unified.to | – / 29.53 | – / 9.87 |
| Arcade.dev | – / 387.9 | – / 125.9 |
| Pipedream Connect | – / 465.4 | – / 151.0 |
| Zapier MCP | 1,056.5 / 1,000.0 | 740.7 / 324.2 |

**The rule, applied to `sourceYield`.** Hidden not worse: −1.1 ≥ −2.0, and the interval is not entirely below zero.
Calls fall on both horizons, intervals entirely below zero. Stale and deleted do not rise (12 against 15; 3 and 14
both). Concerns: the interval is not entirely above zero (one concern in 1,045 against none). Cost: the interval
is not entirely above zero. All five hold: **`sourceYield` is promoted into the default (D509)**. Two things the
figures do not settle and the note should not hide: the hidden point estimate is below zero in both live runs (−0.4
first built, −1.1 as shipped; the two runs share tasks, not agent draws), and a real loss of up to about four points
is not excluded; the powered bench (28 seeds) would settle it for about $3. **It was run (N1b, D540–D541,
n1b-yield-bench.md): +0.5 points with the rule (−0.8..+1.8, n 2,632); the switch stays.**

## 6. What is left

- **Reads on a name.** A request that names a person is read at every source whose items mention that person, noise
  or not, and never skipped: all of the user-day bench's searches are such reads (how many of the 6.4 noise searches
  a request left over days are was not counted). A pool for them changed nothing on the lab's worlds and a per-source cap lost recall;
  the next thing to try is evidence of use by name (this source's mentions of this person have never been used).
- **The first day.** A new user pays ~28 calls a request while the pools warm (24 answered reads each). A prior
  taken from the tenant's other users would shorten it; not built (it crosses users, so it needs its own decision).
- **The background.** ~240 sweep and poll listings a user a day on the day bench are untouched (D356 already cut
  the sweeps for connectors with a fetch tool).
- **The probes at 1,000 sources.** `probeYield` sends the first person's probe to every source and its 128 arms
  cannot learn them (section 1); `sourceYield` now stops most of those calls, but the probe economy's own bound is
  still the wrong size for such a user.
- **Use is "reached the agent".** A look-alike that was handed over counts as a use and exempts its source from the
  pools. The usage inference (D13, D18: whether the agent's words echo the injection) would be a stricter signal;
  the $0 screens have no agent, so it can only be measured live.
- **An ask's wording.** "Not searched past what is held of …" is one more line in most asks at 1,000 sources. It
  moved neither the number of asks nor the regraded concerns here; it was not tested with another agent model.

## 7. Review

The `reviewer` subagent's pass on the trial code (`3e10a6fe..HEAD` at the time; REQUEST_CHANGES; `bun run check` and
`bun run eval` 0.65 / 0.52 / 0 clean; nothing changed with the switches off):

- **An ask could call a whole, stale, spent copy failed, or "still reading", when nothing was called** (the poll
  filter dropped its poll and only cut copies were named "unsearched"). Fixed: only a cut copy loses its poll.
- **One connector call was booked as two reads** (the push and the ask it starts each booked it), so runs and pools
  filled about twice as fast as the calls they count; cached pages and refused calls were booked too. Fixed: booked
  from outcomes, "ok" only, once a source a turn.
- **An outage counted as unused reads** and left a source unsearched after it recovered. Fixed by the same change.
- **The pools counted reads of sources the rule can never skip** (no warm copy) without bound, so a pool could stay
  spent for weeks after its reads stopped. Fixed: warm copies only, and a pool remembers at most 95 reads.
- **The tenant cap evicted by key prefix** (tenant "a" could drop a user of tenant "a/b"). Fixed: by tenant.
- **Tests** (`forget` never called, the probes off everywhere, no test of the poll filter, a vacuous level-2
  assertion), **the run's threshold** (decay made 4 reads read as 3.999) and **the hand-out credit on a closed
  session**: all fixed, each with a test (`source-yield-partner.test.ts`, `source-yield.test.ts`).

Because the first two changed what the rule learns from, the live decision rests on the confirmation run of the
fixed code (section 5), as the amendment in section 0b says.

## Reproduce

```bash
unset BUN_OPTIONS
bun test ./packages/engine/src/source-yield.test.ts ./packages/engine/src/source-yield-partner.test.ts
F="bun run funnel --jobs 2 --suite train1,train2,train3,train4,train5,train6"
$F --seeds 41 --json base-41.json -- --noise-sources 995 --limit 16 --notify-share 0.05       # and 42; the default
$F --seeds 41 --set '{"sourceYield":false}' --baseline base-41.json -- --noise-sources 995 --limit 16 \
  --notify-share 0.05 --call-split
bun packages/sim/src/lab/days-calls.ts --seeds 41,42,43,44 --days 8 --ask --push payload --noise-sources 995 \
  --notify-share 0.05 --cards CARDS [--set '{"sourceYield":false}']    # CARDS: lab/cards' three files in one
packages/sim/lab/n1/qrun.sh base-l0 0 '{"sync":true,"syncMaxItems":300,"sourceYield":false}'    # and lost 0.2
python3 -I packages/sim/lab/f1/fresh.py base-l0=.local/n1/q-base-l0.json …
bun packages/engine/bench/source-days.bench.ts 1000 20 8 '--config={"sourceYield":false}' > base.json
python3 -I packages/sim/lab/n1/user-day.py base=base.json yield=yield.json
bun run funnel --jobs 4 [--set '{"sourceYield":false}']; bun run eval                    # 314/274 both; 0.65/0.52/0
# Live (Modal; go.sh RUN SEEDS CAP CONDITIONS VARIANT_CONFIG EXTRA...). After D509 the pair is eden~off against eden:
VC='{"off":{"sourceYield":false}}'
MAX_STREAMS=60 packages/sim/lab/n1/go.sh n1-short 41-44 1.2 'eden~off,eden' "$VC" --limit 16 --variants hidden,control
MAX_STREAMS=4 packages/sim/lab/n1/go.sh n1-long 41-46 1.2 'eden~off,eden' "$VC" --days 8
bun packages/sim/src/lab/regrade.ts --results SHARD/out.json --graders claude-sonnet-5-5 --only-concerns \
  --spend-ledger L.jsonl --spend-cap 0.3 --spend-headroom 0.05 --out SHARD/regrade.json           # each shard
python3 -I packages/sim/modal/bench_report.py --pair 'eden:eden~off' --group short=.local/modal/n1-short \
  --group long=.local/modal/n1-long --sonnet concerns
packages/sim/lab/n1/pair.sh n1-short        # a8/pair.py; the script names the arms eden and eden~yield
```

The runs above were made before the promotion, as `eden` (switch off) and `eden~yield` (on), with F1's
`--connector-mix 0.05,0.05` in place of `--notify-share 0.05` (the same connectors notify). The registered runs
also carried `eden~lazy` (`LAZY=1 pair.sh`).

## Spend

| Run | Shards | $ Anthropic |
| --- | --- | --- |
| smoke (seed 41, `--limit 2`, three arms) | 1 | 0.026 |
| short, three arms, seeds 41–44 (registered) | 4 | 1.078 |
| long, three arms, seeds 41–46 (registered) | 6 | 1.116 |
| short, two arms, seeds 41–44 (confirmation) | 4 | 0.820 |
| long, two arms, seeds 41–46 (confirmation) | 6 | 0.815 |
| Sonnet regrades (concerns only, 35 answers) | – | 0.039 |
| **Total** | | **3.894** |
