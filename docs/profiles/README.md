# Engine profiles for `EDEN_ENGINE_CONFIG`

Checked-in JSON files an operator can point `EDEN_ENGINE_CONFIG` at (D103, D104). Each one parses with the servers'
own check (`parseEngineConfig`; `packages/server/src/engine-config.test.ts` loads every `*.json` here and builds a
partner with it), so every key is one the shipped servers can run.

**None is recommended.** The numbers below are the no-model train funnel and the no-model eval only: no held-out
suite, no live agent, no model. The production defaults (no file) stay the shipped choice; recommending a profile
needs its own decision with a held-out check (D104).

| Profile | Funnel hidden / decoys (of 384) | Eval precision | Eval recall | Eval falseFireRate | Eval p95 ms |
|---|---:|---:|---:|---:|---:|
| (none: production defaults) | 122 / 127 | 1 | 0.444 | 0 | 3.7 |
| [`fallback-asks.json`](fallback-asks.json) | 122 / 127 | 1 | 0.467 | 0 | 3.7 |
| [`all3-no-cards.json`](all3-no-cards.json) | 214 / 210 | 0.909 | 0.444 | 0.0167 | 9.0 |
| [`all3-no-cards-no-grounds.json`](all3-no-cards-no-grounds.json) | 213 / 210 | 1 | 0.467 | 0 | 9.7 |
| ALL3 (lab only: needs `cards`, replayed) | 214 / 211 | – | – | – | – |

- `fallback-asks`: the defaults plus `fallbackAsks`. One more eval item found (20 to 21 of 45); no funnel change.
- `all3-no-cards`: the lab's ALL3 (D80) without `cards` and `cardsEconomy`, which the servers refuse. On this funnel
  cards add about 0 (214 vs 214 hidden, 210 vs 211 decoys), but decoys rise with hidden facts (127 to 210), and on the
  eval one false fire appears. The funnel replays cached cards; D80's live and held-out evidence for ALL3 included
  cards, so this says nothing about live parity.
- `all3-no-cards-no-grounds`: the same without `groundConflict` and `groundOccasion`, the two flags behind that false
  fire. Eval precision back to 1; funnel 213 / 210. Decoys still track hidden facts (0.99x), against task #47's bar of
  at most 0.6x.

## How these were measured (2026-11-03, $0, no model key)

```bash
bun run funnel --jobs 4 --preset none                                        # defaults
bun run funnel --jobs 4                                                      # ALL3, cards replayed
bun run funnel --jobs 4 --preset none --set "$(cat docs/profiles/<name>.json)"
bun run eval                                                                 # defaults
bun run eval --config "$(cat docs/profiles/<name>.json)"
```

Funnel: train1–6, seeds 41–42, `--ask` (a hidden item counts when delivered or cited by an ask). Eval: 27 scenarios,
no model. Latency is the eval's own p95 on a shared machine; read it as an order of magnitude.
