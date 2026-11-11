#!/bin/bash
# usage: run.sh LABEL SUITE SEED PROFILE CONDITIONS [extra args...]
set -u
cd "$(git rev-parse --show-toplevel)"
R=.local/rb/runs; L=$1; SUITE=$2; SEED=$3; PROF=$4; CONDS=$5; shift 5
S=$(date +%s)
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --coverage full --suite $SUITE --seeds $SEED --variants hidden,control \
  --conditions $CONDS --config default --variant-config "$(cat .local/rb/ablate.json)" \
  --cards .local/rb/enrich/cards-merged.jsonl --cards-out $R/$L.cards.jsonl --intent .local/rb/enrich/intent-v2.jsonl \
  --source-profile packages/sim/lab/before-after/market-profiles/$PROF.json --push signals \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --budget 2 --spend-ledger .local/ledger.jsonl --spend-cap 9 --spend-headroom 0.3 --run-label rb-$L \
  --timeline $R/$L.timeline --out $R/$L.json "$@" > $R/$L.log 2>&1
echo "exit=$? secs=$(( $(date +%s)-S ))" >> $R/$L.log
