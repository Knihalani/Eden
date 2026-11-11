#!/bin/bash
# B18: every run of the pre-registration, each once, at most two Anthropic processes at a time. For each seed the pre
# and now arms run side by side (same minutes, same load), then the tools arm's short and days runs side by side.
set -uo pipefail
cd "$(dirname "$0")/../../../.."
L=packages/sim/lab/b18/run.sh
LOG=.local/b18/logs; mkdir -p $LOG
SHORT="--variants hidden,control,neutral --budget 1"
DAYS="--days 2 --day-size 16 --budget 0.6"
for s in 41 42 43 44; do
  $L pre b18-short-pre-$s --seeds $s $SHORT > $LOG/short-pre-$s.log 2>&1 &
  $L now b18-short-now-$s --seeds $s $SHORT > $LOG/short-now-$s.log 2>&1 &
  wait
  $L pre b18-days-pre-$s --seeds $s $DAYS > $LOG/days-pre-$s.log 2>&1 &
  $L now b18-days-now-$s --seeds $s $DAYS > $LOG/days-now-$s.log 2>&1 &
  wait
  $L tools b18-short-tools-$s --seeds $s $SHORT > $LOG/short-tools-$s.log 2>&1 &
  $L tools b18-days-tools-$s --seeds $s $DAYS > $LOG/days-tools-$s.log 2>&1 &
  wait
done
echo "$(date -u +%FT%TZ) all.sh done" >> .local/b18/starts.log
