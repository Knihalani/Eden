#!/usr/bin/env bash
# Reproduces docs/research/query-planner-timed.jsonl: D31's timed check of the query planner. Source latency, agent
# pacing, the connectors' own rate limits (5-10 calls/s per user) and the engine's source timeout all run, at 1/10
# of real time (--time 0.1; rates and timeouts scale with it). 6 users, 4 sessions each, no model.
set -euo pipefail
cd "$(dirname "$0")/../.."
run() { # label profile seed [flags...]
  local label=$1 profile=$2 seed=$3
  shift 3
  bun packages/sim/src/quality-cli.ts --profile "$profile" --seed "$seed" --users 6 --sessions 4 --time 0.1 "$@" \
    2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print(json.dumps({'label':'$label',\
'profile':'$profile','seed':$seed,'overall':d['overall'],'sources':d['sources'],'latency':d['latency']}))"
}
for profile in zoo-a zoo-b realistic; do
  for seed in 11 12 13; do
    run off "$profile" "$seed"
    run planner "$profile" "$seed" --planner
  done
done
