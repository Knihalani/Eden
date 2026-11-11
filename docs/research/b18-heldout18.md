# B18: the blind confirmation of tonight's wave on heldout18

Status: 2026-11-11, branch `claude/b18-heldout18` (from `main` at `5026ba51`, #243). Decisions D800–D802 (of D800–D809).
**Measurement only: no engine file changes.** Anthropic-direct lab figures (D97) throughout.

## In plain words

**Spent: $0.69** of the $15 Anthropic cap (4,364 calls, `packages/sim/lab/b18/spend.txt`), Modal $0 (not used).
Every run went once: 24 pi-ab processes, 0 errors, 0 ungraded, 0 retried requests, no restart.

- **Tonight's wave did not lower quality on a blind suite; on Sonnet's grade it raised it.** One request a session,
  the agent with today's default raises the hidden fact in **75 of 128** tasks (58.6%) against **63 of 128** (49.2%)
  with last night's: **+9.4 points (+1.6..+18.8)**. Over a user's days **9 of 16** against **7 of 16**: +12.5 points
  (0.0..+25.0 with whole users resampled; 16 tasks, a direction only).
- **On Haiku's grade the gain is not established.** 63 of 128 (49.2%) against 60 of 128 (46.9%): +2.3 points
  (−5.5..+10.2). Sonnet credits the `now` arm 12 more answers than Haiku did and the `pre` arm 3 more. Both grades
  agree that nothing got worse.
- **Eden's blind level is lower on this suite than on heldout17.** 49.2% Haiku-graded against A29's 73.4%, and last
  night's default reads 46.9% here, so the gap is the suite, not the wave. heldout18 was written to be harder: on
  its 13 short requests that name a person, date or thing the item words differently (`HELDOUT18_ANCHORED`, D466)
  the default raises 44.2% (Sonnet; 28.8% before tonight), on the other 19 templates 68.4% (63.2% before).
- **Eden against tools: +55.5 points (+39.8..+69.5), Sonnet, one request a session** (58.6% against 3.1%; Haiku
  49.2% against 2.3%, +46.9, +33.6..+60.2); over days 9 of 16 against 1 of 16. About a second faster (−1.06 s a
  task on the mix, −1.30..−0.80, the tools arm run minutes later) and level on cost ($0.205 against $0.202 per
  1,000 tasks; +0.003, −0.021..+0.026).
- **Concerns: none confirmed in any arm.** Haiku flagged one neutral answer in `now` (days) and one in `tools`
  (short), none in `pre`; Sonnet dropped both, and read by hand neither names a false problem. No control answer
  was flagged.
- **Cost and wall, now against pre.** One request a session: level ($0.205 against $0.204 per 1,000 tasks on the
  1:1:8 mix, +0.000, −0.016..+0.016; wall 1.86 against 1.85 s mean, p50 1.75 against 1.77). Over days: **+$0.018
  per 1,000 tasks (+0.014..+0.023)** and +0.06 s (+0.001..+0.121), four users. A new user's backfill costs $0.0062
  against $0.0060 and its cards finish in 2 to 5 s against 18 to 30 s (`cardsLanes` 4).
- **`pushOpen` stays in the default (D710's rule).** Hidden is not lower (the interval's upper bound is +18.8 short
  and +25.0 over days, far above 0) and confirmed concerns are 0 against 0. The `minus-open` arm was not run.

## 0. Pre-registration (committed and pushed before any paid call; nothing on heldout18 has been run or read)

**Question.** Did tonight's wave (#235–#243) change quality on a blind suite, and what is Eden's blind level now?

**Suite.** `heldout18` (M6, D465, D466): 32 templates, hidden / control / neutral variants, unread until this run.
This is its single use. Cards and intent replayed (cached for seeds 41–44; cards from `cards-v2` + `cards-train` +
`cards-train-4344` concatenated, as A29 did, 6,390 lines, md5 `a0e8399e965ead8d4b89bfc43ea97c0f` from either commit).

**Arms.** Three, each run once on the same tasks.

| arm     | what                                                                                                                                                          | checkout                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `pre`   | the shipped default as of `main` @ `e037a0eb` (#234, before tonight)                                                                                          | worktree at that commit                     |
| `now`   | the shipped default as of `main` @ `5026ba51` (#243: `pushOpen`, the `sourceYield` earn / names / engage switches, `syncKick`, `cardsLanes` 4, `sourceYield`) | this branch (lab and doc files only on top) |
| `tools` | the Pi agent alone with its source search tools                                                                                                               | this branch                                 |

**How two commits run the same tasks.** The `pre` arm's pi-ab process runs in a git worktree at `e037a0eb`
(`.local/b18/pre`), so engine and harness are both that commit's; `now` and `tools` run in this checkout. Each process
runs one arm (`--conditions eden` or `tools`, `--config default`) with the same flags, cards file, seeds and ledger
(`packages/sim/lab/b18/run.sh`). Checked at $0 before the run, with no task text printed
(`packages/sim/lab/b18/tasks-hash.ts`, run in each checkout): the sha256 of every task list and of every world
(short: seeds 41–44 × 3 variants; days: users 41–44) and the hash of the agent's and grader's prompts
(`armPromptsHash`) are identical at the two commits. The lab's card and intent caches and `hidden-heldout18.ts` do
not differ between the commits (`git diff --stat`); `pi-ab.ts` differs only by flags this run does not pass.
`merge.py` joins the three processes of a seed into one results file and refuses unless task list, seeds, model,
grader, harness version, prompts hash, time scale and tool execution are equal in all three.

**Harness (A29's, docs/research/a29-heldout17.md §0).** Pi (`pi-ab.ts`), `--config default`, `--tenant-prompt`
(the house rules, D271, cached) in every arm, market `direct` source profile, `--push payload`, time scale 1,
`claude-haiku-5-5` in every role (agent, grader, cards, intent, reader). One seed a process. Anthropic only
(`HAIKU_API_KEY`, `env -u OPENROUTER_API_KEY`), one ledger `.local/b18/ledger.jsonl` with a hard cap of **$15**. At
most two Anthropic processes at a time: for each seed the `pre` and `now` processes run side by side (same minutes,
same load, so their wall times are comparable), then the `tools` arm's short and days processes side by side.

**Runs (each once; a finished run is never run again, `run.sh` refuses; a crash before a results file is written
may be restarted and is reported).**

1. Short (one request a session): seeds 41, 42, 43, 44, hidden + control + neutral, 96 tasks a seed an arm (128
   hidden tasks an arm).
2. Days (a user's days): users 41, 42, 43, 44, `--days 2 --day-size 16` (heldout18's 32 templates bound a user, as
   heldout17's did; A29's shape), 32 requests a user on the 1:1:8 mix.
3. Backfill per user, reported apart: `cold-start.ts --users user:41,…,user:44 --suite heldout18 --days 2 --day-size
16`, once in each of the `pre` and `now` checkouts.

**Grading.** The run's grader is Haiku 5.5 (comparable with A29's 73.4%). Then Sonnet 5.5 regrades every hidden
answer and every control or neutral answer Haiku called a concern, in every arm (`i3-regrade.ts`, the Message
Batches form of `regrade.ts --graders claude-sonnet-5-5`, as tonight's runs used, D706, D710; if the batch route
does not work here, `regrade.ts` itself, the same prompt one call at a time). Levels and differences are reported on
both grades. A concern is **confirmed** when Haiku flagged it and Sonnet keeps it.

**Readout.**

- (a) `now − pre` on hidden facts raised, short and days separately, paired by task, bootstrap 95% intervals with
  5,000 draws: template-clustered for short (`bench_report.py`), user-clustered for days (`n5/days_hidden.py`) with
  the template-clustered one beside it. Each arm's level with it. Secondary: the two horizons pooled
  (template-clustered), the seeds 41–42 half alone (A29's scale), and the `HELDOUT18_ANCHORED` subset (D466).
- (b) Confirmed concerns (Sonnet) on control and neutral answers, per arm, as counts, short and days; each read by
  hand.
- (c) $ per 1,000 tasks on the 1:1:8 mix: steady (agent + Eden per task + background, `pi-cost-report.ts`) per arm,
  the backfill per user apart, and the paired `now − pre` with its interval (`n5/mix.py`).
- (d) Wall time on the 1:1:8 mix: p50 and mean per arm, the paired `now − pre` mean with its interval.
- (e) Eden against tools: `now − tools` (and `pre − tools`) on hidden facts, concerns, $ and wall, with the same
  intervals; the level beside heldout17's 73.4% against 4.7% (A29).

**Decision rule (D710, fixed before the run).** `pushOpen` stays in the default unless, on this run, either:

- **hidden lower:** on Sonnet's grade, `now − pre` on hidden facts has its 95% interval's upper bound below 0, on
  the short horizon (template-clustered) or on the days horizon (user-clustered); or
- **confirmed concerns up:** the `now` arm has more Sonnet-confirmed concerns than the `pre` arm, control and
  neutral answers of both horizons counted together.

If either happens, one more arm is run once on the same tasks, `eden~minus-open` at the current main (the default
with the part `open` off, `{"pushOpen":false}`), short and days, and `now − minus-open` is reported to attribute
the change. Nothing is tuned and nothing else is decided here: the wave's other parts are reported, not ruled on.

**Departures from A29, chosen before the run.** Four seeds instead of two (every seed the caches cover: the question
is a difference between two defaults, which two seeds cannot resolve; the 41–42 half is reported for continuity).
Each arm in its own process, the two Eden arms side by side and `tools` after them (A29 ran its arms in one
process), so `Eden − tools` wall times are from different minutes; said beside those numbers. Sonnet regrades
every hidden answer, not only concerns. Not run: A29's `eden+nokey` and `eden~nonudge` arms, its signals and refs
rows and its late-arrival row (none bears on the question).

**Before the run, on train only.** One small paid check that the scripts work at both commits (`train1`, seed 41,
`--limit 2`, each arm, merged and regraded), on the same ledger with the label `b18-smoke`. No heldout18 task is in it.

**Budget [EST].** Runs about $0.6, regrade about $0.3, backfill and smoke about $0.1. Modal is not used: every
process runs in this container.

Afterwards heldout18 leaves `UNREAD_BLIND` and is marked read in LAB.md (D466).

## 1. Runs

`packages/sim/lab/b18/all.sh`, 2026-11-11 08:34–08:51 UTC, in this container (4 cores, 15 GB), two processes at a
time. Cards replayed (6,095 distinct), intent replayed (1,472–1,528 of 1,478–1,534 items).

| run                   | arms, each its own process | seeds | tasks an arm                                  | $ (all arms) |
| --------------------- | -------------------------- | ----- | --------------------------------------------- | ------------ |
| `b18-short-<arm>-<s>` | pre, now, tools            | 41–44 | 96 a seed (32 hidden, 32 control, 32 neutral) | 0.295        |
| `b18-days-<arm>-<s>`  | pre, now, tools            | 41–44 | 32 a user: `--days 2 --day-size 16` (4/4/24)  | 0.111        |
| `b18-cold-<arm>`      | pre, now                   | 41–44 | the backfill of each days user                | 0.049        |
| `b18-regrade-sonnet`  | 434 answers, one batch     |       | 432 hidden, 2 flagged neutral                 | 0.223        |
| `b18-smoke-*`         | train1, 6 tasks an arm     | 41    | before the run, no heldout18 task             | 0.009        |

The merge check passed for all eight seed × horizon groups (task list, seeds, model, grader, harness version,
prompts hash, time scale, tool execution equal in the three processes).

## 2. Hidden facts raised (`levels.txt`, `bench-sonnet.txt`, `bench-haiku.txt`, `days-hidden.txt`)

Bootstrap 95%, 5,000 draws; short and pooled with whole templates resampled, days with whole users.

| horizon            | grade  | tools             | pre                    | now                        | now − pre              |
| ------------------ | ------ | ----------------- | ---------------------- | -------------------------- | ---------------------- |
| short (128 hidden) | Sonnet | 4 (3.1%, 0..7.8)  | 63 (49.2%, 35.2..63.3) | **75 (58.6%, 45.3..71.9)** | **+9.4 (+1.6..+18.8)** |
| short              | Haiku  | 3 (2.3%, 0..6.2)  | 60 (46.9%, 33.6..60.2) | 63 (49.2%, 35.9..62.5)     | +2.3 (−5.5..+10.2)     |
| days (16 hidden)   | Sonnet | 1 (6.2%, 0..18.8) | 7 (43.8%, 12.5..81.2)  | 9 (56.2%, 31.2..87.5)      | +12.5 (0.0..+25.0)     |
| days               | Haiku  | 0                 | 7 (43.8%, 12.5..81.2)  | 9 (56.2%, 31.2..87.5)      | +12.5 (0.0..+25.0)     |
| short + days (144) | Sonnet | 5 (3.5%)          | 70 (48.6%, 34.3..63.0) | 84 (58.3%, 44.3..71.7)     | +9.7 (+2.1..+18.5)     |
| short + days       | Haiku  | 3 (2.1%)          | 67 (46.5%, 33.8..59.9) | 72 (50.0%, 36.5..63.3)     | +3.5 (−3.6..+11.1)     |

Days with templates resampled: +12.5 (0.0..+26.3) on either grade. Short, Sonnet: 20 tasks raised only by `now`, 8
only by `pre` (McNemar in `bench-sonnet.txt`); Haiku: 13 and 10.

Secondary rows (short, `now − pre`):

| subset                                  | Sonnet: pre → now, difference      | Haiku: pre → now, difference      |
| --------------------------------------- | ---------------------------------- | --------------------------------- |
| seeds 41–42 (A29's scale, 64)           | 45.3% → 56.2%, +10.9 (−1.6..+23.4) | 48.4% → 46.9%, −1.6 (−14.1..+9.4) |
| `HELDOUT18_ANCHORED` (13 templates, 52) | 28.8% → 44.2%, +15.4 (+3.8..+30.8) | 28.8% → 30.8%, +1.9 (−9.6..+15.4) |
| the other 19 templates (76)             | 63.2% → 68.4%, +5.3 (−3.9..+17.1)  | 59.2% → 61.8%, +2.6 (−7.9..+11.8) |

The agent alone raised none of the 52 anchored tasks on either grade.

## 3. Concerns

| horizon | kind    | answers an arm | tools: flagged / confirmed | pre   | now   |
| ------- | ------- | -------------- | -------------------------- | ----- | ----- |
| short   | control | 128            | 0 / 0                      | 0 / 0 | 0 / 0 |
| short   | neutral | 128            | 1 / 0                      | 0 / 0 | 0 / 0 |
| days    | control | 16             | 0 / 0                      | 0 / 0 | 0 / 0 |
| days    | neutral | 96             | 0 / 0                      | 0 / 0 | 1 / 0 |

Read by hand: the `now` answer (days, user 44, a neutral request to book a table) says it can find no such booking
and names the user's other arrangement that week before drafting the request; the `tools` answer (short, seed 42)
says it found no clash and asks who to invite. Neither names a problem that is not there. Confirmed concerns:
**0, 0, 0**.

## 4. Cost and wall on the 1:1:8 mix (`short-cost.txt`, `days-cost.txt`, `short-report.txt`, `days-report.txt`, `mix.txt`)

Billed Anthropic-direct, first-party connectors (quota only). Steady = agent + Eden per task + background.

| horizon | arm   | steady $/1k | wall p50 / p90 / mean s | connector calls a task | agent tool calls a task |
| ------- | ----- | ----------- | ----------------------- | ---------------------- | ----------------------- |
| short   | tools | 0.202       | 3.12 / 4.29 / 2.95      | 2.05                   | 2.05                    |
| short   | pre   | 0.204       | 1.77 / 2.99 / 1.85      | 0.61                   | 0.59 (`ask_context`)    |
| short   | now   | 0.205       | 1.75 / 2.97 / 1.86      | 0.61                   | 0.55 (`ask_context`)    |
| days    | tools | 0.195       | 2.45 / 3.66 / 2.19      | 1.25                   | 1.25                    |
| days    | pre   | 0.199       | 1.18 / 1.62 / 1.27      | 0.00                   | 0.05                    |
| days    | now   | 0.219       | 1.18 / 1.83 / 1.33      | 0.00                   | 0.07                    |

Paired, per task (`mix.py`; agent + Eden per task, without the background, which is $0.000 short and $0.017–0.018
over days in both Eden arms):

| pair        | horizon | $/1k                    | wall s                  |
| ----------- | ------- | ----------------------- | ----------------------- |
| now − pre   | short   | +0.000 (−0.016..+0.016) | −0.004 (−0.109..+0.097) |
| now − pre   | days    | +0.018 (+0.014..+0.023) | +0.059 (+0.001..+0.121) |
| now − tools | short   | +0.003 (−0.021..+0.026) | −1.056 (−1.300..−0.804) |
| now − tools | days    | +0.005 (−0.034..+0.054) | −0.856 (−1.302..−0.310) |
| pre − tools | short   | +0.003 (−0.024..+0.027) | −1.052 (−1.293..−0.803) |
| pre − tools | days    | −0.013 (−0.055..+0.039) | −0.915 (−1.366..−0.377) |

The days intervals resample four users. The `tools` processes ran one to three minutes after the Eden arms' of the
same seed, so the wall pairs against `tools` are across minutes; `now` and `pre` ran side by side.

Backfill per user (`cold-start.ts`, users 41–44, reported apart): `pre` $0.0060 (5–6 card calls, 18 connector
calls, cards done in 17.6–29.6 s), `now` $0.0062 (6–7 card calls, 18 connector calls, cards done in 2.0–5.0 s).
`days-cost.txt` books the `now` figure to both Eden arms' all-in column.

## 5. The rule, applied (D710)

1. Hidden lower? `now − pre`, Sonnet: short **+9.4 (+1.6..+18.8)**, days **+12.5 (0.0..+25.0)**. Neither upper bound
   is below 0. **No.**
2. Confirmed concerns up? `now` 0, `pre` 0. **No.**

**`pushOpen` stays in the default.** The `minus-open` arm was not run, so the gain is the whole wave's (#235–#243)
and is not attributed to `pushOpen` or any other part here.

## 6. Against heldout17 (A29)

| figure (short, Haiku-graded as A29's) | heldout17, 2026-11-07 (seeds 41–42) | heldout18, pre (41–44) | heldout18, now (41–44) |
| ------------------------------------- | ----------------------------------- | ---------------------- | ---------------------- |
| hidden, Eden                          | 73.4%                               | 46.9%                  | 49.2%                  |
| hidden, tools                         | 4.7%                                | 2.3%                   | 2.3%                   |
| Eden − tools, points                  | +68.8 (+56.2..+79.7, task-level)    | +44.5 (+30.5..+57.8)   | +46.9 (+33.6..+60.2)   |
| $/1k mix, Eden / tools                | 0.305 / 0.218                       | 0.204 / 0.202          | 0.205 / 0.202          |
| wall mean s, Eden / tools             | 2.37 / 2.99                         | 1.85 / 2.95            | 1.86 / 2.95            |

The suites differ and so does the default (heldout17 was run four days and many decisions earlier), so the drop
from 73% is not attributed: last night's default, the nearest to A29's that ran here, reads 46.9% on heldout18, and
heldout18's anchored third pulls the level down (§2). A29's intervals were task-level; these are template-clustered
and wider for the same data. Eden's agent no longer costs more than the agent alone at first-party prices
(+$0.003, level; A29: +$0.087).

## 7. Departures from the pre-registration

- The `now` arm's checkout was at `d37adcc7` for seed 41 and at `b8a69df4` for seeds 42–44: a commit of
  `analyze.sh` and `levels.py` (two lab scripts, no other file) landed between them. Engine, harness and suite files
  are the same in both and in `5026ba51`.
- `days-cost.txt`'s one-time column uses the `now` backfill for both Eden arms; the `pre` backfill is given in §4.
- Nothing else: every run went once, no run was restarted, nothing was dropped, the batch regrade worked.

## 8. Caveats

- One blind suite, four seeds, Haiku as the agent. The same 32 templates recur in every seed, which is why the
  intervals resample templates; the days horizon has 16 hidden tasks and four users and gives a direction only.
- The two graders disagree on the size of the gain: +9.4 on Sonnet's grade, +2.3 on Haiku's. Tonight's train
  figures were Sonnet-graded (D706: +4.1 short for `pushOpen` alone), so Sonnet's is the like-for-like number;
  the Haiku interval includes both zero and Sonnet's estimate.
- Seeds 41–44 replay the lab's full intent index, about seven times what a deployment writes (D714); these are
  levels with that index, as every short figure on these seeds is.
- `Eden − tools` wall times are across minutes (§4). Cost is billed Anthropic-direct with prompt caching.

## 9. Reproduce

```bash
cat packages/sim/lab/cards/cards-v2.jsonl packages/sim/lab/cards/cards-train.jsonl \
  packages/sim/lab/cards/cards-train-4344.jsonl > .local/b18/cards-all.jsonl
git worktree add .local/b18/pre e037a0eb && (cd .local/b18/pre && bun install --frozen-lockfile)
S=$PWD/packages/sim/lab/b18/tasks-hash.ts; bun $S; (cd .local/b18/pre && bun $S)   # identical output, $0
packages/sim/lab/b18/all.sh                                                        # the 24 processes
# the backfill, in each checkout (label b18-cold-pre / b18-cold-now, out .local/b18/runs/cold-<arm>.json):
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cold-start.ts --users user:41,user:42,user:43,user:44 \
  --suite heldout18 --days 2 --day-size 16 --spend-ledger $PWD/.local/b18/ledger.jsonl --spend-cap 15 \
  --spend-headroom 0.1 --run-label b18-cold-now --out .local/b18/runs/cold-now.json
packages/sim/lab/b18/analyze.sh regrade                                            # merge, Sonnet batch, reports
```

Summaries: `packages/sim/lab/b18/` (`levels.txt`, `bench-sonnet.txt`, `bench-haiku.txt`, `days-hidden.txt`,
`mix.txt`, `*-cost.txt`, `*-report.txt`, `spend.txt`, `tasks-hash.txt`).
