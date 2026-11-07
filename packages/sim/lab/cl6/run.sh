#!/bin/bash
# CL6 (H19, the agent is the reader) on Pi: LABEL CONDITIONS PUSH then pi-ab flags. The CL5 baseline's shape
# (packages/sim/lab/cl5/run.sh) with the conditions and the push mode named; variants are given with --variant-config.
L=$1; CONDS=$2; PUSH=$3; shift 3
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite train --conditions $CONDS --config default \
  --cards .local/cl6/cards-all.jsonl --cards-out .local/cl6/runs/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push $PUSH \
  --spend-ledger .local/cl6/ledger.jsonl --spend-cap 3.5 --spend-headroom 0.1 --run-label $L \
  --timeline .local/cl6/runs/$L.tl --out .local/cl6/runs/$L.json "$@"
