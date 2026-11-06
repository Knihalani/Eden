# RealUse-1 part A: held-out 14, blind funnel and Pi live (results)

Status: results, 2026-11-06. Design: [benchmark-realuse-1.md](../benchmark-realuse-1.md) (T1). Part A owns the new
blind suite `heldout14` and its live runs. Every paid call went to the Anthropic API with `HAIKU_API_KEY`,
`claude-haiku-5-5` in every role (agent, grader, Eden's cards, intent and reader), through the lab provider (D97), on
one spend ledger with a hard cap of $8 (`--spend-cap 8 --spend-headroom 0.3`), and `OPENROUTER_API_KEY` unset for
every command. These are **Anthropic-direct** figures: the servers ship Haiku through OpenRouter (D12).

**Spent: $1.1087** (ledger `.local/ledger.jsonl`, all labels below; nothing else was paid).

## The suite

`packages/sim/src/lab/hidden-heldout14.ts`, written by a subagent that read only `hidden-heldout13.ts` (the format),
`suites.ts`, `hidden-context.ts`'s `HiddenTask`, the sim world API (`world.ts`, `names.ts`, `text.ts`, `rng.ts`) and
the design; it opened no engine, source, reader or card prompt code and no research note. The session that wired and
ran it did not read its templates beyond their names. 32 templates, 4 per life area (work, family, health, money,
travel, home, admin, social), each with `hidden` (the consideration a good answer raises), `control` (a near-miss
decoy: about 11 resolved or superseded, 10 another entity or date, 8 prerequisite met, by the author's count) and the
new `neutral` (the same request, nothing planted). By the author's count about 12 planted items share no content word
with the request, 9 only a name, 11 one topic word. Registered in `SUITES` and `UNRUN_BLIND`.

What `neutral` means in each harness (`neutral.ts`):

- Funnel: no planted item, so the NEUTRAL line counts tasks with **any** packet delivered, items, bytes, ask items,
  calls and ms; reported apart from the score, never in `rows`, `total` or `perTask`.
- Pi/Hermes: kind `neutral`, the hidden detail as the must fact, and a grader prompt under which the listed fact **or
  any other** warning, clash, missing prerequisite or reason to change the plan counts as true. Its rate is "any
  concern raised", a false concern by construction.

## Replay caches (T2 prerequisite)

`cards-enrich.ts --funnel heldout14 --seeds 41,42,43,44 --model claude-haiku-5-5` into a copy of the checked-in
caches, then the new lines appended to `packages/sim/lab/cards/cards-v2.jsonl` (+182 items, 19 calls, $0.01212,
label `h14-cards`) and `packages/sim/lab/distilled/intent-v2.jsonl.gz` (+244 items: 234 in 25 calls, $0.02269,
`h14-intent`; one top-up call that returned nothing, $0.00077; the last 10 with `--batch 1`, 10 calls, $0.00128,
`h14-intent-topup-b1`). `INTENT_COVERS` gains heldout14 seeds 41–44. Caches: **$0.03686**.

## Blind funnel (T2, no model, run once)

```bash
env -u OPENROUTER_API_KEY bun run funnel --blind --suite heldout14 --seeds 41,42,43,44 \
  --json .local/A/funnel-h14.json -- --neutral
```

Shipped default, cards and intent requests replayed, `--reader stub` (nothing binds: delivery is the rule paths'),
4 processes (ms/task CONTENDED). Summary in `packages/sim/lab/realuse-1/A/funnel-heldout14.json`.

|                                                | hidden (128) | control (128) | neutral (128) |
| ---------------------------------------------- | ------------ | ------------- | ------------- |
| planted item surfaced (delivered or ask-cited) | 100          | 84 (decoys)   | –             |
| delivered (rule paths)                         | 33           | 28            | –             |
| reader pool holds the planted item             | 81           | 76            | –             |
| any packet delivered                           | 86           | 80            | 55            |
| items / packet bytes per task                  |              |               | 0.47 / 123    |
| ask items per task, connector calls per task   |              |               | 4.85, 2.94    |

Caveat, as the run printed it: this single blind run was made before the last 10 intent items were topped up, so 10
hidden planted items (seeds 41–42) had no intent replay line (`hidden 118/128` covered); the funnel was not rerun
(blind, once). This run also predates a review fix that runs neutral as its own phase: the run-wide sync, cards and intent counters in
its JSON include the neutral lanes (12 users for 3 variants × 4 seeds); the score, rows and NEUTRAL line are not
affected. The Pi runs below had the completed file (`intent: replayed 1517–1531 of 1523–1532 items`).

## Pi live (T1)

```bash
# one seed per process, 3 at a time; PROFILE direct (seeds 41-44, tools,eden,both) or hosted (41-42, tools,eden)
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite heldout14 --seeds $SEED \
  --variants hidden,control,neutral --conditions $CONDS --config default \
  --cards packages/sim/lab/cards/cards-v2.jsonl --cards-out .local/A/pi/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/$PROFILE.json --push signals --budget 1.5 \
  --spend-ledger .local/ledger.jsonl --spend-cap 8 --spend-headroom 0.3 --run-label $L --out .local/A/pi/$L.json
python3 -I packages/sim/lab/realuse-1/A/t1.py packages/sim/lab/realuse-1/A/t1-summary.json .local/ledger.jsonl \
  direct=<the 4 direct files> hosted=<the 2 hosted files>
bun packages/sim/src/lab/pi-ab-report.ts <each file>; bun packages/sim/src/lab/agent-ab-report.ts <files>
python3 -I packages/sim/lab/before-after/market.py .local/A/market.md direct=<4 files> hosted=<2 files>
```

Time scale 1 (sources at the profiles' latency), `--push signals`, default `--wait` (3,000 ms on the first observe).
1,536 direct and 384 hosted task runs, 0 errors, 0 ungraded, `overBudget: reader 0, cards 0` in every run. Pi's
`both` gets no `ask_context` (lab CLAUDE.md). Outputs: `packages/sim/lab/realuse-1/A/` (`t1-summary.json`, `t1.txt`,
the six `pi-ab-report` texts, both `agent-ab-report` texts, `market.md`).

### Outcomes and cost per arm, direct profile (seeds 41–44, n = 128 per cell)

rate: hidden facts raised (hidden), false concerns (control), any concern (neutral); ungraded results would be left
out (there were none). Eden on path: the union of Eden's spans on the agent's path (category eden, lane path: the
observe, the reader and every `ask_context` call), ms and share of wall time. $ per 1,000 tasks all-in: agent as billed
plus Eden's per-task calls (reader) + each seed's background (cards) spread evenly over its Eden streams' task runs
(`backfillShares`, so `bkfill` is the same for every kind).

| arm   | kind    | rate  | wall p50 / p90 / mean s | Eden on path ms (share) | agent $/1k | Eden task / bkfill $/1k | all-in $/1k |
| ----- | ------- | ----- | ----------------------- | ----------------------- | ---------- | ----------------------- | ----------- |
| tools | hidden  | 0.203 | 4.95 / 7.35 / 4.83      | 0 (0.000)               | 0.350      | 0.000 / 0.000           | 0.350       |
| tools | control | 0.000 | 5.02 / 7.66 / 5.01      | 0 (0.000)               | 0.351      | 0.000 / 0.000           | 0.351       |
| tools | neutral | 0.016 | 4.89 / 7.61 / 5.00      | 0 (0.000)               | 0.349      | 0.000 / 0.000           | 0.349       |
| eden  | hidden  | 0.656 | 3.88 / 7.43 / 4.53      | 1,638 (0.343)           | 0.332      | 0.287 / 0.113           | 0.732       |
| eden  | control | 0.000 | 5.04 / 8.02 / 5.13      | 2,032 (0.376)           | 0.353      | 0.355 / 0.113           | 0.821       |
| eden  | neutral | 0.055 | 5.57 / 8.48 / 5.77      | 2,389 (0.394)           | 0.362      | 0.391 / 0.113           | 0.866       |
| both  | hidden  | 0.570 | 4.78 / 7.81 / 5.24      | 1,111 (0.230)           | 0.332      | 0.204 / 0.113           | 0.649       |
| both  | control | 0.016 | 5.49 / 7.82 / 5.45      | 1,008 (0.199)           | 0.350      | 0.203 / 0.113           | 0.666       |
| both  | neutral | 0.023 | 5.48 / 8.77 / 5.73      | 973 (0.179)             | 0.349      | 0.175 / 0.113           | 0.638       |

Agent tokens per task (fresh input / cache read / cache write / output); the agent's connector searches; its
`ask_context` calls (not connector calls: the ask's own source calls are among Eden's); Eden's search / list / fetch;
reader calls, packets and packet bytes per task:

| arm   | kind    | tokens                | agent searches | ask_context | Eden s / l / f     | reader | packets | bytes |
| ----- | ------- | --------------------- | -------------- | ----------- | ------------------ | ------ | ------- | ----- |
| tools | hidden  | 6 / 2,048 / 519 / 527 | 3.09           | 0.00        | –                  | –      | –       | –     |
| tools | control | 6 / 2,104 / 464 / 543 | 3.15           | 0.00        | –                  | –      | –       | –     |
| tools | neutral | 6 / 2,126 / 461 / 539 | 3.24           | 0.00        | –                  | –      | –       | –     |
| eden  | hidden  | 3 / 466 / 879 / 434   | 0.00           | 0.57        | 0.47 / 3.27 / 4.05 | 1.06   | 1.11    | 445   |
| eden  | control | 4 / 699 / 889 / 469   | 0.00           | 0.91        | 0.55 / 3.42 / 4.94 | 1.33   | 0.84    | 315   |
| eden  | neutral | 5 / 976 / 834 / 494   | 0.00           | 1.22        | 0.89 / 3.31 / 5.89 | 1.58   | 0.50    | 146   |
| both  | hidden  | 4 / 1,839 / 528 / 494 | 1.97           | 0.00        | 0.22 / 3.23 / 2.42 | 0.77   | 1.06    | 419   |
| both  | control | 4 / 1,942 / 519 / 531 | 2.39           | 0.00        | 0.26 / 3.20 / 2.34 | 0.77   | 0.81    | 300   |
| both  | neutral | 5 / 2,080 / 482 / 535 | 2.92           | 0.00        | 0.36 / 3.23 / 2.25 | 0.74   | 0.48    | 141   |

"eden" is the agent with Eden as context and `ask_context` and no source tools. Fresh input is tiny because Anthropic's
prompt cache serves almost all of each request (cache read and write are billed at their own prices, `market.py`).

### Paired differences, bootstrap 95% (direct, n = 128 per kind)

A difference is called (bold) only when its interval excludes zero (design, "Gates").

| pair         | kind    | rate                        | wall s                   | all-in $/1k                 | connector calls          |
| ------------ | ------- | --------------------------- | ------------------------ | --------------------------- | ------------------------ |
| eden − tools | hidden  | **+0.453 (+0.352..+0.555)** | −0.30 (−0.75..+0.15)     | **+0.383 (+0.330..+0.441)** | **+4.69 (+3.98..+5.47)** |
| eden − tools | control | +0.000 (+0.000..+0.000)     | +0.13 (−0.26..+0.53)     | **+0.470 (+0.409..+0.531)** | **+5.76 (+5.11..+6.45)** |
| eden − tools | neutral | +0.039 (+0.000..+0.078)     | **+0.77 (+0.30..+1.26)** | **+0.517 (+0.454..+0.585)** | **+6.85 (+6.05..+7.80)** |
| both − tools | hidden  | **+0.367 (+0.273..+0.453)** | **+0.41 (+0.08..+0.73)** | **+0.300 (+0.272..+0.327)** | **+4.75 (+4.24..+5.30)** |
| both − tools | control | +0.016 (+0.000..+0.039)     | **+0.44 (+0.14..+0.76)** | **+0.315 (+0.286..+0.345)** | **+5.04 (+4.55..+5.61)** |
| both − tools | neutral | +0.008 (−0.023..+0.039)     | **+0.72 (+0.38..+1.07)** | **+0.288 (+0.263..+0.313)** | **+5.52 (+4.98..+6.09)** |
| both − eden  | hidden  | **−0.086 (−0.164..−0.008)** | **+0.71 (+0.30..+1.11)** | **−0.083 (−0.136..−0.035)** | +0.06 (−0.50..+0.59)     |
| both − eden  | control | +0.016 (+0.000..+0.039)     | +0.31 (−0.06..+0.69)     | **−0.155 (−0.213..−0.097)** | **−0.72 (−1.23..−0.22)** |
| both − eden  | neutral | −0.031 (−0.078..+0.008)     | −0.05 (−0.48..+0.38)     | **−0.229 (−0.288..−0.175)** | **−1.33 (−1.99..−0.70)** |

The control and neutral false-concern rates do not differ between arms by this gate: every interval touches or crosses
zero (eden − tools on neutral, +3.9 points, has its lower bound at 0.000: 7 of 128 eden answers raised a concern
against 2 of 128 tools answers).

### Traffic-weighted (assumed mix: 1 hidden, 1 control, 8 neutral in 10)

raised: share of all tasks raising the hidden fact (0.1 × hidden rate); wrong: share raising a wrong concern
(0.1 × control + 0.8 × neutral); wall p50/p90 from the pooled weighted samples. Intervals resample each kind's pairs on
their own.

| arm (direct) | raised | wrong | all-in $/1k (Eden) | wall p50 / p90 / mean s | connector calls | Eden on path share |
| ------------ | ------ | ----- | ------------------ | ----------------------- | --------------- | ------------------ |
| tools        | 0.020  | 0.013 | 0.349 (0.000)      | 4.90 / 7.55 / 4.99      | 3.22            | 0.000              |
| eden         | 0.066  | 0.044 | 0.848 (0.491)      | 5.42 / 8.25 / 5.58      | 9.74            | 0.387              |
| both         | 0.057  | 0.020 | 0.642 (0.294)      | 5.43 / 8.53 / 5.65      | 8.62            | 0.186              |

| pair (direct, mix) | raised                      | wrong                   | wall mean s              | all-in $/1k                 | connector calls          |
| ------------------ | --------------------------- | ----------------------- | ------------------------ | --------------------------- | ------------------------ |
| eden − tools       | **+0.045 (+0.035..+0.055)** | +0.031 (+0.000..+0.069) | **+0.60 (+0.22..+0.99)** | **+0.499 (+0.447..+0.553)** | **+6.53 (+5.81..+7.27)** |
| both − tools       | **+0.037 (+0.027..+0.045)** | +0.008 (−0.019..+0.036) | **+0.66 (+0.39..+0.95)** | **+0.292 (+0.271..+0.312)** | **+5.40 (+4.95..+5.87)** |
| both − eden        | **−0.009 (−0.016..−0.002)** | −0.023 (−0.061..+0.009) | +0.06 (−0.28..+0.41)     | **−0.207 (−0.255..−0.162)** | **−1.13 (−1.66..−0.60)** |

### Direct vs hosted connectors (seeds 41–42, n = 64 per kind)

Paired on the same 64 tasks, direct − hosted:

| arm   | kind    | rate                    | wall s                   | all-in $/1k                 | connector calls          |
| ----- | ------- | ----------------------- | ------------------------ | --------------------------- | ------------------------ |
| tools | hidden  | −0.031 (−0.094..+0.031) | **−1.07 (−1.52..−0.61)** | +0.007 (−0.015..+0.031)     | +0.00 (−0.28..+0.30)     |
| tools | control | +0.000 (+0.000..+0.000) | −0.33 (−0.83..+0.14)     | +0.024 (−0.003..+0.051)     | **+0.38 (+0.09..+0.69)** |
| tools | neutral | +0.016 (+0.000..+0.047) | **−0.81 (−1.33..−0.33)** | +0.012 (−0.015..+0.039)     | +0.08 (−0.28..+0.42)     |
| tools | mix     | −0.003 (−0.009..+0.003) | **−0.79 (−1.20..−0.39)** | +0.013 (−0.009..+0.035)     | +0.10 (−0.19..+0.39)     |
| eden  | hidden  | +0.016 (−0.062..+0.094) | −0.14 (−0.59..+0.31)     | −0.018 (−0.092..+0.060)     | +0.06 (−0.66..+0.80)     |
| eden  | control | +0.000 (+0.000..+0.000) | **−0.49 (−0.97..−0.02)** | −0.056 (−0.126..+0.016)     | −0.38 (−1.16..+0.39)     |
| eden  | neutral | +0.016 (−0.031..+0.062) | **−0.72 (−1.14..−0.30)** | **−0.116 (−0.195..−0.041)** | **−0.86 (−1.69..−0.02)** |
| eden  | mix     | +0.002 (−0.006..+0.009) | **−0.64 (−1.00..−0.30)** | **−0.100 (−0.163..−0.039)** | **−0.72 (−1.35..−0.05)** |

Hosted eden − tools (seeds 41–42): hidden rate **+0.406 (+0.266..+0.547)**, wall on hidden
**−1.02 (−1.74..−0.30)**; mix all-in $/1k **+0.631 (+0.565..+0.697)**, mix wall +0.52 (−0.11..+1.12).

### Cost per 1,000 tasks re-priced (`market.py`, direct; estimates, prices from eden-market-effect.md)

Agent re-priced per model from each request's token split; Eden's calls as billed on Haiku; connector calls priced per
plan; `ask_context` calls are not counted as connector calls (the ask's own source calls are Eden's). Full tables
(hidden, control, neutral; direct and hosted; "sync by push" column) in `market.md`.

| agent model | connector plan     | hidden: alone → + Eden   | neutral: alone → + Eden  |
| ----------- | ------------------ | ------------------------ | ------------------------ |
| Haiku 5.5   | first-party APIs   | 0.350 → 0.731 (+109%)    | 0.349 → 0.865 (+148%)    |
| Sonnet 5.5  | first-party APIs   | 6.994 → 7.040 (+1%)      | 6.984 → 7.734 (+11%)     |
| Opus 5.5    | first-party APIs   | 13.578 → 13.587 (+0%)    | 13.542 → 14.770 (+9%)    |
| Sonnet 5.5  | Composio (overage) | 7.922 → 9.374 (+18%)     | 7.956 → 10.762 (+35%)    |
| Opus 5.5    | Zapier MCP         | 93.397 → 214.344 (+129%) | 97.190 → 275.189 (+183%) |

Cost per hidden fact raised falls with Eden for the larger agents (Sonnet first-party $34.43 → $10.73, Opus $66.85 →
$20.70 per 1,000 hidden facts raised, `market.md`), since the hidden rate triples.

### Spend by role (ledger)

| run                                  | agent                  | grader   | Eden reader    | Eden cards     | total       |
| ------------------------------------ | ---------------------- | -------- | -------------- | -------------- | ----------- |
| Pi direct (4 seeds × 3 arms)         | $0.40037 (2,113 calls) | $0.08135 | $0.20682 (800) | $0.08690 (279) | $0.77544    |
| Pi hosted (2 seeds × 2 arms)         | $0.12358 (699)         | $0.02688 | $0.06927 (264) | $0.04283 (134) | $0.26256    |
| smoke (seed 41, 2 tasks per variant) | $0.00886               | $0.00167 | $0.00220       | $0.02110       | $0.03383    |
| caches (cards, intent)               |                        |          |                | $0.03686       | $0.03686    |
| **total**                            |                        |          |                |                | **$1.1087** |

## Reading

- **Raised:** Eden more than triples the hidden facts a Haiku agent raises on a suite it never saw: 0.203 → 0.656
  with Eden as context and `ask_context`, 0.570 beside the tools (`both`, no `ask_context`). Both differences are
  well clear of zero; `both` raises fewer than `eden` (−8.6 points, interval excludes zero).
- **Silence:** on control tasks no arm made a false claim worth calling (0/128 eden, 2/128 both). On neutral tasks
  (nothing planted, the most common real turn) eden raised a concern on 7 of 128, tools on 2, both on 3; no
  difference passes the gate, but eden − tools sits at its edge (+0.039, lower bound 0.000). The funnel's neutral
  run delivered some packet on 55 of 128 neutral tasks (0.47 items, 123 bytes a task): the live agent ignored most
  of that.
- **Cost:** Eden's all-in cost on a Haiku agent is +0.38 to +0.52 $/1k a task over the tools agent (about 2–2.5×
  the agent alone), highest on neutral tasks, where it reads most (1.58 reader calls, 5.89 fetches a task) and has
  least to say. In the 1:1:8 mix it is +0.50 $/1k (eden) or +0.29 $/1k (both). Re-priced for a Sonnet or Opus agent
  on first-party APIs that is +1% to +11%; on per-call connector plans the connector calls Eden adds dominate (its
  sync polls are 3.2–3.4 lists a task; the "sync by push" column of `market.md` removes them).
- **Latency:** on hidden tasks eden is not slower (−0.30 s, interval spans zero); on neutral tasks it adds 0.77 s, and
  in the mix 0.60 s on the mean; Eden is on the agent's critical path for 34–39% of an eden task's wall time (1.6–2.4
  s), 18–23% beside the tools. `both` costs +0.4–0.7 s on every kind.
- **Connectors:** hosted connectors cost the tools agent about 1 s a task over direct ones (paired, interval excludes
  zero) and Eden less (0.14 s on hidden, interval spans zero; 0.5–0.7 s on control and neutral). Quality does not
  change with the profile in either arm.

## Revisions

The figures above were recomputed after the reviewer's pass on the first version of this note (same runs, no new
spend): `ask_context` calls are no longer counted as connector calls (t1.py and market.py; it had added about one call
a task to the eden arm), the background spend is spread per seed as `backfillShares` does (it had been per stream, so
it differed by kind), percentiles use pi-timeline.ts's convention, and Eden on the critical path selects spans by
category (same result here: the ask's begin/end span on the background lane had already been counted). Rates and
their intervals did not change.

## Not run here

- **Hermes** (hermes vs hermes+eden, seeds 41–42): not run in this session. The checkout at commit 06433066 cloned,
  but `uv sync --frozen --no-install-project --extra mcp` in it was refused by the session's permission check: "The
  server-side auto mode classifier judged this action dangerous (it gave no explanation)". Not retried; the
  coordinating session runs Hermes on heldout14 from this branch instead.
- The Pi `both` arm has no `ask_context` (as every earlier Pi run); `eden` has no source tools.
- Live Pi reruns for a variance estimate (each cell is one sample of the agent and grader).
