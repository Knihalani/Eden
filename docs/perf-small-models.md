# Small-model profile — measured on qwen2.5:1.5b (A2)

The eval run against Ollama (`EDEN_MODEL_BASE_URL=http://localhost:11434/v1`, `EDEN_MODEL=qwen2.5:1.5b`),
shipped wiring (`--live` = the role reader, no judge), vs the free no-model run.

Commands:

```
bun run eval
EDEN_MODEL_BASE_URL=http://localhost:11434/v1 EDEN_MODEL=qwen2.5:1.5b bun run eval --live --usd-cap 1
```

## Result

| metric | no-model | qwen2.5:1.5b |
|---|---|---|
| precision | 0.981 | 0.981 |
| recall | 1.0 | 1.0 |
| falseFireRate | 0 | 0 |
| model calls/turn | 0 | 0.046 (7 calls, all pushCheck) |
| pushCheck failures | — | 3/7 (43%) |
| check-late | — | 6 |

The 1.5B neither helps nor hurts on the eval: the shipped default calls the reader so rarely
(D237) that its quality cannot move precision or recall, and its failed/late checks fail open to
the unchecked candidates. The cost is real though — 7 local inference calls for zero measured
gain, 43% of them unparseable or timed out.

## What the eval does NOT measure

The harness wires no card maker, so the `cards`/`cardsRetry` roles are unexercised in this
number — an honest gap. Cards are a background role writing structured constraint cards; a 1.5B
model's card output quality would need a dedicated cards eval to assess. The intent index rides
on the same dep and is equally unmeasured.

## Per-role off switch

`EDEN_MODEL_ROLES` is a comma allowlist of `reader`, `cards`, `cardsRetry` (unset = all three;
implemented in `modelRolesFromEnv`, both the OpenRouter and local-endpoint branches). An off role
gets a null model and its path runs exactly as with no endpoint.

Recommended for tiny local models (≤ ~2B): start with `EDEN_MODEL_ROLES=cards` — keep the
background carding (cheap to try, its quality is visible in deliveries) and skip the request-path
reader the shipped default barely calls. For bigger local models, all three.

## A CPU box: llama.cpp, Qwen3-4B (D2118–D2121)

Measured on the lab's 4-core, 16 GB container (no GPU), `llama-server` serving
Qwen3-4B-Instruct-2507 Q4_K_M with flash attention:

| | |
|---|---|
| prefill | ~90–110 tok/s |
| decode, one slot | ~4.8 tok/s |
| decode, four slots together | ~6.8 tok/s in all |
| one ten-item card batch | ~3,000 prompt tokens, ~350 out: about 2 minutes alone |

What that means for a deployment on a box like this:

- **Give the server several slots** (`--parallel 4`, and `--cache-type-k q8_0 --cache-type-v q8_0` to fit
  their context in memory: four slots at `-c 24576` with an f16 cache were killed for memory beside an
  agent model). The card enricher keeps up to four batches in flight, and batched decoding costs little
  more than one.
- **Deadlines.** The card roles wait 15 minutes by default (D2119) and Bun's own 360 s fetch cutoff is off
  (D2120): before both, every batch on this box was dropped uncovered.
- **Backfill time.** A seeded world of ~1,500 items is ~155 batches: about 3–4 hours of CPU here, once.
  A GPU or Apple silicon should be far faster (not measured here).
- **Card quality.** Against Haiku 5.5's shipped cards for the same train items (D2121), Qwen3-4B under the
  shipped prompt finds 42% of the constraint cards at 48% precision on randomly mixed batches of ten
  (train2/train5, 80 items), and 22% at 33% precision in the enricher's own queue order, where like items
  sit together. A prompt asking for an entry per item made it worse (12.5% recall) and was not adopted.
  Expect a small local model's cards to cover well under half of what a hosted model's do.
- **Request-path roles on CPU.** The push check waits 1.5 s for its answer; a check prompt of a couple of
  thousand tokens is ~20 s of prefill here, so every check would land late (D2082 still serves it later)
  while taking the CPU the agent's own model needs. On a CPU-only box, start with `EDEN_MODEL_ROLES=cards`:
  the background card role is where a slow local model pays off.
