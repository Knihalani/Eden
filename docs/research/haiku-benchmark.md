# The Haiku 5.5 benchmark: Eden NEW against ALL3, tools alone and no Eden, in Pi and Hermes

Status: 2026-11-02. Phase 2 of the Haiku campaign (lab only, simulated fictional data, D97). Claude Haiku 5.5 is the
agent, the grader and Eden's models (reader, cards, intent requests), with prompt caching on. Every number below comes
from a command run in this session. The spend is the campaign's spend ledger, summarised per run and role in
`packages/sim/lab/haiku/ledger-summary.jsonl`.

## Summary

- **Biggest result.** NEW raises the hidden fact a bit more than 20 points above ALL3, the previous best configuration,
  in both agent harnesses, on every blind suite, with false concerns flat. NEW is Eden with:
  - the ask-time reader, which reads the request against what Eden found;
  - the reader's flags pushed to the agent as a packet (`readerPush`);
  - Haiku-written intent requests.

  The test is whether the agent's answer raises the fact the user would want raised: blind held-out 5–8, 10, 11 and
  12, eight seeds, 1,400 hidden and 1,400 control tasks per condition.

  | Harness | Agent alone (tools) | + Eden ALL3 | + Eden NEW | NEW − ALL3 (95% CI) |
  |---|---|---|---|---|
  | Pi | 16.9% | 47.9% | **70.7%** | **+22.8 points** (+20.4..+25.4) |
  | Hermes | 14.9% | 40.4% | **64.3%** | **+23.9 points** (+21.4..+26.5) |

  The Pi rows are the eden-only arm against the tools-only arm; Pi's tools-plus-NEW arm raised 63.0% (+46.1 over
  tools, +15.1 over eden-only ALL3).
- **False concerns** (the agent raising a lookalike decoy that does not apply):
  - Pi: tools 0.6%, ALL3 3.3%, NEW 4.3%, tools + NEW 1.9%;
  - Hermes: alone 0.6%, ALL3 2.4%, NEW 2.9%;
  - NEW − ALL3: +1.0 points (−0.3..+2.3) in Pi, +0.5 (−0.5..+1.6) in Hermes. Not distinguishable from zero.
- **Held-out 12** had never been run with a strong model. NEW reached 57.8% (Pi) and 55.5% (Hermes) against ALL3's
  25.8% and 21.5%, with no false concern in any condition.
- **Cost.** NEW costs about twice ALL3 per task: an agent task plus Eden's reader is $0.79 per thousand hidden tasks in
  Pi (ALL3 $0.36). Hermes is $0.73 per thousand (ALL3 $0.42). Either way it is under a tenth of a cent a task. Most of
  the extra is one Haiku reader call (about $0.0004) per acting request. The grader and card making are counted
  separately below.
- **Latency.** Eden on the agent's critical path goes from 36 ms (ALL3) to about 1.9 s in Pi (1.3 s in Hermes).
  - The first observe waits up to 3 s for the reader.
  - Pi hidden tasks' wall p50 is 4.0 s against 3.2 s; p90 is 7.5 s against 4.7 s.
  - Cutting the wait to 1 s does not pay: it loses 7.6 points in Pi's eden arm and 18.1 in the both arm, and wall time
    barely drops (0.0–0.15 s at p50).
- **What did not work, or is weaker.**
  - In both harnesses, an agent with source tools rarely calls `ask_context`. NEW's gain for such agents comes from
    `readerPush` (Phase 1).
  - Gains are smaller on held-out 10 (+12.1 points Pi, +14.1 Hermes) and held-out 11 (+16.4, +19.5) than on held-out
    5–8 (+25.9, +25.6) and 12 (+32.0, +34.0).
  - In Pi, giving the agent its tools beside NEW lowered the hidden rate against NEW alone, 63.0% vs 70.7%. The agent
    leans on its own searches.
- **Spend.** $24.36 of the $40 cap for the whole campaign:
  - Phase 1 $1.42;
  - benchmark preparation $0.75;
  - the main matrix $18.46;
  - the wait test $3.73.

## What was run

- **Agent and grader:** Haiku 5.5 (`claude-haiku-5-5`), thinking off, prompt caching on (5-minute breakpoints on
  tools, system and the last turn).
- **Eden's models:** Haiku 5.5 for the reader (`askReader`, prompt v5), for cards made live for items the replay file
  lacked, and for the intent requests made beforehand. All are metered on one spend ledger with a hard cap
  (`--spend-cap 40 --spend-headroom 3`).
