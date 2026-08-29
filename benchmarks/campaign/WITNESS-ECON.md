# Witness economics (Wave 2.4)

Every campaign / soak go-live SKIP or INCONCLUSIVE is tagged to a **named
mechanism**. Classifier: `witness-econ.ts` (`classifyGoLive`). Wired into
`Session.goLive` as `mechanism?: string`. Sweep: `bun benchmarks/campaign/witness-sweep.ts`
writes `.gauntlet/refs/08-witness-sweep.json`.

PASS with no objection is left untagged (not `unknown`). Missing or
extrapolated usage (silent host, island tokens not scraped) is
`unmeasured_usage` — Wave 2.1 deleted the simulated-usage bypass, so this
no longer installs an UNCERTIFIED program.

## Mechanisms

| Mechanism | Verdict | How to read it | Arc 4? |
|---|---|---|---|
| `insufficient_traces` | SKIP | `only N complete traces` — recording never reached compile+holdout. Run more witnesses. | no |
| `variant_dilution` | SKIP | `only N clean traces of M` — fidelity dropped sloppy variants (desk skip-audit, incident retries) below holdout+3. | **yes** |
| `width_class_split` | SKIP | `dominant shape has only N clean traces` — mixed fan-out widths split the cluster; the biggest class is still too small to train+hold out. | **yes** |
| `envelope_gap` | INCONCLUSIVE | `n=N < minN` — held-out traces were not `inDistribution` of the compiled envelope (unique ids, novel width). | **yes** |
| `unvalidatable` | INCONCLUSIVE | Recording cannot answer the compiled calls (`never recorded`, env flake the recording also contains, `only N of M … could validate`). | no |
| `quality_fail` | FAIL | Extra misses / skip rate / output mismatch / deopt. This is a **FAIL**, not a SKIP. | no |
| `unmeasured_usage` | INCONCLUSIVE or UNCERTIFIED PASS | Extrapolated island tokens or missing time. Wave 2.1 shrinks this; still named. | no |
| `unknown` | any | Last resort. Promote to a new Arc 4 item (see leftovers). | **new item** |

## How to read a SKIP

`Session.goLive` fails closed in this order — the first reason is the mechanism:

1. **Complete traces** `< compile + holdout` → `insufficient_traces`. Not an Arc 4 bug; the session was short.
2. **Clean traces** `< holdout + 3` after the world's `fidelity` predicate → `variant_dilution`. Sloppy noise is voting against the cluster. Arc 4: variants should vote for sequence but not the envelope.
3. **Dominant width-class** `< holdout + 3` → `width_class_split`. Orders-world lesson: same-shape support needs ≥3 inside one width. Arc 4: width-class envelope inheritance.
4. Otherwise compile runs, then **shadow** on the hold-out:
   - `n=N < minN` → `envelope_gap`. Arc 4: rolling shadow / envelope coverage.
   - unrecorded call / env flake / too few validated → `unvalidatable`.
   - extra misses / skip rate / output mismatch → `quality_fail` (**FAIL**).
   - extrapolated tokens / no measured time → `unmeasured_usage`.

Do not treat (1) as (2): `only 4 complete traces` is not dilution. Do not treat
(3) as (2): `dominant shape has only 4 clean traces` contains "clean traces"
but is a width-class split.

## Arc 4 witness-efficiency (the three that stay)

Roadmap item: go-live needs ~13 witnesses today. The three named product gaps:

- **variant_dilution** — sloppy variants dilute clusters below support.
- **width_class_split** — mixed widths split the dominant shape.
- **envelope_gap** — hold-out not in the compiled envelope.

Done when campaign worlds certify at ≤8 witnesses with zero UNCERTIFIED
inflation and soak certification ≥95%. This file does not implement those;
it names every miss so Arc 4 is not guessing.

## Sweep result (Wave 2.4)

`CAMPAIGN_THINK_MS=0 bun benchmarks/campaign/witness-sweep.ts` — n=50,
mapped=1.000, unknown=0.000. Artifact: `.gauntlet/refs/08-witness-sweep.json`.
Re-run after Wave 2.1 (scraped island usage, no simulated-usage flag):
`unmeasured_usage` fell 9 → 2; certified `pass` rose 13 → 20.

| Mechanism | Count | Notes |
|---|---|---|
| `pass` (untagged certified) | 20 | desk/orders/etl/incident/research at 8–13 witnesses |
| `insufficient_traces` | 18 | nWitness 3–5 vs compile 9 + holdout 3 |
| `envelope_gap` | 5 | high-card unique ids; one incident cell |
| `width_class_split` | 4 | orders mixed fan-out widths |
| `unmeasured_usage` | 2 | silent / unscrapable research cells — not installed |
| `variant_dilution` | 1 | desk nWitness=8, fidelity dropped sloppy audits |
| `unvalidatable` | 0 | named + unit-tested; did not fire in this 50 |
| `quality_fail` | 0 | named + unit-tested; did not fire in this 50 |
| `unknown` | 0 | — |

## Leftover unknowns (Arc 4 items)

None. Every SKIP / INCONCLUSIVE / FAIL in the 50 mapped. The Arc 4
witness-efficiency work remains the three mechanisms that **did** fire and
are already on the roadmap:

1. **variant_dilution** — desk at 8 witnesses: sloppy skip-audit traces
   dropped the clean cluster below holdout+3.
2. **width_class_split** — orders: dominant width-class too small at 8–9
   witnesses (PASS only once the pool repeated at 10–13).
3. **envelope_gap** — high-card unique ids (hold-out not inDistribution);
   one incident cell at 8 witnesses.

`unmeasured_usage` is Wave 2.1 (attribution), not a new Arc 4 item.
`unvalidatable` / `quality_fail` stay named so a future soak miss is not
promoted blindly — they are not unexplained.
