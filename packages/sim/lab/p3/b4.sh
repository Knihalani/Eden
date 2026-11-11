#!/bin/bash
# P3 (b4) (docs/research/p3-baselines.md §10): eden against hits one request a session on fresh seeds 45-46.
set -uo pipefail
cd "$(dirname "$0")/../../../.."
L=packages/sim/lab/p3/run.sh; LOG=.local/p3/logs; mkdir -p $LOG; H=claude-haiku-5-5
for s in 45 46; do
  $L $H b4-short-$s --seeds $s --conditions eden,hits --variants hidden,control,neutral --budget 0.8 \
    > $LOG/b4-short-$s.log 2>&1 &
done
wait
echo "$(date -u +%FT%TZ) b4.sh done" >> .local/p3/starts.log
