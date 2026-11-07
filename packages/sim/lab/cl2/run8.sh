#!/bin/bash
# CL2 on CL5's long horizon (--days 8): the default (stop on, D240) against the default with the stop off.
L=$1; shift
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite train --conditions eden,eden~nostop --config default \
  --variant-config '{"nostop":{"readerStopEarly":false}}' \
  --cards .local/cl2/cards-all.jsonl --cards-out .local/cl2/long8/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push signals \
  --spend-ledger .local/cl2/ledger.jsonl --spend-cap 3 --spend-headroom 0.1 --run-label $L \
  --out .local/cl2/long8/$L.json "$@"
