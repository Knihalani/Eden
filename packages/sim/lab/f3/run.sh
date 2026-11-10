#!/bin/bash
# F3 (docs/research/f3-asks-bench-pilot.md): the paid runs, as they were made. Needs the Modal client
# (packages/sim/modal/README.md), MODAL_TOKEN_ID/SECRET, the Modal Secret HAIKU_API_KEY and, for the regrades,
# HAIKU_API_KEY locally. Run from the repository root. The askMulti arm exists only at commit e4acb716 (the trial
# was deleted by its rule, D485): EDEN_COMMIT pins the shards to it. Anthropic spend: $9.44 in all.
set -euo pipefail
export SSL_CERT_FILE=${SSL_CERT_FILE:-/root/.ccr/ca-bundle.crt} EDEN_COMMIT=e4acb716
go() { modal run packages/sim/modal/lab_fanout.py --preset "$2" --seeds "$3" --cap "$4" --run "$1" --args "$5"; }
go f3-b-41 bench-fewer 41-44 2.40 "--conditions tools,eden,eden~minus-fewer,eden+askMulti"   # B, and A's short arms
go f3-a-long bench-fewer 41-44 0.40 "--conditions eden,eden+askMulti --days 8"                 # A, a user's days
go f3-b-45 bench-fewer 45-48 1.80 ""                                                            # B, cards made in-run
go f3-b-49 bench-fewer 49-68 4.40 "--variants hidden"                                           # B, hidden only
M=.local/modal
regrade() { # LABEL CAP OUT "FLAGS" SHARD...
  local label=$1 cap=$2 out=$3 flags=$4; shift 4
  for s in "$@"; do
    env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results "$s/out.json" --graders claude-sonnet-5-5 \
      --spend-ledger ".local/f3/$label-ledger.jsonl" --spend-cap "$cap" --spend-headroom 0.02 --run-label "$label" \
      --out "$s/$out" $flags
  done
}
mkdir -p .local/f3
regrade f3-a-regrade 2.20 regrade-hidden.json "--kinds hidden --conditions eden,eden+askMulti" $M/f3-b-41/s0* $M/f3-a-long/s0*
regrade f3-a-regrade 2.20 regrade-concerns.json "--only-concerns --conditions eden,eden+askMulti" $M/f3-a-long/s0*
regrade f3-a-regrade 2.20 regrade-concerns-a.json "--only-concerns --conditions eden,eden+askMulti" $M/f3-b-41/s0*
regrade f3-b-regrade 0.25 regrade-concerns-b.json "--only-concerns --conditions tools,eden~minus-fewer" $M/f3-b-41/s0*
regrade f3-b-regrade 0.25 regrade-concerns-b.json "--only-concerns --conditions tools,eden,eden~minus-fewer" $M/f3-b-45/s0*
O=packages/sim/lab/f3; R="python3 -I packages/sim/modal/bench_report.py"
$R --pair eden+askMulti:eden --group short=$M/f3-b-41 --group long=$M/f3-a-long --sonnet --json $O/askmulti.json > $O/askmulti.txt
$R --pair eden+askMulti:eden --group short=$M/f3-b-41 --group long=$M/f3-a-long --metrics hidden,concerns > $O/askmulti-haiku.txt
$R --pair eden:tools --pair eden~minus-fewer:eden --group cached=$M/f3-b-41 --group inrun=$M/f3-b-45,$M/f3-b-49 \
  --sonnet concerns --json $O/bench.json > $O/bench.txt
