#!/bin/bash
# CL5 baseline on Pi: LABEL then pi-ab flags.
L=$1; shift
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite train --conditions tools,eden --config default \
  --cards .local/cl5/cards-all.jsonl --cards-out .local/cl5/runs/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push signals \
  --spend-ledger .local/cl5/ledger.jsonl --spend-cap 2 --spend-headroom 0.1 --run-label $L \
  --out .local/cl5/runs/$L.json "$@"
