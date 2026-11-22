# Check-only constraint seats: default adoption (D2106)

Base: fresh `origin/main` `ab4a4aae1`. Both `pushConstraintStemSeats` (D2100) and
`pushPartyOrgLink` (D2101) now default true. Each can still be disabled explicitly;
part `check` disables both. Their `NEEDS_DEP` checker declarations remain, and
without a checker neither retrieval path nor automatic affiliation indexing runs.
As with other model-dependent defaults, config validation accepts the defaults
without that dependency; the engine then takes its unchanged unchecked path.

## Free funnel: main → new defaults

Direct hidden suite, seeds 41–44, noise 995/3000, serial, time 0, default config
with **no seat overrides**, `--no-record`. Every row has 40 hidden and 40 control
tasks. Oracle TP=1/FP=0; noisy TP=.85/FP=.05. All completed runs have zero checker
failures and $0 model cost. The hidden pool increases 32→40 in every row.

| Noise | Checker | Check dump | Hidden delivered | Decoy delivered |
| ----: | ------- | ---------- | ---------------: | --------------: |
|   995 | oracle  | no         |          32 → 40 |           0 → 0 |
|  3000 | oracle  | no         |          32 → 40 |           0 → 0 |
|   995 | noisy   | yes        |          27 → 33 |           1 → 1 |
|  3000 | noisy   | yes        |          27 → 33 |           1 → 1 |
|   995 | noisy   | no         |          26 → 32 |           0 → 0 |
|  3000 | noisy   | no         |          26 → 32 |           0 → 0 |

**Instrumentation caveat:** the prior noisy evidence used `--check-dump`.
Matching that option reproduces its 33/40 and 1/40 with the new defaults. Omitting
it yields 32/40 and 0/40 instead, on both noise scales; the paired hidden gain is
still six. This difference also occurs on unchanged main. The existing dump path
uses `replyKeeping` and `DumpingChecker.check` (`check-dump.ts`), adding async
wrappers before a check settles. These synthetic instant-check delivery counts
are ordering-sensitive; this change does not alter that harness or engine timing.

Reproduce on each tree, with N=995/3000 and MODE=oracle/noisy:

```sh
bun packages/sim/src/lab/hidden-funnel.ts --suite hidden --seeds 41,42,43,44 \
  --noise-sources "$N" --serial --time 0 --no-record --check "$MODE" \
  --json "$OUT.json"
# For the prior noisy evidence, also add --check-dump "$OUT-checks.jsonl".
```

Concurrent high-noise attempts were killed (exit 137; the service cgroup reported
OOM kills). The affected measurements were completed one process at a time;
partial attempts are excluded. Artifacts, including those partial logs, are at
`~/diag-1122/adopt-seats/`.

## Free quality safety screen

Both trees ran the full default quality workload (six users × fifteen sessions,
realistic profile, time 0, no model/judge) at seeds 1, 7 and 13. Every `overall`
field, including the underlying counts, matches exactly. There is no checker in
this suite, so this screens unchecked-path regressions, not active-check accuracy.

| Seed | Precision   | Recall      | False-fire rate |
| ---: | ----------- | ----------- | --------------- |
|    1 | .342 → .342 | .590 → .590 | .070 → .070     |
|    7 | .393 → .393 | .595 → .595 | .032 → .032     |
|   13 | .382 → .382 | .646 → .646 | .016 → .016     |

```sh
for seed in 1 7 13; do bun run sim --time 0 --seed "$seed" --brief; done
```

## Free eval

`bun run eval` on main and the new defaults exits successfully. Summary JSONs:

Main `ab4a4aae1`:

```json
{
  "precision": 0.9811320754716981,
  "recall": 1,
  "falseFireRate": 0,
  "counts": {
    "expected": 52,
    "found": 52,
    "delivered": 53,
    "deliveredExpected": 52,
    "silentTurns": 69,
    "falseFires": 0
  },
  "modelCallsPerTurn": 0,
  "costPerTurnUsd": 0
}
```

New defaults:

```json
{
  "precision": 0.9811320754716981,
  "recall": 1,
  "falseFireRate": 0,
  "counts": {
    "expected": 52,
    "found": 52,
    "delivered": 53,
    "deliveredExpected": 52,
    "silentTurns": 69,
    "falseFires": 0
  },
  "modelCallsPerTurn": 0,
  "costPerTurnUsd": 0
}
```

Both have 32 scenarios, 153 turns and 107 scored turns. Free eval leaves the push
checker inert. Full eval JSONs are retained alongside the quality/funnel artifacts.

## Limits

Adoption rests on **free check-only retrieval/applicability evidence**, not paid
confirmation of this default change. No real checker accuracy, explanation
quality, latency or agent uptake benefit is established. Oracle decoy rejection is
by construction; noisy errors are synthetic. No new paid calls or ledger rows
were made for this adoption.
