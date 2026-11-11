#!/bin/bash
# P3 baselines (a) and (b) (docs/research/p3-baselines.md §1): every run of the pre-registration, each once, two
# Anthropic processes at a time.
set -uo pipefail
cd "$(dirname "$0")/../../../.."
L=packages/sim/lab/p3/run.sh; LOG=.local/p3/logs; mkdir -p $LOG
S=claude-sonnet-5-5; H=claude-haiku-5-5
$L $H b-short-41 --seeds 41 --conditions tools,eden,hits --variants hidden,control,neutral --budget 1.0 > $LOG/b-short-41.log 2>&1 &
$L $S a-sonnet-short-h --seeds 41 --conditions tools,eden --variants hidden --budget 5.0 > $LOG/a-sonnet-short-h.log 2>&1 &
wait
$L $H b-short-42 --seeds 42 --conditions tools,eden,hits --variants hidden,control,neutral --budget 1.0 > $LOG/b-short-42.log 2>&1 &
$L $S a-sonnet-short-c --seeds 41 --conditions eden --variants control --budget 2.5 > $LOG/a-sonnet-short-c.log 2>&1 &
wait
for s in 41 42 43 44; do
  $L $S a-sonnet-days-$s --seeds $s --conditions eden --days 4 --day-size 16 --budget 1.2 > $LOG/a-sonnet-days-$s.log 2>&1 &
  $L $H a-haiku-days-$s --seeds $s --conditions eden --days 4 --day-size 16 --budget 0.3 > $LOG/a-haiku-days-$s.log 2>&1 &
  wait
done
for s in $(seq 45 2 59); do
  t=$((s + 1))
  $L $H b-days-$s --seeds $s --conditions eden,hits --days 4 --day-size 16 --budget 0.4 > $LOG/b-days-$s.log 2>&1 &
  $L $H b-days-$t --seeds $t --conditions eden,hits --days 4 --day-size 16 --budget 0.4 > $LOG/b-days-$t.log 2>&1 &
  wait
done
echo "$(date -u +%FT%TZ) ab.sh done" >> .local/p3/starts.log