- **Pi** (`pi-ab.ts`, pi-ai's native Anthropic provider), conditions:
  - `none`: no data;
  - `tools`: one search tool per source;
  - `eden`: ALL3, Eden's packets and `ask_context` without tools;
  - `eden~NEW`: the same with NEW;
  - `both~NEW`: tools plus Eden NEW.
- **Hermes** (`hermes-ab.ts`, Hermes Agent at `06433066`, its OpenAI-format requests translated to the Messages API by
  `hermes-anthropic.ts`), conditions:
  - `hermes`: tools;
  - `hermes+eden`: ALL3;
  - `hermes+eden~NEW`.
- **NEW** = ALL3 + `intent` + `askReader` + `askReaderDrop` + `readerPush` (`PRESETS.NEW`, D96).
- **Suites:**
  - blind held-out 5–8, 10, 11 and 12, seeds 41–48, both harnesses (175 hidden and 175 control tasks per seed and
    condition);
  - train (in-sample reference), seeds 41–42;
  - held-out 12 had never been read by a strong model before this run.
- **Rates:** the grader's verdict on each planted fact (`gradeWith`). "Hidden fact raised" on hidden tasks; "false
  concern" on control tasks, where a decoy that does not apply was planted instead.
- **Grader check:** across all graded runs, the grader and the lexical cross-check (70% of a fact's distinctive tokens
  in the answer) agree on 26,026 of 28,544 facts (91.2%).
- **Paired differences:** the same task (world, seed, template) under two conditions, with a 2,000-sample bootstrap
  over tasks for the 95% interval (`haiku-bench.py`).
- **Machine and load:** a 4-core, 15 GB container. Three processes at a time, each running its conditions'
  streams concurrently. Wall and latency figures include that load.

## Blind, all suites (seeds 41–48; 1,400 hidden + 1,400 control tasks per condition)

### Pi

| Condition | Hidden raised | False concern | Wall p50 / p90 s (hidden) | TTFT p50 ms | Eden on critical path ms | $ per 1k tasks (agent + Eden) |
|---|---|---|---|---|---|---|
| none | 0.4% | 0.4% | 2.25 / 3.89 | 487 | 0 | 0.179 |
| tools | 16.9% | 0.6% | 3.51 / 5.33 | 517 | 0 | 0.381 |
| eden (ALL3) | 47.9% | 3.3% | 3.19 / 4.69 | 528 | 36 | 0.361 |
| eden~NEW | **70.7%** | 4.3% | 4.02 / 7.47 | 526 | 1,926 | 0.786 (Eden 0.507) |
| both~NEW | 63.0% | 1.9% | 4.46 / 6.27 | 515 | 1,136 | 0.651 (Eden 0.296) |

- The cost column is the hidden tasks'; control tasks cost a little more under NEW (eden~NEW $0.962 per 1k).
- The critical-path column is the mean over hidden and control tasks.

| Paired difference (hidden) | Points (95% CI) | Same on control |
|---|---|---|
| eden~NEW − eden (ALL3) | +22.8 (+20.4..+25.4) | +1.0 (−0.3..+2.3) |
| eden~NEW − tools | +53.8 (+50.9..+56.6) | +3.7 (+2.6..+4.9) |
| eden~NEW − none | +70.4 (+68.0..+72.7) | +3.9 (+2.9..+5.1) |
| both~NEW − tools | +46.1 (+43.4..+48.7) | +1.4 (+0.6..+2.1) |
| both~NEW − eden (ALL3) | +15.1 (+12.4..+17.8) | −1.4 (−2.3..−0.3) |
| eden (ALL3) − tools | +31.0 (+28.0..+34.0) | +2.7 (+1.7..+3.8) |
| tools − none | +16.6 (+14.6..+18.6) | +0.2 (−0.3..+0.7) |

### Hermes

| Condition | Hidden raised | False concern | Wall p50 / p90 s (hidden) | TTFT p50 ms | Eden on critical path ms | $ per 1k tasks (agent + Eden) |
|---|---|---|---|---|---|---|
| hermes | 14.9% | 0.6% | 3.22 / 5.01 | 514 | 0 | 0.424 |
| hermes+eden (ALL3) | 40.4% | 2.4% | 3.19 / 5.07 | 508 | 21 | 0.421 |
| hermes+eden~NEW | **64.3%** | 2.9% | 3.83 / 7.00 | 501 | 1,331 | 0.733 (Eden 0.337) |

| Paired difference (hidden) | Points (95% CI) | Same on control |
|---|---|---|
| NEW − ALL3 | +23.9 (+21.4..+26.5) | +0.5 (−0.5..+1.6) |
| NEW − Hermes alone | +49.4 (+46.9..+52.1) | +2.3 (+1.4..+3.1) |
| ALL3 − Hermes alone | +25.5 (+22.9..+28.0) | +1.8 (+1.0..+2.6) |

## Per suite (hidden raised; NEW − ALL3 with its 95% CI)

| Suite (n per condition) | Pi tools | Pi ALL3 | Pi NEW | Pi Δ | Hermes alone | Hermes ALL3 | Hermes NEW | Hermes Δ |
|---|---|---|---|---|---|---|---|---|
| held-out 5–8 (632) | 16.3% | 52.2% | 78.2% | +25.9 (+21.7..+29.9) | 13.3% | 46.5% | 72.2% | +25.6 (+21.7..+29.7) |
| held-out 10 (256) | 18.8% | 53.1% | 65.2% | +12.1 (+7.8..+17.2) | 17.6% | 43.8% | 57.8% | +14.1 (+8.6..+19.5) |
| held-out 11 (256) | 20.7% | 54.3% | 70.7% | +16.4 (+11.7..+21.5) | 16.8% | 40.6% | 60.2% | +19.5 (+13.7..+25.8) |
| held-out 12 (256) | 12.9% | 25.8% | 57.8% | +32.0 (+25.8..+38.7) | 14.1% | 21.5% | 55.5% | +34.0 (+27.7..+40.2) |
| train, in-sample (384) | 13.3% | 40.1% | 70.6% | +30.5 (+25.3..+35.7) | 8.6% | 34.4% | 65.1% | +30.7 (+25.3..+35.9) |

False concerns per suite stay within a few points: the largest is Pi held-out 11 (ALL3 7.0%, NEW 6.6%). Held-out 12
has none in any condition. The full per-suite tables, with per-request tokens, cache shares, ask calls, packet sizes
and source calls, are in `packages/sim/lab/haiku/agg.txt`.

## Where the time goes

Per-second profile (Pi, eden~NEW, 2,800 tasks): the mean milliseconds of each second of task time, by phase, over
the tasks still running.

| Second | Running | Eden | Model |
|---|---|---|---|
| 0 | 100% | 738 | 262 |
| 1 | 100% | 376 | 619 |
| 2 | 98% | 226 | 719 |
| 3 | 85% | 348 | 511 |
| 4 | 61% | 304 | 568 |
| 5 | 46% | 154 | 698 |
| 6 | 32% | 84 | 681 |

Eden is ahead of the first model request (the observe waits for the reader's push), then shares later seconds with
the agent's calls as the ask path runs. Under ALL3, Eden's share is 1% of wall time; under NEW it is 38% (Pi, eden
arm), 25% (Pi, both arm) and 29% (Hermes). The full profiles are in `report-pi.txt` and `report-h.txt`.

- **Eden's work per task (Pi):**
  - source calls: 3.48 (ALL3), 3.61 (NEW);
  - packet items injected: 0.59 (ALL3), 0.91 (NEW);
  - slow path: p50 12–13 ms;
  - ask p50: 14 ms (ALL3), 1.30 s (NEW: the reader's call);
  - `ask_context` calls per hidden task: 1.04 (ALL3), 0.73 (NEW), none in the both arm.
- **Process (Pi, pooled):**
  - CPU: p50 15% and p90 29% of a core;
  - 81 ms of CPU per run;
  - RSS max 3.35 GB;
  - up to 40 tasks in flight.

  hermes-ab does not sample its process; its workers were about 220 MB each.
- **Uptake:** once the planted item reached the agent, it was raised:
  - in a packet: 90–92% (Pi), 88–89% (Hermes);
  - only in an ask answer: 90–92% (Pi).

  The hidden facts still missed under NEW are mostly ones that never reached the agent: in 473 of 1,400 Pi hidden
  tasks the planted item was in neither a packet nor an ask answer (the agent raised it 29.6% of the time from its
  own search).

## The 1 s wait (Pi, blind seeds 41–43, 525 + 525 tasks, paired in the same processes)

| Condition | Hidden raised | False concern | Wall p50 / p90 s (hidden) |
|---|---|---|---|
| eden~NEW (3 s wait) | 70.3% | 3.0% | 3.88 / 7.04 |
| eden~NEW, 1 s wait | 62.7% | 4.0% | 3.86 / 6.98 |
| both~NEW (3 s) | 62.9% | 2.1% | 4.31 / 6.12 |
| both~NEW, 1 s | 44.8% | 0.8% | 4.16 / 5.55 |

The differences:
- 1 s − 3 s: −7.6 points (−11.0..−4.0) eden, −18.1 (−21.9..−14.3) both.
- Wall p50: within 0.15 s.

The reader's reading is what the agent uses, and the agent's own requests dominate wall time, so the 3 s wait is the
right default for NEW.

## Tokens, caching and cost by role (ledger, all Phase 2 runs)

| Harness | Role | Calls | $ | In / call | Out / call | Cache read | Cache write | TTFT p50 / p90 ms |
|---|---|---|---|---|---|---|---|---|
| Pi | agent | 30,128 | 5.734 | 1,067 | 280 | 67.3% | 30.8% | 515 / 859 |
| Pi | Eden reader | 8,082 | 3.196 | 3,574 | 239 | 25.3% | 0.0% | 525 / 853 |
| Pi | Eden cards (live, amortised) | 5,640 | 1.063 | 1,797 | 255 | 73.4% | 0.1% | 497 / 888 |
| Pi | grader | 17,920 | 1.175 | 616 | 8 | 0.0% | 0.0% | 515 / 1,010 |
| Hermes | agent | 19,257 | 4.520 | 4,308 | 254 | 86.9% | 13.0% | 506 / 779 |
| Hermes | Eden reader | 3,265 | 1.296 | 3,579 | 240 | 25.2% | 0.0% | 519 / 855 |
| Hermes | Eden cards (live, amortised) | 3,064 | 0.927 | 2,139 | 415 | 61.7% | 0.0% | 496 / 832 |
| Hermes | grader | 10,704 | 0.633 | 551 | 8 | 0.0% | 0.0% | 518 / 986 |

- **Caching:**
  - Hermes' long tool prefix is read from the cache for 87% of its prompt tokens; Pi's agent reads 67%.
  - The reader's prompt is mostly its pool, so only its fixed instructions cache (25%).
  - The grader's prompt is under Haiku's 512-token minimum and does not cache.
- **Cards:** made live for items the replay file did not hold. They are a background cost, shared by every condition
  with cards (ALL3 and NEW alike).

## Caveats

- **Simulated, single model:**
  - simulated worlds and a Haiku grader;
  - the grader agrees with the lexical cross-check on 91% of facts;
  - the same model plays agent, grader and Eden's models.
- **Train:** in-sample. Its NEW prompt and intent requests were tuned and made on train.
  - Held-out 10 and 11 were each read once in Phase 1's blind check (the funnel, not an agent run).
  - Held-out 5–8 and 12 were not read in this campaign before the benchmark.
- **Shared intent requests:** the Haiku intent requests for the benchmark worlds were made before the runs and shared
  by every NEW condition.
- **Load:** latency is measured under the container's shared load (three processes, many concurrent streams). Absolute
  times are this machine's, not a production deployment's; the differences between conditions are paired.
- **Seeds:** Pi and Hermes ran the same seeds (41–48). Hermes ran 4 concurrent streams for seed 41 and 6 for every
  later seed and train, which changes load, not tasks.
- **Grader prompts:** grading runs beside the agent; a grader failure would leave a run ungraded. None was (0 of
  28,544).

## Reproduce

```bash
H=.local/haiku   # ledger, cards and intent files as made in docs/research/haiku-opt.md
LEDGER="--spend-ledger $H/ledger.jsonl --spend-cap 40 --spend-headroom 3"
NEWV='{"NEW":{"intent":true,"askReader":true,"askReaderDrop":true,"readerPush":true}}'
COMMON="--seeds 41 --variants hidden,control --config ALL3 --variant-config $NEWV --cards $H/cards/cards-v2.jsonl \
  --intent $H/intent/intent-v2.jsonl --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --budget 8 $LEDGER"
bun packages/sim/src/lab/pi-ab.ts --suite heldout5,heldout6,heldout7,heldout8 $COMMON \
  --conditions none,tools,eden,eden~NEW,both~NEW --run-label p2-pi-b58-s41 --out p2-pi-b58-s41.json
bun packages/sim/src/lab/hermes-ab.ts --hermes-src $HERMES --concurrency 6 --suite heldout10,heldout11,heldout12 \
  $COMMON --conditions hermes,hermes+eden,hermes+eden~NEW --run-label p2-h-b1012-s41 --out p2-h-b1012-s41.json
python3 -I packages/sim/lab/scripts/haiku-bench.py $H/ledger.jsonl p2-*.json   # the tables above
bun packages/sim/src/lab/pi-ab-report.ts p2-pi-b*.json                        # critical path, profile, CPU
```

Intent requests and cards for seeds 41–48 are made with `cards-enrich.ts --intent` and `cards-enrich.ts` on Haiku
(docs/research/haiku-opt.md).
