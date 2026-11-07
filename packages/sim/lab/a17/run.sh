#!/bin/bash
# A17 (docs/research/a17-long-quality.md): LABEL PUSH CONDITIONS then pi-ab flags. A3's run.sh with its own ledger and a
# $2.50 hard cap; cards from the three checked-in card files concatenated into .local/a17/cards-all.jsonl.
L=$1; PUSH=$2; CONDS=$3; shift 3
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite train --conditions $CONDS --config default \
  --tenant-prompt \
  --cards .local/a17/cards-all.jsonl --cards-out .local/a17/runs/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push $PUSH \
  --spend-ledger .local/a17/ledger.jsonl --spend-cap 2.5 --spend-headroom 0.1 --run-label $L \
  --timeline .local/a17/runs/$L.tl --out .local/a17/runs/$L.json "$@"
