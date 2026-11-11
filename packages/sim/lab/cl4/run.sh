#!/bin/bash
# usage: run.sh LABEL SUITE SEED VARIANTS CONDS [extra args...]
L=$1; SUITE=$2; SEED=$3; VAR=$4; CONDS=$5; shift 5
CARDS=.local/cl4/cards-train-all.jsonl
case $SUITE in heldout14*) CARDS=.local/cl4/cards-h14-all.jsonl;; esac
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --coverage full --suite $SUITE --seeds $SEED \
  --variants $VAR --conditions $CONDS --config default \
  --cards $CARDS --cards-out .local/cl4/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push signals --budget 1.0 \
  --spend-ledger .local/cl4/ledger.jsonl --spend-cap 3 --spend-headroom 0.3 --run-label $L \
  --timeline .local/cl4/$L.tl --out .local/cl4/$L.json "$@"
