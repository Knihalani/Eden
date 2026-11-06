# Cache-neutral agent cost in a paired Pi run (D171)

Status: adopted (tooling), 2026-11-06. Deep audit 2026-11-06 round 2, finding
`quality-d159-cost-gate-prompt-cache-artefact`, package `pi-cost-cache-neutral`. Every number below comes from the
commands in "Reproduce", run at $0 on D159's Pi held-out 13 pair (no model call, ledger untouched).

## The problem

D159's looser intent thresholds were kept out of the default because the Pi held-out 13 pair (seeds 41 and 42,
conditions `eden` and `eden~loose`, Haiku 5.5 on the Anthropic-direct lab transport) read hidden-task agent+Eden
+0.070 $/1k (95% CI +0.008..+0.129), which failed D112's "no extra paid cost". Most of that rise is the A/B harness,
not the variant:

- `pi-ab.ts:1133-1137` starts every condition as its own concurrent stream over the same tasks.
- Both arms get the same agent system prompt (`systemPrompt(world, { lookups, data, act })`, `pi-ab.ts:800`: it does
  not depend on the variant's engine config), and Anthropic calls use `cacheRetention: "short"` (`pi-ab.ts:850`).
- So when two arms send the same first request at about the same time, whichever writes the prompt cache first makes
  the other's request a cache read. Haiku 5.5 bills a written token at $0.125 per Mtok and a read one at $0.01, so the
  arm that loses the race pays more for the same tokens.

In production there is no twin arm: this is an A/B artefact only, and it falls only on pairs whose arms share a
prompt prefix (variant, flag and wait conditions against their base).

## Prices

`reprice.ts` gains a cache-write price and `MODEL_PRICES["claude-haiku-5-5"]` = $0.10 input, $0.01 cache read,
$0.125 cache write, $0.50 output per Mtok. A least-squares fit over the pair's 404 agent requests (uncached input,
cache read, cache write, output against each request's billed cost) returns exactly these prices, with a largest
residual of 3e-19 dollars; at the stated prices the largest residual is 1e-19, and the request costs of all 256 task
runs sum to their results' `costUsd` (`fit.py` below). They are also the prices `ANTHROPIC_PRICES` in `@eden/llm`
books (5-minute TTL), which `reprice.test.ts` checks. `cacheNeutral(price)` bills cached and written tokens as plain
input: what the request's tokens cost whoever wrote the cache.

## What the report prints now

`pi-ab-report.ts` keeps the billed paired difference as it was (same Rng, same numbers) and adds, per pair:

- under each kind's line, the cache-neutral agent+Eden difference (D171's gate), the agent's billed and cache-neutral
  difference, and Eden's own per-task cost, each with a bootstrap 95% CI (its own Rng, seed 2, 4 decimals);
- an `all` line (every kind pooled) and a `same-ask` line (pairs whose `ask_context` calls were identical, so the arms
  send much the same requests), each also with the billed agent+Eden difference;
- the re-priced section, skipped for Haiku before, now prints billed, the list price (a check: it equals billed) and
  the cache-neutral price per condition.

## Results on D159's pair (eden~loose minus eden, $ per 1k tasks)

| Pairs | n | billed agent+Eden | cache-neutral agent+Eden | agent billed | agent cache-neutral | Eden |
|---|---|---|---|---|---|---|
| hidden | 64 | +0.070 (+0.008..+0.129) | +0.0305 (-0.0292..+0.0938) | +0.0532 (+0.0271..+0.0773) | +0.0132 (-0.0092..+0.0338) | +0.0172 (-0.0260..+0.0588) |
| control | 64 | +0.007 (-0.084..+0.095) | -0.0070 (-0.0989..+0.0790) | -0.0045 (-0.0328..+0.0204) | -0.0185 (-0.0471..+0.0098) | +0.0115 (-0.0499..+0.0766) |
| all | 128 | +0.0387 (-0.0169..+0.0924) | +0.0117 (-0.0425..+0.0637) | +0.0244 (+0.0050..+0.0429) | -0.0026 (-0.0213..+0.0153) | +0.0144 (-0.0232..+0.0545) |
| same asks | 47 | +0.0461 (+0.0194..+0.0724) | -0.0002 (-0.0212..+0.0177) | +0.0417 (+0.0176..+0.0660) | -0.0047 (-0.0180..+0.0083) | +0.0044 (-0.0051..+0.0132) |

The hidden and control billed columns are the report's existing `$/1k` lines, unchanged by this package (diffed against
the report before it). Per condition, agent $/1k: `eden` billed 0.316, cache-neutral 0.378; `eden~loose` billed
0.340, cache-neutral 0.375.

Read:

- On the 47 identical-ask pairs (all 47 are pairs where neither arm asked anything) the arms send the same number of
  requests (difference 0) and input tokens differ by +2.7 per task on average, yet billed agent cost rises +0.0417
  $/1k: cached input -402.7 tokens per task and cache-write +405.5 (`race.py`, means only). Repriced cache-neutral, the
  agent+Eden difference is -0.0002 with a CI that includes 0. The rise is the cache race.
- The first request's cache read on those 47 pairs went to the baseline arm 28 times, to the variant 5 times, with 14
  ties (`race.py`; a verifier's count with a slightly different rule was 29, 5 and 13). Over all 128 pairs, first
  requests (eden/loose) were read/written 55 times, written/read 19, both read 30, both written 24. The baseline is
  listed first and wins the race more often, so the bias runs against the condition listed second.
- On hidden tasks, cache-neutral agent+Eden is +0.0305 (CI -0.0292..+0.0938): D112's cost check, read as D171 says,
  does not fail on this pair. Estimate, arithmetic on the table: the cache race accounts for about 0.0532 - 0.0132 =
  0.040 $/1k of the hidden-task billed rise.
- This does not promote D159. Its hidden recall on this pair is only neutral (+0.031, CI -0.063..+0.125) and the pair
  replayed no intent file (finding `quality-pi-heldout13-intent-inert`); DECISIONS.md D159 says what reopens it.

## Limits

- Cache-neutral also removes the within-task cache hits production does get (a task's second request reads its own
  first), so its level is higher than billed (0.378 against 0.316 for `eden`). It is for differences between arms,
  not for absolute cost; COST-MODEL.md's figures stay billed.
- A variant that genuinely breaks within-task caching (an injection placed before the cached prefix, say) would look
  neutral here and dearer billed: that is why the billed line stays printed beside it (D171).
- The cleaner fix, randomising or alternating arm start order per task in `pi-ab.ts`, needs a paid pair to validate
  (about $0.27, from the pair's $0.1331 + $0.1339 per a verifier; not re-measured) and is not built.
- `same-ask` compares `asks` records exactly; a timeline without them (before pi-ab recorded asks) gets no such line.
  Records missing for a run drop that pair from the new lines (`n` says how many count).

## Reproduce

```bash
S=<scratch>/ib   # D159's pair: pi-41.json, pi-42.json and their .timeline/tasks.jsonl
bun packages/sim/src/lab/pi-ab-report.ts $S/pi-41.json $S/pi-42.json        # the table above, about 1 s, $0
bun test packages/sim/src/lab/reprice.test.ts                                # prices, cache write, cache-neutral
python3 -I fit.py; python3 -I race.py   # audit scratch scripts (not committed): the price fit and the race counts
```
