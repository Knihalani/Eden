#!/usr/bin/env bash
# Reproduces docs/research/query-planner-iterations.jsonl: the query planner's post-ship iterations, each a change
# measured against what it replaced (docs/research/query-planner-results.md, "Iterations"). Tune runs are on zoo-tune;
# reported runs on held-out sets. 6 simulated users, 15 sessions each, no model; one JSON line per run.
# Summarise with: python3 docs/research/query-planner-iterations.py docs/research/query-planner-iterations.jsonl
set -euo pipefail
cd "$(dirname "$0")/../.."
run() { # iteration label profile seed judge [flags...]
  local it=$1 label=$2 profile=$3 seed=$4 judge=$5
  shift 5
  bun packages/sim/src/quality-cli.ts --profile "$profile" --seed "$seed" --users 6 --sessions 15 --judge "$judge" \
    "$@" 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print(json.dumps({'iteration':$it,\
'label':'$label','profile':'$profile','seed':$seed,'judge':'$judge','overall':d['overall'],'funnel':d['funnel'],\
'sources':d['sources'],'privacy':d['privacy'],'plans':d.get('plans')}))"
}
# 1. A learned cascade gate (cascadeMin). Tune the threshold on zoo-tune, with no model and with a perfect judge;
# then held-out: off, before (always cascade, 0) and after (the default, 0.05).
for judge in none perfect; do
  for seed in 1 2 3 4 5; do run 1 off zoo-tune "$seed" "$judge"; done
  for m in 0 0.05 0.1 0.2 0.3 0.4; do
    for seed in 1 2 3 4 5; do
      run 1 "cascade-min-$m" zoo-tune "$seed" "$judge" --planner --planner-no-reuse --planner-cascade-min "$m"
    done
  done
done
for profile in zoo-a zoo-b realistic; do
  for seed in 1 2 3 4 5; do
    run 1 off "$profile" "$seed" none
    run 1 before "$profile" "$seed" none --planner --planner-no-reuse --planner-cascade-min 0
    run 1 after "$profile" "$seed" none --planner --planner-no-reuse
  done
  for seed in 1 2 3; do
    run 1 off "$profile" "$seed" perfect
    run 1 before "$profile" "$seed" perfect --planner --planner-no-reuse --planner-cascade-min 0
    run 1 after "$profile" "$seed" perfect --planner --planner-no-reuse
  done
done
# 2. Reuse a shape's recent answer from the fan-out's cache (planCalls). Tune (seeds 1-5), then held-out on fresh
# seeds (6-10; 6-8 with a judge, since seeds 1-5 were looked at in iteration 1): off, before (no reuse), after.
for judge in none perfect; do
  for seed in 1 2 3 4 5; do run 2 after zoo-tune "$seed" "$judge" --planner; done
done
for profile in zoo-a zoo-b realistic; do
  for seed in 6 7 8 9 10; do
    run 2 off "$profile" "$seed" none
    run 2 before "$profile" "$seed" none --planner --planner-no-reuse
    run 2 after "$profile" "$seed" none --planner
  done
  for seed in 6 7 8; do
    run 2 off "$profile" "$seed" perfect
    run 2 before "$profile" "$seed" perfect --planner --planner-no-reuse
    run 2 after "$profile" "$seed" perfect --planner
  done
done
