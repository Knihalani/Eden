# RealUse-2: the finished default on Pi, blind on `heldout15`

Status: 2026-11-07, branch `claude/realuse2-pi`. **Measurement only: no engine file changed.**

This is the final blind check of the RealUse-1 fix effort ([realuse-1-weak-points.md](../realuse-1-weak-points.md)).
The tree under test is `claude/lucid-hypatia-v9wqk5` at `e484dfc6`, the finished default. It contains:

- wave 1 (D190–D221) and the wave-1 review fixes;
- W2a (D225–D229, parts deleted);
- W2b (D230–D231, trials deleted).

`heldout15` ([fix-s3b-lab.md](../fix-s3b-lab.md) §1) had never been run by a funnel or an agent before this session.
This is its first read, so the suite is now spent: a later blind round needs a new suite.

How the paid calls were made:

- Anthropic API only, `HAIKU_API_KEY`, through the lab provider (D97), with `OPENROUTER_API_KEY` unset.
- `claude-haiku-5-5` in every role: agent, grader, cards, intent and reader.
- One spend ledger with a hard cap: `--spend-ledger .local/ledger.jsonl --spend-cap 3 --spend-headroom 0.3`.

These are **Anthropic-direct lab figures**. The servers ship Haiku through OpenRouter (D12).

Raw outputs (answers stripped), reports and scripts are in `packages/sim/lab/realuse-2/pi/`:

- `pi-ab-report.txt`, `pairs.txt` and `arms.txt` (with `pairs.py` and `arms.py`);
- `r2-pi-4{1,2,3,4}.summary.json`;
- `funnel-h15.txt` and `funnel-h15.summary.json`.

**Spent: $1.021 of the $3 cap.** Ledger labels: `r2-smoke` $0.0378, `r2-pi-41` $0.2469, `r2-pi-42` $0.2478,
`r2-pi-43` $0.2438, `r2-pi-44` $0.2448. The funnel cost $0.

## In plain words

- **Eden alone raised the hidden fact 75.8% of the time against 16.4% for the agent with its own search tools.**
  That is +59.4 points (interval +50.8..+68.0) on 128 blind tasks. Eden did not raise false concerns more often: on
  neutral tasks it raised a concern 3 times in 128, against 8 times for tools.
