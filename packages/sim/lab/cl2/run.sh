#!/bin/bash
# CL2's Pi runs (docs/research/cl-cl2.md). Needs the train cards merged once:
#   cat packages/sim/lab/cards/cards-v2.jsonl packages/sim/lab/cards/cards-train.jsonl > .local/cl2/cards.jsonl
# Variants: diet = askReaderPool 10 + readerStopEarly, stop = readerStopEarly (now the default, D240: on today's
# tree `eden` is the stop arm; pass a variant with "readerStopEarly": false to rebuild the old default).
# run.sh SEED LABEL SUITE VARIANTS LIMIT [extra...]
SEED=$1; L=$2; SUITE=$3; VARS=$4; LIM=$5; shift 5
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite $SUITE --seeds $SEED --limit $LIM \
  --variants $VARS --conditions ${CONDS:-tools,eden,eden~diet} --config default \
  --variant-config '{"diet":{"askReaderPool":10,"readerStopEarly":true},"stop":{"readerStopEarly":true}}' \
  --cards .local/cl2/cards.jsonl --cards-out .local/cl2/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push signals --budget 1.0 \
  --spend-ledger .local/cl2/ledger.jsonl --spend-cap 3 --spend-headroom 0.3 --run-label $L --out .local/cl2/$L.json "$@"
