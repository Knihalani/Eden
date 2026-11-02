#!/bin/bash
# usage: run-w.sh SUITES SEED LABEL : Pi, NEW with a 1 s first-observe wait, paired with NEW at 3 s
H=${HAIKU_DIR:-.local/haiku}; R=$H/p2/runs; cd "$(git rev-parse --show-toplevel)"
NEWV='{"NEW":{"intent":true,"askReader":true,"askReaderDrop":true,"readerPush":true}}'
S=$(date +%s)
bun packages/sim/src/lab/pi-ab.ts --suite $1 --seeds $2 --variants hidden,control --config ALL3 --variant-config $NEWV --cards $H/cards/cards-v2.jsonl --cards-out $R/$3.cards.jsonl --intent $H/intent/intent-v2.jsonl --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 --model claude-haiku-5-5 --grader claude-haiku-5-5 --budget 8 --spend-ledger $H/ledger.jsonl --spend-cap 40 --spend-headroom 3 --run-label $3 --out $R/$3.json --conditions eden~NEW@w1000,both~NEW@w1000,eden~NEW,both~NEW > $R/$3.log 2>&1
echo "exit=$? secs=$(( $(date +%s)-S ))" >> $R/$3.log
