#!/bin/bash
# usage: run.sh pi|hermes SUITES SEED LABEL
set -u
# --time-scale 0 (connectors instant) pins the setting the committed results ran at; the pi-ab/hermes-ab default
# became 1 on 2026-11-03 (packages/sim/src/lab/CLAUDE.md).
H=${HAIKU_DIR:-.local/haiku}; R=$H/p2/runs; cd "$(git rev-parse --show-toplevel)"
NEWV='{"NEW":{"intent":true,"askReader":true,"askReaderDrop":true,"readerPush":true}}'
COMMON="--suite $2 --seeds $3 --variants hidden,control --config ALL3 --variant-config $NEWV --cards $H/cards/cards-v2.jsonl --cards-out $R/$4.cards.jsonl --intent $H/intent/intent-v2.jsonl --card-model claude-haiku-5-5 --bridge-model claude-haiku-5-5 --reader-model claude-haiku-5-5 --model claude-haiku-5-5 --grader claude-haiku-5-5 --budget 8 --time-scale 0 --spend-ledger $H/ledger.jsonl --spend-cap 40 --spend-headroom 3 --run-label $4 --out $R/$4.json"
S=$(date +%s)
if [ "$1" = pi ]; then
  bun packages/sim/src/lab/pi-ab.ts --coverage full $COMMON --conditions none,tools,eden,eden~NEW,both~NEW > $R/$4.log 2>&1
else
  bun packages/sim/src/lab/hermes-ab.ts --coverage full --hermes-src ${HERMES_SRC:-../hermes-agent} --concurrency ${HC:-6} $COMMON --conditions hermes,hermes+eden,hermes+eden~NEW > $R/$4.log 2>&1
fi
echo "exit=$? secs=$(( $(date +%s)-S ))" >> $R/$4.log
