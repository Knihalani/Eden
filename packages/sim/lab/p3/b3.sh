#!/bin/bash
# P3 (b3) (docs/research/p3-baselines.md §9): eden against hits over days on 32 more fresh users, two at a time.
set -uo pipefail
cd "$(dirname "$0")/../../../.."
L=packages/sim/lab/p3/run.sh; LOG=.local/p3/logs; mkdir -p $LOG; H=claude-haiku-5-5
for s in $(seq 105 2 135); do
  for u in $s $((s + 1)); do
    $L $H b3-days-$u --seeds $u --conditions eden,hits --days 4 --day-size 16 --budget 0.3 > $LOG/b3-days-$u.log 2>&1 &
  done
  wait
done
echo "$(date -u +%FT%TZ) b3.sh done" >> .local/p3/starts.log
