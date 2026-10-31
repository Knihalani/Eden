# Cost model

Input tokens drive the cost, so the design rations them: most turns cost nothing, and a model call sees a bounded
input.

## Prices (verify before relying on them)

`z-ai/glm-5.3-flash` is served by 38 OpenRouter endpoints at different prices (OpenRouter endpoints API, queried
2026-10-27 in the fast-primitives research; [docs/research/fast-primitives.md](research/fast-primitives.md)):

| Endpoint               | Input $/M | Output $/M | Cache read $/M | Note                                               |
| ---------------------- | --------- | ---------- | -------------- | -------------------------------------------------- |
| Z.AI and most US hosts | 0.15      | 0.50       | 0.03           | Z.AI caches automatically                          |
| Relace                 | 0.0513    | 0.0701     | 0.03           | The founder's figure; no `response_format` support |
| Wafer                  | 0.054     | 0.20       | 0.053          | Almost no cache discount                           |
| OpenInference (fp4)    | 0.082     | 0.06       | 0.0064         | Quantized                                          |

Many endpoints are fp4/nvfp4 quantized; whether that hurts judge precision is unmeasured. With default load
balancing, prompt-cache hits are unlikely: caching pays only with sticky routing (a per-user `session_id`, a
byte-stable system prefix). `packages/llm/src/pricing.ts` budgets with the Z.AI list price, the conservative one.
OpenRouter returns the real cost per call (`usage.cost`), and the engine books that.

## Per call (upper bounds from the engine's caps)

| Call                                                                                           | Input bound                                                                                                   | Output bound                        | Cost at $0.15 / $0.50, uncached |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------- |
| Judge                                                                                          | system ≈ 100 tok + window ≤ 4,000 chars (≈ 1,000 tok) + ≤ 6 candidates × ≈ 100 tok ≈ 1,700 tok                | 512 tok, reasoning included (D45)   | ≈ $0.00051                      |
| Ask answer (only with `askWithModel`, off by default, D43)                                     | ≈ 100 + question ≤ 10,000 chars (≈ 2,500) + window ≤ 2,000 chars (≈ 500) + ≤ 20 items × ≈ 170 tok ≈ 6,500 tok | 1,000 tok, reasoning included (D45) | ≈ $0.0015                       |
| Card enrichment (only with `cards`, off by default, D56 proposed; background, never per event) | system ≈ 700 tok + ≤ 10 items × (title ≤ 160 + own text ≤ 900 chars) ≈ 3,400 tok                              | 2,000 tok, reasoning included       | ≈ $0.0015                       |

Card enrichment, measured (docs/research/moon-cards.md, 572 calls on simulated worlds, 2026-10-31): 1,599 input and
677 output tokens per call on average, $0.000181 per call as OpenRouter reported it. One call per ten new items that
pass the no-model prefilter (11-15% of simulated items), each item read once per content hash: about $0.002 per 1,000
items arriving, $0.003-0.004 per user-month at 50 new items a day (at most about $0.013 at list prices). Reserved per
call at $0.002 against its own per-user-day `Budget`.

With `graph` (proposed D56) the judge sees at most `graphSeats` (1) more candidate, about 100 more input tokens per
call at its cap; no other model call is added and the graph makes no source call. Measured in simulation (realistic,
4 seeds, perfect judge): $0.0172 → $0.0178 per 1,000 turns, model calls per turn 0.213 → 0.215.

These are arithmetic on list prices, not measurements. Output is billed on tokens used, not the cap: a judge verdict
is a few tokens plus low-effort reasoning (about 20 tokens on GLM 5.3 Flash in a probe of three calls).

## Measured so far (tiny samples, not statistics)

- `bun run eval --live`, seed scenario, 8 turns, 2026-10-27: 1 model call, $0.0000162 total
  (`costPerTurnUsd` 0.00000202825), p95 observe latency 767 ms with `waitMs` 2000.
