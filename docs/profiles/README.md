# Engine profiles for `EDEN_ENGINE_CONFIG`

The servers run one configuration, the default (`DEFAULT_CONFIG`, D112). Each file here is the default minus one
part: exactly that part's entry in `PARTS` (`packages/engine/src/parts.ts`), checked by
`packages/server/src/engine-config.test.ts`, which parses every `*.json` here and builds a partner with it. Use one to
compare against the default, or to switch a part off in a deployment that must (for example `minus-reader` and
`minus-cards` send no item text to a model even with a key set). None is recommended over the default.

| Profile | Funnel hidden / decoys (of 384) | Eval precision | Eval recall | Eval falseFireRate | Eval p95 ms |
|---|---:|---:|---:|---:|---:|
| (none: the default) | 214 / 211 | 0.8 | 0.48 | 0.0147 | 12.4 |
| [`minus-reader.json`](minus-reader.json) | 214 / 211 | 0.8 | 0.48 | 0.0147 | 11.4 |
| [`minus-cards.json`](minus-cards.json) | 214 / 210 | 0.8 | 0.48 | 0.0147 | 10.7 |
| [`minus-sync.json`](minus-sync.json) | 197 / 190 | 0.8 | 0.48 | 0.0147 | 12.1 |
| [`minus-grounds.json`](minus-grounds.json) | 210 / 210 | 0.893 | 0.5 | 0 | 8.6 |

Measured 2026-11-03, $0, no model key:

```bash
bun run funnel --jobs 4 --preset minus-<part>      # train1–6, seeds 41–42, cards replayed, reader stub
bun run eval --config "$(cat docs/profiles/minus-<part>.json)"
```

What the $0 screens cannot show: the funnel's reader is a stub (nothing binds) and its intent requests are not
replayed, so `minus-reader` and the intent half of `minus-cards` read as no change here; live, the reader and intent
are most of the default's gain (D98, D109, D112: hidden facts raised 29.7% → 73.4% on Pi against the old default).
The eval has no model and no card maker, so the reader and cards are inert in every row. Its p95 is in-process
static sources on a shared machine: an order of magnitude only. `minus-grounds` is a trial (DECISIONS.md, "Trial
switches"): the eval favours it, the funnel and the live evidence do not.