- **The integrator shape (tools, Eden's context and `ask_context`) raised 68.8%.** That is +52.3 points over tools.
  It is 7.0 points _below_ Eden alone, an interval that just excludes zero (−13.3..−0.8). On heldout14 (S3b) this pair
  was a tie (+3.1, −7.8..+14.1). Tools plus context without the ask (59.4%) is again below Eden alone (−16.4,
  −24.2..−9.4). Adding the ask recovers most of that gap.
- **Eden costs time and money, less than in RealUse-1.**
  - Time: in the assumed traffic mix, Eden adds 0.91 s of mean wall time per task over tools (+0.62..+1.20).
  - Money: it costs $0.663 against $0.345 per 1,000 tasks all-in (+$0.319).
  - Path share: Eden is 39% of the critical path when it is the agent's only source.
- **The no-model funnel agrees in direction.** With a stub reader (nothing binds), the shipped default surfaced the
  hidden item on 104 of 128 tasks and the decoy on 80 of 128. 22 hidden and 11 decoys were delivered unasked.

## 1. Commands

Smoke check: the command below with `--seeds 41 --limit 2`. It produced 24 runs, 0 ungraded, for $0.0378.

The full run is one seed per process, two processes at a time (41→43 and 42→44), through `.local/r2/run.sh SEED`:

```bash
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite heldout15 --seeds $SEED \
  --variants hidden,control,neutral --conditions tools,eden,both,both+ask --config default \
  --cards packages/sim/lab/cards/cards-v2.jsonl --cards-out .local/r2/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push signals --budget 1.0 \
  --spend-ledger .local/ledger.jsonl --spend-cap 3 --spend-headroom 0.3 --run-label r2-pi-$SEED --out .local/r2/r2-pi-$SEED.json
bun packages/sim/src/lab/pi-ab-report.ts .local/r2/r2-pi-4{1,2,3,4}.json          # pi-ab-report.txt
python3 packages/sim/lab/realuse-2/pi/pairs.py .local/r2/r2-pi-4{1,2,3,4}.json     # pairs.txt
python3 packages/sim/lab/realuse-2/pi/arms.py .local/r2/r2-pi-4{1,2,3,4}           # arms.txt
bun run funnel --blind --suite heldout15 --seeds 41,42,43,44 --json .local/r2/funnel-h15.json -- --neutral
```

The run covered 1,536 task runs (4 seeds × 32 templates × 3 variants × 4 conditions), with 0 errors and 0 ungraded.
It used time scale 1, the direct profile, push signals, default `--wait`, parallel tools and Pi
`@earendil-works/pi-agent-core@1.3.0`. Each kind and condition has n = 128.

`pi-ab.ts` has no blind gate, so it ran heldout15 without a flag. The funnel took `--blind`.

The funnel prints `heldout15 … read before (D72, D80, D85, D98, D112): not a blind measurement`. That is its one
message for every suite in `UNRUN_BLIND`, and it is wrong for heldout15, which had no reads until this session.

### Replay coverage

- **Intent requests:** replay missed a few non-planted items per seed. Replayed: 1528 of 1534 (seed 41), 1531 of
  1541 (42), 1541 of 1544 (43) and 1539 of 1540 (44). Missed items went live. The funnel reports planted items covered
  128/128 hidden and 128/128 decoys.
- **Cards:** `cards-v2.jsonl` (4,996 lines) does not cover pi-ab's worlds, so each seed generated about 436 cards
  live: 61–65 calls, $0.020–0.023 per seed. That is the `bkfill` column below, $0.075 per 1,000 Eden task runs. S3b's
  heldout14 run shows the same $0.075/1k.
- **Funnel cards:** the funnel replayed 342 cards and left 1,351 uncovered (stub, $0).

## 2. Per arm and kind

Definitions follow [A-heldout14.md](../realuse-1/A-heldout14.md):

- **rate:** hidden fact raised (hidden), false concern (control) or any concern (neutral).
- **all-in $/1k:** agent as billed, plus Eden's per-task reader calls, plus each seed's background cards spread over
  its Eden task runs.
- **conn:** connector calls per task, counting the agent's `search_*` calls and Eden's `eden.source` spans.
- **reader:** Eden reader calls per task.
- **ask:** the agent's `ask_context` calls per task.

| arm      | kind    | rate               | wall p50 / p90 / mean s | all-in $/1k | conn | reader | ask  |
| -------- | ------- | ------------------ | ----------------------- | ----------- | ---- | ------ | ---- |
| tools    | hidden  | 0.164 (21/128)     | 5.12 / 7.93 / 5.04      | 0.358       | 3.05 | 0.00   | 0.00 |
| tools    | control | 0.008 (1/128)      | 5.14 / 8.06 / 5.06      | 0.360       | 3.09 | 0.00   | 0.00 |
| tools    | neutral | 0.062 (8/128)      | 5.03 / 8.16 / 4.96      | 0.341       | 3.19 | 0.00   | 0.00 |
| eden     | hidden  | **0.758 (97/128)** | 4.83 / 8.26 / 5.26      | 0.663       | 6.77 | 0.92   | 0.69 |
| eden     | control | 0.016 (2/128)      | 6.10 / 8.19 / 5.97      | 0.673       | 7.63 | 0.91   | 1.20 |
| eden     | neutral | 0.023 (3/128)      | 6.39 / 8.17 / 5.96      | 0.662       | 8.59 | 0.92   | 1.38 |
| both     | hidden  | 0.594 (76/128)     | 5.75 / 8.51 / 5.78      | 0.644       | 6.65 | 0.78   | 0.00 |
| both     | control | 0.031 (4/128)      | 5.99 / 8.80 / 5.90      | 0.635       | 6.54 | 0.77   | 0.00 |
| both     | neutral | 0.047 (6/128)      | 5.60 / 8.45 / 5.64      | 0.585       | 6.52 | 0.70   | 0.00 |
| both+ask | hidden  | 0.688 (88/128)     | 5.05 / 8.59 / 5.52      | 0.637       | 7.00 | 0.79   | 0.27 |
| both+ask | control | 0.008 (1/128)      | 5.95 / 8.87 / 5.79      | 0.649       | 7.26 | 0.78   | 0.38 |
| both+ask | neutral | 0.047 (6/128)      | 5.63 / 8.96 / 5.80      | 0.612       | 7.70 | 0.72   | 0.45 |

**Eden on the critical path.** These are means over all 384 tasks of a condition, from `pi-ab-report.txt`. Eden's
path spans are the observe, the reader and every `ask_context` call.

| arm      | Eden on path ms (share of wall) | hidden / control / neutral share | reader share of Eden's path (hidden) |
| -------- | ------------------------------- | -------------------------------- | ------------------------------------ |
| tools    | 0 (0%)                          | –                                | –                                    |
| eden     | 2,222 (39%)                     | 39.1% / 38.4% / 38.8%            | 50.5%                                |
| both     | 1,022 (18%)                     | 22.5% / 16.6% / 13.8%            | 64.9%                                |
| both+ask | 1,599 (28%)                     | 32.3% / 27.4% / 24.7%            | 50.8%                                |

**Uptake (hidden).** This is the raised rate split by how the planted item reached the agent:

- **eden:** in a packet 0.964 (n 83), only through an ask 0.739 (23), neither 0.000 (22).
- **both:** in a packet 0.890 (82), neither 0.065 (46).
- **both+ask:** in a packet 0.952 (83), only through an ask 1.000 (8), neither 0.027 (37).

The packet reached the agent on 82–83 of 128 hidden tasks in every Eden arm. The arms differ in what happens on the
other 45 or so tasks. Eden alone asks on them, 0.69 asks per hidden task, and the ask finds the item on 23. In
both+ask the agent searches with its own tools first, and the item reaches it only through an ask on 8.

## 3. Paired differences (bootstrap 95%, n = 128 per kind)

The method is `fix-s3b/pair.py`'s: 5,000 draws, seed 1. A difference is called (bold) only when its interval excludes
zero. Source: `pairs.txt`.

| pair             | hidden                      | control                 | neutral                 | hidden wall s            |
| ---------------- | --------------------------- | ----------------------- | ----------------------- | ------------------------ |
| eden − tools     | **+0.594 (+0.508..+0.680)** | +0.008 (−0.016..+0.031) | −0.039 (−0.094..+0.008) | +0.22 (−0.15..+0.58)     |
| both+ask − tools | **+0.523 (+0.438..+0.609)** | +0.000 (−0.023..+0.023) | −0.016 (−0.062..+0.031) | **+0.48 (+0.10..+0.85)** |
| both+ask − eden  | **−0.070 (−0.133..−0.008)** | −0.008 (−0.023..+0.000) | +0.023 (−0.023..+0.070) | +0.26 (−0.08..+0.59)     |
| both − eden      | **−0.164 (−0.242..−0.094)** | +0.016 (−0.016..+0.047) | +0.023 (−0.016..+0.062) | **+0.53 (+0.19..+0.87)** |

Wall time on control and neutral:

- **eden − tools:** +0.92 s (+0.55..+1.27) on control and +1.00 s (+0.65..+1.35) on neutral, both called.
- **both+ask − tools:** +0.73 and +0.83 s, both called.

The report's own bootstrap also gives:

- **both+ask − both:** hidden **+0.094 (+0.023..+0.164)**.
- **both − tools:** hidden **+0.430 (+0.336..+0.516)**.

None of the four pairs has a control or neutral interval that excludes zero, so no arm raises more false concerns than
another at this n.

## 4. Traffic mix (assumed: 1 hidden, 1 control, 8 neutral in 10)

The 1:1:8 split is **an assumption, not a measurement**. In this section:

- **raised:** 0.1 × the hidden rate.
- **wrong:** 0.1 × control + 0.8 × neutral.
- **intervals:** each kind is resampled on its own.

Source: `arms.txt`. The report's own mix lines (agent + per-task Eden, without background) are in
`pi-ab-report.txt`.

| arm      | raised | wrong | all-in $/1k | wall mean s | wall p50 / p90 s | conn | reader | Eden on path share |
| -------- | ------ | ----- | ----------- | ----------- | ---------------- | ---- | ------ | ------------------ |
| tools    | 0.016  | 0.051 | 0.345       | 4.98        | 5.03 / 7.98      | 3.16 | 0.00   | 0%                 |
| eden     | 0.076  | 0.020 | 0.663       | 5.89        | 6.17 / 8.17      | 8.31 | 0.92   | 39%                |
| both     | 0.059  | 0.041 | 0.596       | 5.68        | 5.65 / 8.45      | 6.54 | 0.71   | 15%                |
| both+ask | 0.069  | 0.038 | 0.618       | 5.77        | 5.59 / 8.93      | 7.58 | 0.73   | 26%                |

(Eden-on-path share in the mix weights the per-kind shares of §2 1:1:8.)

| pair (mix)       | raised                      | wrong                   | all-in $/1k                 | wall mean s              | conn                     |
| ---------------- | --------------------------- | ----------------------- | --------------------------- | ------------------------ | ------------------------ |
| eden − tools     | **+0.059 (+0.051..+0.068)** | −0.030 (−0.071..+0.009) | **+0.319 (+0.290..+0.346)** | **+0.91 (+0.62..+1.20)** | **+5.15 (+4.63..+5.66)** |
| both+ask − tools | **+0.052 (+0.044..+0.061)** | −0.012 (−0.055..+0.026) | **+0.274 (+0.251..+0.295)** | **+0.79 (+0.51..+1.07)** | **+4.42 (+3.99..+4.87)** |
| both+ask − eden  | **−0.007 (−0.013..−0.001)** | +0.018 (−0.019..+0.055) | **−0.045 (−0.069..−0.022)** | −0.13 (−0.39..+0.13)     | **−0.73 (−1.12..−0.34)** |
| both − eden      | **−0.016 (−0.024..−0.009)** | +0.020 (−0.012..+0.055) | **−0.067 (−0.094..−0.042)** | −0.21 (−0.46..+0.04)     | **−1.77 (−2.18..−1.36)** |

## 5. Against RealUse-1 (heldout14)

**These are different suites.** heldout14 and heldout15 have different templates, decoys and items, so a row here is
not a before-and-after of the fixes. Both were run with the same harness shape, model, profile and n = 128 per kind.

RealUse-1's figures are from [benchmark-realuse-1-results.md](../benchmark-realuse-1-results.md) and
[A-heldout14.md](../realuse-1/A-heldout14.md). They were not re-run here.

| measure                              | RealUse-1, heldout14 (pre-fix tree) | RealUse-2, heldout15 (`e484dfc6`)   |
| ------------------------------------ | ----------------------------------- | ----------------------------------- |
| hidden raised, tools → eden          | 20.3% → 65.6%, +45.3 (+35.2..+55.5) | 16.4% → 75.8%, +59.4 (+50.8..+68.0) |
| control false concerns, tools → eden | 0/128 → 0/128                       | 1/128 → 2/128                       |
| neutral any concern, tools → eden    | 2/128 → 7/128 (+3.9, +0.0..+7.8)    | 8/128 → 3/128 (−3.9, −9.4..+0.8)    |
| mix all-in $/1k, tools → eden        | 0.349 → 0.848                       | 0.345 → 0.663                       |
| mix wall mean, eden − tools          | +0.60 s (+0.22..+0.99)              | +0.91 s (+0.62..+1.20)              |
| mix connector calls, tools → eden    | 3.22 → 9.74                         | 3.16 → 8.31                         |
| Eden on path share (mix), eden       | 38.7%                               | 39%                                 |
| both − eden, hidden                  | −8.6 (−16.4..−0.8)                  | −16.4 (−24.2..−9.4)                 |

Reading:

- **Hidden recall.** The gap over tools is larger here.
- **Neutral concerns.** RealUse-1's direction (Eden raising more concerns on neutral tasks) did not recur: 3/128
  against tools' 8/128.
- **Cost.** Eden's all-in mix cost is about a fifth lower ($0.663 against $0.848). Per-task Eden spend is $0.22–0.24/1k
  against $0.29–0.39/1k, and background is $0.075/1k against $0.113/1k.
- **Latency.** The mean latency penalty is larger, and Eden's share of the critical path is unchanged at about 39%.

Which part of each difference comes from the fixes and which from the suite cannot be separated with these two runs.

## 6. Funnel (no model, $0, stub reader)

`funnel-h15.txt` has the full output. Seeds 41–44, the shipped default, cards and intent replayed (D158), `--ask`.
With the stub reader nothing binds, so the delivered counts are rule paths only and are **not** the preset's numbers.

- **Surfaced (delivered or cited by ask):** hidden 104/128, decoys 80/128.
- **Delivered unasked (rule paths):** hidden 22/128 and decoys 11/128.
  - Hidden by path: grounded-card 10, grounded-conflict 8, grounded-clash 4.
  - Decoys by path: grounded-card 6, grounded-conflict 4, fallback 1.
- **Reader pool:** hidden in pool 93/128, decoys 77/128, 11.5 items, 208 reader calls.
- **Neutral:** any packet 24/128 (0.19 items per task), reader flagged 0/128, 2.76 calls per task.

## 7. Spend

| label      | $          | what                                                |
| ---------- | ---------- | --------------------------------------------------- |
| `r2-smoke` | 0.0378     | 1 seed, `--limit 2`, 24 runs                        |
| `r2-pi-41` | 0.2469     | 384 runs (agent 0.1398, Eden 0.0796, grader 0.0276) |
| `r2-pi-42` | 0.2478     | 384 runs (agent 0.1384, Eden 0.0817, grader 0.0277) |
| `r2-pi-43` | 0.2438     | 384 runs (agent 0.1370, Eden 0.0792, grader 0.0277) |
| `r2-pi-44` | 0.2448     | 384 runs (agent 0.1355, Eden 0.0819, grader 0.0275) |
| **total**  | **1.0211** | of the $3 cap; the funnel was $0                    |