- Live judge in simulation, realistic, seeds 41–43, 2026-10-30 (D45): 0.186 model calls per turn, $0.010 per 1,000
  turns (about $0.000056 per judge call, OpenRouter's reported cost), delivery p95 3.5 s on seed 41 with the judge
  against 11 ms without (docs/research/live-judge.md).
- Server smoke test, one `ask`: $0.000013639431, 1,549 ms end to end, including the OpenRouter round trip.

## Budget defaults (`packages/llm/src/budget.ts`)

20 calls and $0.02 per session; $0.25 per user per day; each call reserved before its real cost is known, at about its
worst case at the cap: $0.0005 for the judge, $0.0015 for a model-composed ask answer (D45). Over budget, the engine
takes the no-model path; it never defers spend.

## Levers, in order of leverage

1. Fewer model calls: better cheap scoring (M1 tuning), the graph (M3), learned silence. Done so far: ask answers
   without a model by default (D43), which halved model calls per turn in simulation (realistic, perfect judge,
   seeds 31–40: 0.378 to 0.198; cost per 1,000 turns $0.027 to $0.014) with recall, precision and ask retrieval
   unchanged. Grounding the no-model path in people and days (D44) adds no model call: with the perfect judge, model
   calls per turn are identical to main on every mix. A rule that skipped the judge for weak candidate sets was
   measured and rejected
   ([research/model-calls.md](research/model-calls.md)). `judgeTied` (D54, off by default) skips the judge only when
   no candidate is tied to the request (a probe's find, a day it names, two of its words, or one word rare in the
   user's items): simulation, perfect judge, realistic seeds 41–44, on G (D54): model calls per turn 0.253 → 0.212,
   $0.02025 → $0.0170 per 1,000 turns at recall 0.647 → 0.643 ([research/judge-tied.md](research/judge-tied.md),
   before review). With D55's final H: 0.213 model calls per turn, $0.0172 per 1,000 turns, recall 0.645.
2. Smaller inputs: shorter windows, candidate snippets, prompt-cache-friendly prompt layout (stable system prefix).
3. Cheaper model: a fine-tuned small judge (M6).

Probes (D46, off by default) add no model call but roughly double source calls per lookup in simulation (5.4–5.6 →
11.4–11.8; 8.7–9.1 with `probeWhen: "actions"`), within `probeCalls` (8) per lookup; with a judge, model calls per
turn rise by 0.01–0.03 (more lookups have candidates). For the agent, Eden with probes in place of search tools cost
less per task than the tools did ($0.327 against $0.354 per 1,000 held-out tasks; docs/research/probes.md).

D47 (docs/research/lean-probes.md), simulation, realistic, 4 seeds, perfect judge: compaction lowers model cost per turn
($0.0203 → $0.0180 per 1,000 turns with probes: the judge reads compacted candidates) and the agent's cost per task
(live held-out, $0.407 → $0.392 per 1,000 tasks). `judgeConfident`, off by default, adds a judge call on lookups whose
candidates all scored as sure: model calls per turn 0.21 → 0.28 and $0.0180 → $0.0245 per 1,000 turns with probes and
compaction (about +36%). Live, Eden with probes cost $0.407 per 1,000 held-out tasks against $0.370 for tools (the
agent's tokens fall, 3,045 → 1,714 input, but Eden's judge calls are added).

D48 (docs/research/sharper-grounds.md): shared calls and the topic probe only without people take probes from 11.8 to
7.9 source calls per lookup (simulation; baseline 5.6). `judgeContested` adds judge calls (0.21 → 0.25 per turn),
offset by 200-byte judge candidates: $0.0200 against probes' $0.0203 per 1,000 turns. Live, one run: Eden with D48's
settings $0.357, tools $0.329, Eden beside tools $0.329 per 1,000 held-out tasks; Eden's judge is about $0.034 of that
(live judge funnel). A cheaper judge model (mistral-nemo, $0.0097 per 1,000 tasks) let more decoys through.

D49–D53 (docs/research/combined-config.md): the conflict ground, the probe economy and dense packets add no model call.
With them (D53's configuration), simulation, realistic, 4 seeds, perfect judge: 7.79 source calls per lookup (F 7.86),
model calls per turn 0.253 (0.251), $0.02025 per 1,000 turns (F $0.0200), 433 bytes per needed fact (484). The probe
economy starts cold for each new user, so a user's first lookups make the wider calls `probeYield` sends before it has
learned which to skip (8.4 calls per task in the per-task funnel, which builds a new engine each task). The register's
background sweep (D51) added calls (10.4 per task) and was removed with it.

D56, proposed (background sync, "Eden Atlas", off by default; docs/research/moon-sync.md) adds no model call: the
sync makes listing calls only. With a judge it raises model cost, because the judge sees more candidates: simulation,
realistic, seeds 41–44, perfect judge, $0.0170 (H) → $0.0222–0.0223 (HA, two runs) per 1,000 turns (+31%), at the same input caps
(≤ 6 candidates of ≤ 200 bytes, ≤ 4k characters of window). Source calls fall: 7.78 → 0.86 request-time calls per
lookup, 1.72 with backfill and background amortised; in the per-task funnel, 8.5 → 3.04 per task (4.38 amortised).
A synced user costs about 4 MB of heap per ~1,500 items and ~200 ms of CPU to backfill (`sync-cost.ts`).

The non-model costs (source API calls, hosting) are not modelled yet. Source calls may dominate for some connectors;
measure them per connector in M2. The query planner (D28), on by default in the server since D33, adds no model call.
After its iterations it makes 1.36–1.47x planner-off's source calls per lookup in the simulation at time 0 and
1.23–1.32x at real pacing (about 5.6–6.2 calls per lookup against 4.1–4.65), and 1.00–1.74 calls per lookup per
connector on the lab's real servers at the current settings; with `maxCalls: 1` it adds none
(docs/research/query-planner-results.md).
