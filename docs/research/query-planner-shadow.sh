#!/usr/bin/env bash
# Reproduces docs/research/query-planner-shadow.jsonl: the query planner's shadow phase, run in simulation
# (docs/research/query-planner-results.md). Each run: 6 simulated users, 15 sessions each, no model.
set -euo pipefail
cd "$(dirname "$0")/../.."
run() { # profile seed label [flags...]
  local profile=$1 seed=$2 label=$3
  shift 3
  bun packages/sim/src/quality-cli.ts --profile "$profile" --seed "$seed" --users 6 --sessions 15 "$@" 2>/dev/null \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print(json.dumps({'profile':'$profile','seed':$seed,\
'run':'$label','users':6,'sessions':15,'overall':d['overall'],'funnel':d['funnel'],'sources':d['sources'],\
'learning':d['learning'],'shadow':d.get('shadow')}))"
}
for profile in zoo-a zoo-b realistic; do
  for seed in 1 2 3 4 5; do
    run "$profile" "$seed" off
    run "$profile" "$seed" shadow --planner --planner-mode shadow
    run "$profile" "$seed" serve --planner
    run "$profile" "$seed" shadow-then-serve --planner --planner-mode shadow --promote-after 5
  done
done
