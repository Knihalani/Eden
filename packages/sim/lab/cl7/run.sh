#!/bin/bash
# CL7 on Pi: LABEL PUSH CONDITIONS then pi-ab flags (CL5's run.sh with the push mode and arms as arguments).
L=$1; PUSH=$2; CONDS=$3; shift 3
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --coverage full --suite train --conditions $CONDS --config default \
  --cards .local/cl7/cards-all.jsonl --cards-out .local/cl7/runs/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push $PUSH \
  --spend-ledger .local/cl7/ledger.jsonl --spend-cap 3 --spend-headroom 0.1 --run-label $L \
  --timeline .local/cl7/runs/$L.tl --out .local/cl7/runs/$L.json "$@"
