# @eden/llm

The model layer: the `Model` interface, the OpenRouter client (ZDR, no data collection), prices, `Budget` (the
ration every model call goes through), `FakeModel` for tests, the lab's `Pacer`, and the lab-only Anthropic client.
No dependencies (plain `fetch`).

**Another session may be editing `src/*.ts` here: check `git log origin/main -- packages/llm` before changing code.**

## Files

| File | Owns |
|---|---|
| `src/types.ts` | `Model`, `ChatRequest` (with `reasoning`, D45; `signal`), `ChatResponse` (usage, cost, `truncated`) |
| `src/openrouter.ts` | `OpenRouterModel`: `provider.data_collection: "deny"` and ZDR by default (D12); `fromEnv` (`OPENROUTER_API_KEY`, `EDEN_MODEL`, `EDEN_MODEL_ZDR`); `sort` routing (D66); lab-only `allowLogging` (D91) |
| `src/budget.ts` | `Budget`: calls and USD per session and per user-day (`DEFAULT_LIMITS` 20 calls, $0.02/session, $0.25/user-day); `reserve` before, `settle` after |
| `src/pricing.ts` | `PRICES`, `priceFor` (`EDEN_MODEL_PRICE` override), `costOf`: estimates for budgeting; OpenRouter's reported cost wins |
| `src/pacing.ts` | `Pacer` (lab): per-minute limit, request cap (`RequestCapReached`), 429/5xx backoff honouring Retry-After |
| `src/anthropic.ts` | `AnthropicModel` (lab only, D97): Messages API, prompt caching, streaming TTFT, cost from usage, a `meter` hook the spend ledger uses |
| `src/fake.ts`, `src/tokens.ts` | `FakeModel` (scripted replies, records calls); `estimateTokens` |

## Rules that apply here

- **Model last (D4, D5).** No model call on the fast path. Every call goes through a `Budget` with bounded input;
  over budget the engine takes its no-model path and queues nothing to spend later. A new per-event call needs a
  decision and a cost estimate in `docs/COST-MODEL.md`.
- **Production routing is D12.** `fromEnv` (and so the server) never sets `allowLogging`; tests pin that. Only the
  lab passes it (`packages/sim/src/lab/free.ts`), on simulated data.
- **Anthropic is lab only (D97).** Nothing in engine or server constructs `AnthropicModel`; production use needs its
  own decision, PRIVACY.md and COST-MODEL.md (D98 says the same for NEW's reader).
- **Secrets.** Never log or print `OPENROUTER_API_KEY`, `HAIKU_API_KEY` or `ANTHROPIC_API_KEY`; errors must not
  include request headers. Tests run with `OPENROUTER_*` and `EDEN_*` cleared (`scripts/test-preload.ts`).
- **Untrusted text (D11).** Prompts are built by callers (engine `judge.ts`, `cards.ts`, `bridge.ts`, `reader.ts`),
  which fence item text as data; this package sends what it is given.

## Test

```bash
bun run test:pkg llm             # < 0.1 s; fetch is faked, no network
```

## Pitfalls

- A test that needs a key sets it on the options, never in `process.env` (the preload clears it and other files
  must not see it).
- `pacing.test.ts` drives time through injected clocks; do not add real sleeps.

## Where next

`docs/COST-MODEL.md`, `docs/PRIVACY.md`, `docs/research/edge-freelab.md` (D91), `docs/research/haiku-opt.md` and
`haiku-benchmark.md` (D97, D98), `packages/sim/src/lab/free.ts` and `spend.ts` (how the lab wires these).
