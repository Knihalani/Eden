#!/bin/bash
# O1: the reports over a preset's fan-out shards (.local/modal/o1-PRESET-*). `report.sh PRESET ARM regrade` first
# (Sonnet on the answers Haiku called concerns, $ capped; needs HAIKU_API_KEY), then `report.sh PRESET ARM` writes
# the files into packages/sim/lab/o1/PRESET/. ARM is the trial's arm (eden~earn); the pair is ARM − eden.
# SHORT_INRUN and LONG_RUNS name the runs (comma lists).
set -euo pipefail
cd "$(dirname "$0")/../../../.."
P=${1:?preset}; ARM=${2:?arm}
M=.local/modal; O=packages/sim/lab/o1/$P; mkdir -p "$O" .local/o1
SHORT41=o1-$P-short-41; SHORT_INRUN=${SHORT_INRUN:?comma list of in-run short runs}; LONG_RUNS=${LONG_RUNS:-o1-$P-long}
dirs() { local IFS=,; local out=(); for r in $1; do out+=("$M/$r"); done; echo "${out[*]}"; }
if [ "${3:-}" = regrade ]; then
  for s in $M/$SHORT41/s0* $(for r in ${LONG_RUNS//,/ }; do echo $M/$r/s0*; done); do
    env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results "$s/out.json" \
      --graders claude-sonnet-5-5 --only-concerns --spend-ledger .local/o1/ledger.jsonl \
      --spend-cap "${REGRADE_CAP:-0.15}" --spend-headroom 0.02 --run-label "o1-$P-regrade" --out "$s/regrade.json"
  done
  exit 0
fi
R="python3 -I packages/sim/modal/bench_report.py --pair $ARM:eden --sonnet concerns"
$R --group short-41-44=$M/$SHORT41 --group "short-in-run=$(dirs "$SHORT_INRUN")" \
  --group "long=$(dirs "$LONG_RUNS")" --target 1.5 --json $O/bench.json > $O/bench.txt
$R --group "short=$M/$SHORT41,$(dirs "$SHORT_INRUN")" --group "long=$(dirs "$LONG_RUNS")" > $O/bench-horizons.txt
# Connector calls, paired task by task (a8/pair.py).
pair() { # OUT RUN...
  local out=$1 stems=(); shift
  for run in "$@"; do
    for shard in $M/"$run"/s*/; do
      [ -f "$shard/out.json" ] || continue
      local stem=$M/$run/$(basename "$shard")-stem
      ln -sfn "$(basename "$shard")/out.json" "$stem.json"; ln -sfn "$(basename "$shard")/out.timeline" "$stem.tl"
      stems+=("$stem")
    done
  done
  arm() { local IFS=,; local o=(); for s in "${stems[@]}"; do o+=("$s:$1"); done; echo "${o[*]}"; }
  python3 -I packages/sim/lab/a8/pair.py default="$(arm eden)" trial="$(arm "$ARM")" --pair default,trial > "$out"
}
pair $O/pair-short.txt $SHORT41 ${SHORT_INRUN//,/ }
pair $O/pair-long.txt ${LONG_RUNS//,/ }
cost() { # OUT RUN...
  local out=$1 files=(); shift
  for run in "$@"; do files+=($M/"$run"/s*/out.json); done
  bun packages/sim/src/lab/pi-cost-report.ts "${files[@]}" > "$out"
}
cost $O/pi-cost-short.txt $SHORT41 ${SHORT_INRUN//,/ }
cost $O/pi-cost-long.txt ${LONG_RUNS//,/ }
for r in $SHORT41 ${SHORT_INRUN//,/ } ${LONG_RUNS//,/ }; do cp $M/$r/manifest.json $O/manifest-${r#o1-$P-}.json; done
