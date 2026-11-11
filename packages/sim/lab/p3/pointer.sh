#!/bin/bash
# P3 (c) (docs/research/p3-baselines.md §2): the pointer's days run, users w73-w104, two processes at a time.
set -uo pipefail
cd "$(dirname "$0")/../../../.."
L=packages/sim/lab/p3/run.sh; LOG=.local/p3/logs; mkdir -p $LOG
V='{"P":{"pushPointer":true}}'
for s in $(seq 73 2 103); do
  t=$((s + 1))
  for u in $s $t; do
    $L claude-haiku-5-5 c-days-$u --seeds $u --conditions eden,eden~P --variant-config "$V" --days 8 \
      --budget 0.5 > $LOG/c-days-$u.log 2>&1 &
  done
  wait
done
echo "$(date -u +%FT%TZ) pointer.sh done" >> .local/p3/starts.log
