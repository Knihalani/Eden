#!/usr/bin/env bash
# Reproduces docs/research/query-planner-timed.jsonl: D31's timed check of the query planner. Source latency, agent
# pacing, the connectors' own rate limits (5-10 calls/s per user) and the engine's source timeout all run, at 1/10
# of real time (--time 0.1; rates and timeouts scale with it). 6 users, 4 sessions each, no model, seeds 11-13.
# Variants: planner off; "before" (main at 4c2b0ea, before iteration 3's deadline check: a temporary git worktree
# of that commit with only this tree's sim stats files, which add the `aborted` count, copied in); the deadline
# check at margin 1.25; and at the default margin (2). Iteration 4's rows follow (below). Run on a quiet machine:
# timing is part of what is measured. `query-planner-timed.sh 4` prints only iteration 4's rows.
set -euo pipefail
cd "$(dirname "$0")/../.."
root=$PWD
run() { # variant dir profile seed [flags...]
  local variant=$1 dir=$2 profile=$3 seed=$4
  shift 4
  (cd "$dir" && bun packages/sim/src/quality-cli.ts --profile "$profile" --seed "$seed" --users 6 --sessions 4 \
    --time 0.1 "$@" 2>/dev/null) | python3 -c "import json,sys;d=json.load(sys.stdin);r={\
'variant':'$variant','profile':'$profile','seed':$seed,'overall':d['overall'],'sources':d['sources'],\
'latency':d['latency']};r.update({'iteration':$iteration} if $iteration>3 else {});print(json.dumps(r))"
}
only=${1:-all} # "3", "4", "4-tune" or "4-report": only those rows
iteration=3
if [ "$only" = all ] || [ "$only" = 3 ]; then
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
fi
# Iteration 4: the deadline check also expects the connector's recent call latency at a quantile (latencyQuantile).
# Tuned on seeds 21-23, then reported on fresh seeds 31-33 (11-13 chose iteration 3's margin).
iteration=4
if [ "$only" = all ] || [ "$only" = 4 ] || [ "$only" = 4-tune ]; then
  for profile in zoo-a zoo-b realistic; do
    for seed in 21 22 23; do
      run off "$root" "$profile" "$seed"
      for q in 0 0.5 0.9; do
        run "tune-quantile-$q" "$root" "$profile" "$seed" --planner --planner-latency-quantile "$q"
      done
    done
  done
fi
if [ "$only" = all ] || [ "$only" = 4 ] || [ "$only" = 4-report ]; then
  for profile in zoo-a zoo-b realistic; do
    for seed in 31 32 33; do
      run off "$root" "$profile" "$seed"
      run before "$root" "$profile" "$seed" --planner --planner-latency-quantile 0
      run after "$root" "$profile" "$seed" --planner
    done
  done
fi
