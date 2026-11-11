# M12: facts Eden holds that miss the push's pool

Status: 2026-11-11, branch `claude/m12-pool`, session M12 (decisions D1000–D1009). Work in progress.

## 1. The bar (pre-registered before any held-out read)

Fit (tune) on train1–4, train1r–4r and M2 v2 train/val; held out: train5, train6, train5r, train6r, longtail (seeds
41–42, `--neutral`), and M2 v2 `synth-test` read once at the end. Against main at the branch point, all of:

1. **Funnel ($0), held-out families pooled:** hidden in the push's pool (`pushPoolAt` ≥ 0) at least **+8 points**;
   decoys in pool rising no faster than facts (decoys_after / decoys_before ≤ hidden_after / hidden_before); neutral
   packets not up.
2. **Days-calls, rare-source facts handed:** up, never down.
3. **Pi pair against main** (pre-registered in its own commit before the run): hidden facts' clustered lower bound
   > 0, confirmed concerns not up by more than 1 per 1,000; cap $8.
4. **Speed and size:** ≤ 1 ms a request in the TypeScript path, ≤ 10 MB of shared model, per-user state compact
   (reported in bytes an item).
5. **Hard gates:** the short-item fixtures (`packages/sim/lab/m3r/short-constraints.jsonl`, `packages/sim/lab/m7/`)
   and length and format probes (a fact cut to its title and one sentence keeps its pool place as often as the full
   fact, within 5 points).

Decided the same day (D814): pass → promoted with a `PARTS` entry and a COST-MODEL entry; fail → the switch, its
code, weights and tests deleted.

## 2. Where main's misses are (fit only, $0)

`bun run funnel --suite train1–4,train1r–4r --seeds 41,42 -- --neutral` on main: hidden in the push's pool 370/512
(72.3%), decoys 349/512, neutral packets 596. Of the 142 hidden misses (the lab switch `pushWide` reads the lexical
search 60 deep and reports what the pool left out; the pool itself unchanged, 370 → 370):

| where the fact is | facts |
|---|---|
| no push at all (the request gate did not start one) | 23 |
| in the ranked rest or the lexical hits 13–60 (`pushWide` 60) | 38 |
| shares a word with the request, below the sixtieth hit | 34 |
| shares no word with the request | 53 |

Pools are full (1,168 of 1,536 passes hold 15), so any new channel displaces; 20 of the 370 pooled facts sit in seats
10–14. Date proximity (a day the request names within three days of one the fact names) reaches 9 of 119 misses
with about 32 competing items each.
