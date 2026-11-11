# B18: the blind confirmation of tonight's wave on heldout18

Status: 2026-11-11, branch `claude/b18-heldout18` (from `main` at `5026ba51`, #243). Decisions D800–D809.
**Measurement only: no engine file changes.** Anthropic-direct lab figures (D97) throughout.

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
