#!/usr/bin/env bash
# Reproduces docs/research/query-planner-iterations.jsonl: the query planner's post-ship iterations, each a change
# measured against what it replaced (docs/research/query-planner-results.md, "Iterations"). Tune runs are on zoo-tune;
# reported runs on held-out sets. 6 simulated users, 15 sessions each, no model; one JSON line per run.
# Summarise with: python3 docs/research/query-planner-iterations.py docs/research/query-planner-iterations.jsonl
set -euo pipefail
cd "$(dirname "$0")/../.."
run() { # iteration label profile seed [flags...]
  local it=$1 label=$2 profile=$3 seed=$4
  shift 4
  bun packages/sim/src/quality-cli.ts --profile "$profile" --seed "$seed" --users 6 --sessions 15 "$@" 2>/dev/null \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print(json.dumps({'iteration':$it,'label':'$label',\
'profile':'$profile','seed':$seed,'overall':d['overall'],'funnel':d['funnel'],'sources':d['sources'],\
'plans':d.get('plans')}))"
}
# 1. A learned cascade gate (cascadeMin). Tune: the threshold; then held-out: off, before (0) and after (0.2).
for m in 0 0.1 0.2 0.3 0.4; do for seed in 1 2 3 4 5; do run 1 "cascade-min-$m" zoo-tune "$seed" --planner --planner-cascade-min "$m"; done; done
for profile in zoo-a zoo-b realistic; do
  for seed in 1 2 3 4 5; do
    run 1 off "$profile" "$seed"
    run 1 before "$profile" "$seed" --planner --planner-cascade-min 0
    run 1 after "$profile" "$seed" --planner --planner-cascade-min 0.2
  done
done
