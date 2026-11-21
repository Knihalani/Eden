# lh10: Hermes + Eden vs Hermes alone, ten-day horizons on a real model

Status: 2026-11-21. Live A/B (`hermes-ab.ts --days`, D1044) on OpenRouter. Every number comes from a command run
this session; the artifacts are under `.local/bench/` (lh10.json, lh10.tl, ledger.jsonl) on the run machine.

## Why

B19's days arms carried 16 hidden tasks over 8 user-days and said so themselves: "the days rows give a direction,
and the short runs give the sizes." lh10 is the powered version of that question — does Eden still help when the
task is ten days of a user's life, not one request — run end-to-end with a real model on every role.

## Method

- **Agent**: Hermes Agent at 06433066 (the B19 pin), `mcp` extra. `hermes` (raw: its own `search_<source>` tools)
  vs `hermes+eden` (B19's shape: own tools plus Eden's packets and `ask_context`).
- **Models**: `deepseek/deepseek-v4.1-flash` for every role — agent, grader, cards, reader, check — through
  OpenRouter (`EDEN_ALLOW_OPENROUTER=1`). A cheaper, weaker model than B19's Haiku/Sonnet pair; the paired
  difference is the measurement, the absolute rates are the model's.
- **Horizon**: `--days 10 --day-size 12-16 --mix 1:1:6`. Four users (seeds 41–44) × 10 days; each day 12–16
  requests drawn without replacement. Hermes' transcript resets each day; Eden persists across the whole user,
  with the day's planted items swapped in before each recap. Clock +10 min a request, +2 h a night.
- **Suites**: `heldout18,heldout19` (heldout20 keeps its own world clock and cannot share a user).
- **Size**: 561 tasks × 2 arms = 1,122 graded units — 80 hidden, 80 control, ~400 neutral per arm — 5× B19's
  days power. 78 of 80 day-units finished (2 truncated by a harness stop; every request still journaled, 1 task
  ungraded).
- **Spend**: $4.40 total (agent $3.08, Eden $0.57, grader $0.74), 6,376 requests, 0 retries.

## Results

Hidden fact raised (planted item must reach the answer to count):

| condition | n | raised | tools/task | in tok | p50 s | $/1k (Eden) |
|---|---|---|---|---|---|---|
| hermes | 80 | **0.163** | 18.10 | 102,546 | 17.70 | 2.52 (—) |
| hermes+eden | 80 | **0.313** | 10.09 | 90,202 | 13.59 | 2.65 (0.53) |

Paired bootstrap (95%): **+15.0 points (+3.7..+26.3)** on hidden; wall +4.2 s (−3.7..+15.5, level); cost +$0.14
(−0.34..+0.61) per 1k.

| kind | raw | +eden | paired Δ |
|---|---|---|---|
| control false concern (80) | 0.000 | 0.000 | +0.000 (0..0) |
| neutral any concern (401) | 0.028 | 0.035 | +0.007 (−0.018..+0.030) |

Uptake on the Eden arm — raised rate by how the planted item reached the agent: packet 0.259 (27 items),
ask answer 0.441 (34), neither 0.158 (19). Items Eden put in a packet or its ask surfaced for are markedly more
likely to be raised; the residual neither-rate matches the raw arm's whole-sample rate.

Mechanics: −44% tool calls and −12% input tokens on hidden tasks; the party check denied 499 of 586 asks
(redundant source re-reads). Eden adds ~3.7 ms of its own path per task-second share (20% of its wall), mostly
the observe push at 1.4 s; `ask_context` p50 19 ms. Wall time stays level because the agent's model and tool
time shrink by more.

## What it says

- The direction B19's underpowered days rows hinted at is real at power: ~2× the hidden facts raised over ten
  days of requests, no false-concern cost on decoys, and fewer tool calls and prompt tokens despite the extra
  context path.
- Absolute rates are DeepSeek's, not Haiku's — a weaker agent leans on Eden harder (+15 pts here, +33.1 for
  Haiku on B19's shorter tasks; the ordering is the point, not the number).
- Neutral spam stays at noise level (+0.7 pts, CI spans 0) across 401 unplanted requests a arm.

## Limits

DeepSeek-flash for every role (cost constraint); 2 of 80 day-units truncated (journal kept, resumed cleanly);
heldout18+19 only — heldout20's own clock keeps it a single-suite run; no paid Anthropic arm to pin absolute
rates against B19.
