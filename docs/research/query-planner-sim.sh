#!/usr/bin/env bash
# Reproduces docs/research/query-planner-sim.jsonl, tier 2 of the query planner
# (docs/research/query-planner-results.md).
# Each run: 6 simulated users, 15 sessions each, no model unless --judge perfect; one JSON line per run.
set -euo pipefail
cd "$(dirname "$0")/../.."
run() { # profile seed label judge [planner flags...]
  local profile=$1 seed=$2 label=$3 judge=$4
  shift 4
  bun packages/sim/src/quality-cli.ts --profile "$profile" --seed "$seed" --users 6 --sessions 15 \
    --judge "$judge" "$@" 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print(json.dumps({\
'profile':'$profile','seed':$seed,'planner':'$label','judge':'$judge','users':6,'sessions':15,\
'overall':d['overall'],'funnel':d['funnel'],'sources':d['sources']}))"
}
for profile in zoo-a zoo-b zoo-tune realistic; do
  for seed in 1 2 3 4 5; do
    run "$profile" "$seed" off none
    run "$profile" "$seed" on none --planner
  done
done
for seed in 1 2 3; do
  run zoo-a "$seed" off perfect
  run zoo-a "$seed" on perfect --planner
done
for profile in zoo-a zoo-b realistic; do
  for seed in 1 2 3 4 5; do run "$profile" "$seed" on-1call none --planner --planner-max-calls 1; done
done
