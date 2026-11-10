#!/bin/bash
# N1b: the reports over the fan-outs' shards (.local/modal/n1b-*). `report.sh regrade` first (Sonnet on the answers
# Haiku called concerns, $ capped; needs HAIKU_API_KEY), then `report.sh` writes the files beside this script.
# LONG_RUNS and SHORT_INRUN name the runs (comma lists) when seeds were added or dropped.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
M=.local/modal; O=packages/sim/lab/n1b
SHORT_INRUN=${SHORT_INRUN:-n1b-short-45,n1b-short-49}; LONG_RUNS=${LONG_RUNS:-n1b-long}
dirs() { local IFS=,; local out=(); for r in $1; do out+=("$M/$r"); done; echo "${out[*]}"; }
if [ "${1:-}" = regrade ]; then
  mkdir -p .local/n1b
  for s in $M/n1b-short-41/s0* $(for r in ${LONG_RUNS//,/ }; do echo $M/$r/s0*; done); do
    env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results "$s/out.json" \
      --graders claude-sonnet-5-5 --only-concerns --spend-ledger .local/n1b/regrade-ledger.jsonl --spend-cap 0.15 \
      --spend-headroom 0.02 --run-label n1b-regrade --out "$s/regrade.json"
  done
  exit 0
fi
R="python3 -I packages/sim/modal/bench_report.py --pair eden:eden~off-yield --sonnet concerns"
$R --group short-41-44=$M/n1b-short-41 --group "short-45-68=$(dirs "$SHORT_INRUN")" \
  --group "long=$(dirs "$LONG_RUNS")" --target 1.5 --json $O/bench.json > $O/bench.txt
$R --group "short=$M/n1b-short-41,$(dirs "$SHORT_INRUN")" --group "long=$(dirs "$LONG_RUNS")" > $O/bench-horizons.txt
# Connector calls, paired task by task (a8/pair.py; "off" is the default with sourceYield off, "yield" the default).
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
  python3 -I packages/sim/lab/a8/pair.py off="$(arm "eden~off-yield")" yield="$(arm eden)" --pair off,yield > "$out"
}
pair $O/pair-short.txt n1b-short-41 ${SHORT_INRUN//,/ }
pair $O/pair-long.txt ${LONG_RUNS//,/ }
cost() { # OUT RUN...
  local out=$1 files=(); shift
  for run in "$@"; do files+=($M/"$run"/s*/out.json); done
  bun packages/sim/src/lab/pi-cost-report.ts "${files[@]}" > "$out"
}
cost $O/pi-cost-short.txt n1b-short-41 ${SHORT_INRUN//,/ }
cost $O/pi-cost-long.txt ${LONG_RUNS//,/ }
for r in n1b-smoke n1b-short-41 ${SHORT_INRUN//,/ } ${LONG_RUNS//,/ }; do cp $M/$r/manifest.json $O/manifest-${r#n1b-}.json; done
