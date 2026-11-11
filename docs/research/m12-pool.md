# M12: facts Eden holds that miss the push's pool

Status: 2026-11-11, branch `claude/m12-pool`, session M12 (decisions D1000–D1004). **Stopped before any held-out
read** (§5): nothing wired, the trial switches deleted. Simulated data only; heldout19 not read or run.

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

## 3. Hypotheses and round 1 (fit only; every model trained on M2 v2, so the sim rows are out of family)

All request-side or selection-side; M11 owned item-side expansion (it stopped, D970s). "Sim" = the funnel's own
pools on train1–4 and train1r–4r, seeds 41–42 (main at the branch point: hidden 370, decoys 349 of 512 each);
"M2 val" = M2 v2 val worlds planted among a sim base world, BM25's first 15 as the lexical pool. S = tail seats
given to the new channel. The ratio clause: decoys_after / 349 ≤ hidden_after / 370.

| # | hypothesis | M2 val (facts / decoys, points) | sim (hidden / decoys) | verdict |
|---|---|---|---|---|
| H1 | query→item term table distilled from the teacher (low-rank trained, served as a 630 KB sparse table, `poolExpand`), its own search fills S seats | +2.5–5.3 / +3.0–4.5 (A1–A4, L0) | offline S=3 380–394 / 362–384; **real funnel (L0, S=3) 368 / 359** | killed: decoys as fast or faster in every variant; truth-only (A3) beat teacher-only (A4) |
| H2 | contextual query net (hashed request grams → binary/float hidden → item-term logits) | +2.1–3.7 / +0.6–2.3 (B1–B3) | S=3 371–383 / 354–359 | +2.5 points at best |
| H3 | `pushWide` 60-deep lexical read and a feature re-ranker of the tail | in-sample +2.1 / +2.8 | S=5 384 / 364 | +2.7 / +2.9: decoys as fast |
| H4 | pseudo-relevance feedback from the pool head's rare terms | — | +5 / +8 facts / decoys gained at best | killed |
| H5 | teacher-distilled discrete keys | not run: the ceiling below says candidates are not the binding constraint | — | — |
| H7 | date proximity | — | 9 of 119 misses reachable, about 32 competitors each | a feature only |
| H8 | **a request × item scorer distilled from the 8B teacher** (M3's binary kernel, listwise on the teacher's soft scores), filling S seats from pool ∪ `pushWide` ∪ a scan of every held item by its codes (`poolScan`) | fact over its decoy 0.82–0.94 | see §4 | the only signal; §4 |

**Ceiling (perfect selector, sim):** of 142 misses, the union of `pushWide`'s 60 and H1's first 10 new items holds 31
facts (+6.1 points) and 39 decoys; their first 30 each, 52 facts (+10.2) and 58 decoys (`ceiling.py`). +8 points needs
a near-perfect selector over about 60 candidates that also tells a fact from its twin.

## 4. H8 developed (rounds 2 and 3)

