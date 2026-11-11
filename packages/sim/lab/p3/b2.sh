#!/bin/bash
# P3 (b2) (docs/research/p3-baselines.md §7): the hits arm again with its own prompt and Eden's compaction, on (b)'s
# tasks and users, two processes at a time.
set -uo pipefail
cd "$(dirname "$0")/../../../.."
L=packages/sim/lab/p3/run.sh; LOG=.local/p3/logs; mkdir -p $LOG; H=claude-haiku-5-5
$L $H b2-short-41 --seeds 41 --conditions hits --variants hidden,control,neutral --budget 0.5 > $LOG/b2-short-41.log 2>&1 &
$L $H b2-short-42 --seeds 42 --conditions hits --variants hidden,control,neutral --budget 0.5 > $LOG/b2-short-42.log 2>&1 &
wait
for s in $(seq 45 2 59); do
  for u in $s $((s + 1)); do
    $L $H b2-days-$u --seeds $u --conditions hits --days 4 --day-size 16 --budget 0.3 > $LOG/b2-days-$u.log 2>&1 &
  done
  wait
done
echo "$(date -u +%FT%TZ) b2.sh done" >> .local/p3/starts.log
