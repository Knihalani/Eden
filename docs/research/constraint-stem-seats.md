# Constraint stem seats (D2100, trial)

`pushConstraintStemSeats` is default off. With a push checker wired, a second
bounded cache ranking uses D2035's stem families, without `ASK_FAMILY` synonyms.
At most two constraint-like items outside the existing pool are seated alongside
day seats. The pool cap is unchanged; the original pool remains the fallback for
an absent, failed or late check. Explicit asks are unchanged. No affiliation
expansion is included.

## Offline measurements

Fresh main `49fb22b9f`, seeds 41–44, direct hidden funnel, serial, instant source
timings, no replayed cards or explicit asks. All runs use `--no-record`; no ledger
rows were written. Calls and ms per task include hidden and control windows, not
initial backfill.

| Noise sources | Flag | Hidden delivered | Decoy delivered | Calls/task | ms/task |
| ------------- | ---- | ---------------- | --------------- | ---------- | ------- |
| 995           | off  | 32/40            | 12/40           | 9.5625     | 28.4854 |
| 995           | on   | 32/40            | 12/40           | 9.5625     | 26.4110 |
| 3000          | off  | 32/40            | 12/40           | 7.8250     | 64.5758 |
| 3000          | on   | 32/40            | 12/40           | 7.8250     | 61.2829 |

Quality: four users, ten sessions, local judge; off and on were identical:

| Seed | Recall | Precision | False-fire rate |
| ---- | ------ | --------- | --------------- |
| 13   | .826   | .532      | .071            |
| 7    | .753   | .513      | .067            |

These screens wire **no push checker**. The new path is deliberately inactive
without one, so flat delivery is a safety result, not evidence of active retrieval
benefit. Wall-time differences are run noise, not a speed improvement. Keep the
flag off pending an active-check evaluation. Deterministic fake-checker tests
exercise successful checked delivery, the two-seat bound, no synonyms, empty
results/cache and absent/failed/late checker fallback. Raising the seat limit
from two to twenty makes the bound assertion fail (expected 2, received 3);
the source was restored with a Python patch.

Reproduction (repeat each command with the flag false/true, each scale/seed):

```sh
bun packages/sim/src/lab/hidden-funnel.ts --suite hidden --seeds 41,42,43,44 \
  --noise-sources 995 --serial --time 0 --config '{"pushConstraintStemSeats":true}' \
  --label diag-1122-stem --no-record --json /path/to/result.json
bun packages/sim/src/quality-cli.ts --users 4 --sessions 10 --seed 13 \
  --judge local --brief --config '{"pushConstraintStemSeats":true}'
```

Raw measurements: `/home/ubuntu/diag-1122/stem-{995,3000}-{off,on}.json`
and `stem-quality-{13,7}-{off,on}.json`.
