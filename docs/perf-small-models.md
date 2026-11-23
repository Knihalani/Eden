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
