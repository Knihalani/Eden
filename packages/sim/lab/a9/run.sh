#!/bin/bash
# A9 answer-ahead and plan-conflict on Pi (docs/research/a9-ahead.md): LABEL PUSH CONDITIONS then pi-ab flags. A6's
# run.sh with A9's ledger (cap $2.5) and arms (A9_VC names each trial switch's variant); A9_SUITE (default train).
L=$1; PUSH=$2; CONDS=$3; shift 3
VC=${A9_VC:-'{}'}
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --coverage full --suite ${A9_SUITE:-train} --conditions $CONDS \
  --config default --variant-config "$VC" \
  --cards .local/a9/cards-all.jsonl --cards-out .local/a9/runs/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push $PUSH \
  --spend-ledger .local/a9/ledger.jsonl --spend-cap 2.5 --spend-headroom 0.1 --run-label $L \
  --timeline .local/a9/runs/$L.tl --out .local/a9/runs/$L.json "$@"
