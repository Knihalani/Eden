# The Pi harness as the standard live agent, with a timeline of every task (track pi)

Status: 2026-10-31, one session. Lab code only; no engine behaviour changes. Every number below comes from a command
run in this session; all suites used were tuned on for H (D55), so every live result here is **in-sample** for the
configuration. Nothing ran on held-out 5–8.

## What was built

- **`packages/sim/src/lab/pi-ab.ts`**: the live A/B on the hidden-context suites with the Pi harness as the agent:
  `Agent` from `@earendil-works/pi-agent-core` streaming through `@earendil-works/pi-ai`'s OpenAI-compatible chat
  completions on OpenRouter (`z-ai/glm-5.3-flash`, no reasoning parameter, temperature 0, 2,000 output tokens, at most
  six model calls: the same as `agent-ab.ts`). Conditions `none`, `tools` (a read-only `search_<id>` per sim source),
  `eden` (Eden's packet as a system message before the user turn, `ask_context` backed by the real `ContextPartner`
  with `--config`), `both`, `eden-judge`, `both-judge`, and any of them with `@w<ms>` (how long the first observe waits
  for Eden's slow path; default 3,000 as in agent-ab and the client's `withContext`). Packets Eden queues later are
  placed before the next model request (`transformContext`), never stored in the agent's transcript.
- **`ab-common.ts`**: the tasks, prompts, tool names and rendering, the `ask_context` description, the grader's prompt
  and verdict parsing and the OpenRouter call, moved out of `agent-ab.ts` unchanged so both harnesses share them by
  construction. `agent-ab-report.ts` reads pi-ab's results file as it is (checked).
- **Per-second instrumentation** (`timeline.ts`): every task records spans and instants on `performance.now()`: task
  start; Eden's blocking observe; Eden's slow path, search, each probe query (`probe:<kind>`, with its source calls),
  the probes' grace wait, refresh, judge and ask (the engine's new span sink, below); each of Eden's source calls
  (source, status, items); Eden's decisions and cache hits (its traces); each model request's start, first streamed
  token and end with tokens and OpenRouter's own cost; each tool call; grading; task end. One JSON line per task in
  `<timeline>/tasks.jsonl`; process CPU (user and system time), RSS, heap, tasks and requests in flight every second in
  `samples.jsonl`.
- **`pi-ab-report.ts`**: per condition and task kind the hidden-fact rate or false-concern rate, $/1k tasks with
  Eden's model cost broken out, model and tool calls, tokens in and out, wall p50/p90/p99 and time to first token; the
  critical path (each instant of a task's wall time given to Eden's blocking work, a model request, a tool call or the
  loop itself; Eden's background work and grading reported beside it); paired bootstrap differences (rate, wall time,
  cost) for the standard pairs and each `@w` variant against its base; the per-second profile; Eden's internals per
  task; the process samples.
- **Engine: `PartnerDeps.onSpan`** (`Span`, `SpanSink` in `trace.ts`): an optional sink for the engine's timed phases.
  Names, `performance.now()` start and end and call counts only, never content; absent in the product; a throwing sink
  is swallowed like `onTrace`. No state. `spans.test.ts`: spans carry no request or item text, each carries its own
  session id, listening (or a broken sink) changes nothing the engine returns. `bun run eval` with it: identical to
  the base commit except `latencyP50Ms`/`latencyP95Ms`.
