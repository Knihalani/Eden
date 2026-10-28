#!/usr/bin/env bash
# Reproduces docs/research/query-planner-timed.jsonl: D31's timed check of the query planner. Source latency, agent
# pacing, the connectors' own rate limits (5-10 calls/s per user) and the engine's source timeout all run, at 1/10
# of real time (--time 0.1; rates and timeouts scale with it). 6 users, 4 sessions each, no model, seeds 11-13.
# Variants: planner off; "before" (main at 4c2b0ea, before iteration 3's deadline check: a temporary git worktree
# of that commit with only this tree's sim stats files, which add the `aborted` count, copied in); the deadline
# check at margin 1.25; and at the default margin (2). Run on a quiet machine: timing is part of what is measured.
set -euo pipefail
cd "$(dirname "$0")/../.."
root=$PWD
run() { # variant dir profile seed [flags...]
  local variant=$1 dir=$2 profile=$3 seed=$4
  shift 4
  (cd "$dir" && bun packages/sim/src/quality-cli.ts --profile "$profile" --seed "$seed" --users 6 --sessions 4 \
    --time 0.1 "$@" 2>/dev/null) | python3 -c "import json,sys;d=json.load(sys.stdin);print(json.dumps({\
'variant':'$variant','profile':'$profile','seed':$seed,'overall':d['overall'],'sources':d['sources'],\
'latency':d['latency']}))"
}
before=$(mktemp -d)
git worktree add -q --detach "$before/tree" 4c2b0eafa8595eaad1eb90ad3a57cae597910780
trap 'git -C "$root" worktree remove --force "$before/tree"' EXIT
cp packages/sim/src/sources.ts packages/sim/src/quality.ts "$before/tree/packages/sim/src/"
(cd "$before/tree" && bun install --frozen-lockfile >/dev/null 2>&1)
for profile in zoo-a zoo-b realistic; do
  for seed in 11 12 13; do
    run off "$root" "$profile" "$seed"
    run before "$before/tree" "$profile" "$seed" --planner
    run margin-1.25 "$root" "$profile" "$seed" --planner --planner-deadline-margin 1.25
    run margin-2 "$root" "$profile" "$seed" --planner
  done
done