| run | what | offline sim, scan, best S (hidden / decoys) | live funnel (TS forward, parity 64/64) | length probe (fact cut to title + 20 terms, the selector's first 5: full / cut) |
|---|---|---|---|---|
| P1 | float, M2 groups only | (no scan) S=3 391 / 366 | — | — |
| P4 | float + code scan | S=3 411 / 368; the scan holds 70 missed facts, 39 decoys | — | — |
| P5 | binary 4.2 MB + fine-tune on engine-drawn synth-train candidates with the teacher's scores mapped | S=8 410 / 364 | **old main: S=8 395 / 354 (+4.9 / +1.0 points); S=3 397 / 370** | not measured (reads whole items) |
| P6 | float, as P5 | S=8 432 / 384 | not servable (67 MB) | — |
| P7, P8 | float, binary + length augmentation | S=8 391 / 350, 394 / 367 | — | 168 / 125, 177 / 96: **fails** |
| P10 | binary, the item read as title + 20 terms | S=3 388 / 369; scan holds 41 facts, 42 decoys | — | 139 / 141: passes |
| P9 | binary, title + 30 terms | S=8 392 / 354 | **main b99f0171 (pushGate in; baseline 397 / 369): S=3 +2.0 / +1.8, S=5 +1.0 / +0.2, S=8 −1.8 / −3.1 points** | 154 / 143: passes |

On main b99f0171 P5 itself read S=3 +3.9 / +4.1, S=5 +4.1 / +3.3, S=8 +0.8 / +1.4 points: the gate now starts pushes
whose ranked pools hold more of the facts it used to add. A length-only scan (the 30 longest items the pool and the
wide read left out) holds 23 missed facts and 12 decoys on the sim: the same 2:1 the scorer's scan showed. Made blind to
length, the scorer no longer prefers facts (P10: 41 against 42).

Wiring that stayed honest: the seats the scorer filled never opened the packet gate (the ranked pool decided whether a
packet went), so neutral packets stayed 596 → 596. Speed and size (P9, this container): model 4.2 MB, item code
110–200 µs once a cached copy (32 bytes an item), a scan of 3,000 codes 0.10–0.14 ms, 100 pair scores 0.58–0.68 ms.

## 5. Decision (D1000–D1004): stopped before any held-out read

The round-3 rule (sent to the parent before the round-3 reads): a binary model passing the length probe within 5
points and at least +6 points hidden in pool live on the sim with the decoy ratio under the hidden one. The
length-blind models reach +2.0 points at best on current main, so `pushWide`, `poolExpand` and `poolScan` are deleted
with their engine code (D814). The held-out families, M2 test, days-calls and the Pi pair were never run, so §1's bar
has no reading. The teacher's edge over the sim's twins was item length (M14's warning: on M2, length alone ranks a
fact above its twin in 94% of tasks); without it, what reaches a fact reaches its twin, M3's and M9's ceiling.
Offline overstated live by about 15 facts in 512 (P5: 410 against 395).

Kept, lab only: `packages/sim/lab/m12/` (`data.py`, `train.py` expansion trainer, `pairnet.py` the distilled scorer,
`rerank.py`, `prf.py`, `ceiling.py`, `poolscore.py`, `export_table.py`, `export_pair.py`, the TypeScript forwards
`pool-pair.ts` and `pool-expand.ts` with `pool-pair.test.ts` and `pair-parity.ts`), `packages/sim/src/lab/m12-export.ts`
and `packages/sim/modal/m12_train.py`. Data and weights on the Modal Volume `eden-m12` (`r1/`, `runs/`). The pool
dumps with `wide` candidates came from the deleted `pushWide` switch: rebuilding them needs it back (commit a752c23b).

Spend: Anthropic $0 (the two Haiku helper sessions' own usage about $0.18); Modal about 7.5 container-hours of 8 CPU,
about $5 [EST]; every app stopped.

## Reproduce ($0 unless noted)

```bash
unset OPENROUTER_API_KEY
bun run funnel --jobs 4 --suite train1,train2,train3,train4,train1r,train2r,train3r,train4r --seeds 41,42 \
  --json fit.json -- --neutral --pool-dump $PWD/fit-pool.jsonl --corpus-dump $PWD/fit-corpus.jsonl
bun packages/sim/src/lab/m12-export.ts --corpus fit-corpus.jsonl --out fit.terms.jsonl
bun packages/sim/src/lab/m12-export.ts --synth .local/m2/synth/worlds/train.jsonl --out strain.terms.jsonl
python3 -I packages/sim/lab/m12/train.py --train strain.terms.jsonl --teacher train.t8b.jsonl.gz \
  --val sval.terms.jsonl --distract fit.terms.jsonl --fit-terms fit.terms.jsonl --fit-pool fit-pool.jsonl --model lowrank
modal run packages/sim/modal/m12_train.py --run P9 --script pairnet.py --args "--worlds 0 --dot-weight 1 \
  --len-aug 0.3 --buckets 32768 --width 128 --wide 30 --item-cap 30 --wide-train /vol/r1/train-wide.jsonl.gz \
  --synth-raw /vol/r1/strain.raw.jsonl.gz"                                       # about $0.6 [EST]
python3 -I packages/sim/lab/m12/export_pair.py P9/model.pt P9.ep12 --val sval.terms.jsonl --checks P9.checks.json
bun packages/sim/lab/m12/pair-parity.ts P9.ep12 P9.checks.json                    # 64/64, timings
```