- **Spend cap**: `--budget` is hard over everything a run spends (agent, Eden's judge, grader). Each call reserves its
  worst case (input ≈ chars/4 and its full output allowance at `priceFor`'s list price, $1/$4 per M for an unlisted
  model) before it is sent and settles at OpenRouter's reported cost. Conservative: with 50 streams in flight the
  reservations alone reached the cap, so the main run stopped at $0.252 of $0.30 with 592 of 670 runs done and 13
  graded calls refused (reported as ungraded, never as misses).

### Dependencies

`@earendil-works/pi-agent-core@1.3.0` and `@earendil-works/pi-ai@1.3.0`, exact, as **devDependencies of
`packages/sim` only**. The task named `@mariozechner/pi-*`; npm marks those deprecated ("please use
@earendil-works/pi-agent-core instead"), and CLAUDE.md names earendil-works/pi. 1.3.0 is the newest release older than
two weeks (2026-10-15). Justification: CLAUDE.md makes Pi the standard live agent; re-implementing its loop would not be
Pi. Cost: 83 packages in the lockfile (pi-ai bundles provider SDKs: OpenAI, Anthropic, Google, Mistral, Bedrock);
only the OpenAI-compatible API module is loaded (`api/openai-completions.lazy`). `@earendil-works/pi-telemetry` is
in-process contracts only (no network). Two postinstall scripts stay blocked by bun. Nothing in `engine`, `server` or
any non-lab file imports them (`grep -r earendil packages/*/src` hits only `lab/pi-ab.ts`).

## A finding before any number: the grader

`anthropic/claude-haiku-5.5` (agent-ab's grader, and every earlier live result's) now returns **403 "prohibited due to
a violation of provider Terms Of Service"** for this account, as do `openai/gpt-5.6-luna` and
`google/gemini-3.5-flash-lite`; `qwen/qwen3.6-flash` is refused for the account's zero-data-retention setting. Only
some providers pass the account's guardrails. Every graded number here uses **`deepseek/deepseek-v4.1-flash`** as the
grader (same prompt and parsing). It agrees with the lexical cross-check on 513 of 579 facts (0.886) in the main run,
against 0.979 for Haiku in agent-hidden.md: a looser or noisier grader. **These numbers are not comparable with the
Haiku-graded ones in earlier notes**, only with each other.

## Smoke (the track's required run): held-out 1, seed 41, both variants, H

`pi-ab.ts --suite heldout --seeds 41 --variants hidden,control --conditions none,tools,eden,both --config H`. 12 hidden
and 12 control tasks per condition (n is tiny: one hit is 0.083).

| Run | Condition | Hidden fact raised | False concern | $/1k | p50 s | p90 s |
|---|---|---|---|---|---|---|
| A, sources instant (`--time-scale 0`, as agent-ab) | none | 0.000 | 0.083 | 0.062 | 3.50 | 5.78 |
| | tools | 0.417 | 0.083 | 0.255 | 4.63 | 13.75 |
| | eden | 0.273 (n=11, one ECONNRESET) | 0.083 | 0.239 | 6.43 | 12.58 |
| | both | 0.417 | 0.083 | 0.206 | 5.50 | 15.06 |
| B, sources at profile latency (`--time-scale 1`) | none | 0.000 | 0.083 | 0.051 | 2.83 | 4.74 |
| | tools | 0.417 | 0.083 | 0.237 | 6.03 | 16.80 |
| | eden | 0.250 | 0.083 | 0.183 | 6.42 | 12.83 |
| | both | 0.583 | 0.000 | 0.203 | 7.06 | 15.68 |
| | eden-judge | 0.500 | 0.083 | 0.273 | 9.34 | 16.99 |
| | both-judge | 0.333 | 0.083 | 0.269 | 9.82 | 16.94 |

(Hidden-task rows; false concern from the control rows; $/1k and wall from the hidden rows.) Spend: A $0.0352
(agent $0.0196, grader $0.0157), B $0.0544 (agent $0.0298, Eden $0.0013, grader $0.0233). With sources instant, Eden
is 0–34 ms of a task's critical path; at the profiles' latency it is 21% for eden and 34% for eden-judge (below).

## Main run: five suites, seed 41, H, sources at profile latency

`pi-ab.ts --suite hidden,heldout,heldout2,heldout3,heldout4 --seeds 41 --variants hidden,control --conditions
tools,eden,both,eden-judge,both-judge --config H --time-scale 1 --budget 0.30`: 592 runs, 0 errors, 13 ungraded (cap
refusals), $0.2522 (agent $0.1630, Eden $0.0052, grader $0.0841), 169 s.

| Condition | Hidden raised | False concern | $/1k (Eden's) | calls | tools | in tok | out tok | p50 s | p90 s | p99 s | TTFT p50 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| tools | 0.431 (58) | 0.017 (61) | 0.305 | 3.28 | 5.71 | 3,687 | 919 | 8.35 | 14.23 | 19.93 | 347 ms |
| eden | **0.566** (54) | 0.033 (64) | **0.232** | 2.06 | 1.50 | 1,895 | 830 | 8.00 | 14.91 | 22.07 | 300 ms |
| both | 0.492 (66) | 0.000 (59) | 0.240 | 2.56 | 3.86 | 2,582 | 745 | 7.31 | 12.78 | 18.28 | 381 ms |
| eden-judge | 0.551 (50) | 0.053 (58) | 0.263 (0.024) | 1.98 | 1.42 | 1,800 | 795 | 9.07 | 14.22 | 17.04 | 292 ms |
| both-judge | 0.468 (64) | 0.053 (58) | 0.290 (0.020) | 2.70 | 4.41 | 2,837 | 760 | 8.19 | 13.23 | 17.92 | 348 ms |

Columns other than false concern are the hidden tasks'. Paired differences (same task, bootstrap 95% over tasks):

| a − b | kind | n | rate | wall s | $/1k |
|---|---|---|---|---|---|
| eden − tools | hidden | 51 | **+0.176 (+0.039..+0.314)** | +0.58 (−0.68..+1.90) | −0.043 (−0.088..+0.005) |
| eden − tools | control | 54 | +0.019 (−0.037..+0.074) | +0.56 | −0.052 |
| both − tools | hidden | 56 | +0.125 (+0.000..+0.268) | −0.42 | −0.069 (−0.110..−0.030) |
| both − tools | control | 54 | −0.019 (−0.056..+0.000) | +0.37 | +0.020 |
| eden-judge − eden | hidden | 42 | −0.048 (−0.190..+0.071) | +0.26 | +0.012 |
| both-judge − both | hidden | 60 | −0.050 (−0.167..+0.050) | +0.89 (+0.27..+1.52) | +0.053 |

In this harness, with this grader and in-sample, Eden alone raises the hidden fact more often than the same agent
with search tools (0.566 against 0.431, 1.31×) at 24% lower cost, with false concerns 0.033 against 0.017 (within
2 points). The judge adds nothing measurable and costs time. Per suite (hidden raised, tools → eden): hidden 0.50 →
0.70, held-out 1 0.57 → 0.50, held-out 2 0.60 → 0.88, held-out 3 0.27 → 0.33, held-out 4 0.27 → 0.58; n is 7–15 a
cell.

### Where the time goes (critical path, mean ms per task, share of wall)

| Condition | Eden (blocking) | model | tool | loop | Eden beside the loop | grading (after) |
|---|---|---|---|---|---|---|
| tools | 0 (0%) | 7,402 (86%) | 1,248 (14%) | 6 | 0 | 1,028 |
| eden | 1,850 (21%) | 7,164 (79%) | 0 | 1 | 2,134 | 1,039 |
| both | 763 (9%) | 6,738 (79%) | 996 (12%) | 1 | 948 | 992 |
| eden-judge | 3,117 (32%) | 6,686 (68%) | 0 | 1 | 3,500 | 934 |
| both-judge | 1,918 (21%) | 6,287 (68%) | 973 (11%) | 1 | 2,226 | 1,167 |

`ask_context` counts as Eden's time, not a tool's. Per second of task time (eden): second 0 is 682 ms Eden (the first
observe's slow path: p50 672 ms, p90 1,193 ms at profile latency), then 175–271 ms of each later second is
`ask_context` (p50 820 ms per ask). eden-judge: Eden holds 959, 732 and 464 ms of seconds 0–2 (judge p50 1,535 ms,
slow path p50 2,102 ms, p90 4,012 ms, so the 3 s wait often expires). Eden makes 23.6 source calls per task in the
eden condition (4.7 probe queries, 9.1 probe calls; the asks run the probes again) against 9.2 in both. The model
dominates every condition: 68–86% of wall time. Process: CPU p50 18% of a core, 65 ms of CPU per run, RSS up to
2.6 GB (fifty worlds in one process). Timing is noisy: four CPUs shared with other agents.

## Experiment: do not wait for Eden before the first request (`@w0`)

The timeline says Eden's first observe is the one controllable block on the critical path. `@w0` sends the first
model request at once; a packet Eden finishes later is placed before the agent's next request, if it makes one.
`--conditions eden@w0,both@w0`, same tasks: 240 runs, $0.1078 (agent $0.0700, grader $0.0378), 16 ungraded (cap).

| a − b | kind | n | rate | wall s | $/1k |
|---|---|---|---|---|---|
| eden@w0 − eden | hidden | 51 | +0.020 (−0.098..+0.137) | **−1.06 (−1.96..−0.22)** | +0.034 (−0.008..+0.084) |
| eden@w0 − eden | control | 48 | +0.042 (−0.042..+0.125) | **−1.12 (−1.84..−0.45)** | +0.026 |
| both@w0 − both | hidden | 55 | −0.055 (−0.200..+0.091) | +0.41 (−0.40..+1.19) | **+0.091 (+0.049..+0.138)** |
| both@w0 − both | control | 47 | +0.021 (+0.000..+0.064) | −0.78 (−1.96..+0.27) | −0.026 |

eden@w0: 0.571 hidden, 0.077 false concern, p50 6.93 s (eden 8.00 s); Eden's critical-path share falls from 21% to
15% (what is left is `ask_context`). The agent asks anyway, so the packet that would have come first arrives with the
first tool result or not at all, and costs a little more model input. both@w0: Eden leaves the critical path entirely
(2 ms) but the agent, without the packet up front, searches more (5.90 tools a task against 3.86) and costs more;
the hit rate moves −0.055 (interval includes 0). Read: for an agent that has `ask_context`, not waiting saves about a
second a task at no measurable loss; beside search tools, the up-front packet is what saves the agent's own searches.
A decision on `withContext`'s default wait needs a larger, out-of-sample run.

## Live spend, this track

| Run | Runs | Spend |
|---|---|---|
| plumbing (2 + 4 tasks) | 12 | $0.002599 |
| grader probes (one call each to glm-5.3-flash and deepseek-v4.1-flash; the 403s cost nothing) | 2 | $0.000032 |
| smoke A | 96 | $0.035231 |
| smoke B | 144 | $0.054373 |
| main | 592 | $0.252218 |
| `@w0` | 240 | $0.107789 |
| **total** | | **$0.45224** (cap $0.60) |

## The free numbers (same session)

The track adds no engine flag, so "H plus this track" is H. Funnel, no model, seed default, suites hidden, held-out 1–4
(returned / delivered / decoys of 268, calls per task): H 148/128/21 at 8.5; baseline `{}` 66/20/28 at 3.0.
`bun run eval`: identical to the base commit except the two latency fields.

## The full benchmark (documented command)

```bash
# The Pi A/B over the dev and held-out 1-4 suites, four seeds, all six conditions, sources at profile latency.
# ~3,200 runs; at this session's ~$0.00043 a run (grader included) about $1.40: set --budget above that, since the
# cap reserves each call's worst case before sending it.
OPENROUTER_API_KEY=… bun packages/sim/src/lab/pi-ab.ts --suite hidden,heldout,heldout2,heldout3,heldout4 \
  --seeds 41,42,43,44 --variants hidden,control --conditions none,tools,eden,both,eden-judge,both-judge \
  --config H --time-scale 1 --grader deepseek/deepseek-v4.1-flash --budget 2 --out bench/runs/pi-ab-H.json
bun packages/sim/src/lab/pi-ab-report.ts bench/runs/pi-ab-H.json
bun packages/sim/src/lab/agent-ab-report.ts bench/runs/pi-ab-H.json --record pi-H
```

Use `--grader anthropic/claude-haiku-5.5` again once the account's guardrails allow it, to compare with earlier notes.

## Risks and limits

- In-sample: H was chosen on these suites. One seed. The blind suites were not run.
- The grader changed (Haiku is refused for this account); deepseek agrees with the lexical check less (0.886).
- The cap is conservative under concurrency and can stop a run early (13 and 16 ungraded here; the unpaired tasks
  drop out of paired differences, not into misses).
- A connection reset mid-stream is not retried by pi-ai (only request creation is): one task in smoke A ended as an
  error (reported, excluded like agent-ab's errors).
- Pi streams and runs tools in parallel (`--tool-exec sequential` restores agent-ab's order); agent-ab does neither,
  so the two harnesses' wall times differ for reasons beyond Eden.
- Memory: one process holding 50 worlds reached 2.6 GB RSS.
- `bun run check`: format and typecheck green; tests 748 pass, 1 fail. The failing test (partner.test.ts, "each
  user's days are at their own offset") fails the same way with the base commit's engine files swapped back in, so it
  is not this change; it looks tied to today's date and is left for its owner.
