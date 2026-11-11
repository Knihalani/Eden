#!/bin/bash
# A6 moonshots on Pi (docs/research/a6-moonshots.md): LABEL PUSH CONDITIONS then pi-ab flags. CL8's run.sh with A6's
# arms (VC below names each trial switch's variant).
L=$1; PUSH=$2; CONDS=$3; shift 3
VC=${A6_VC:-'{}'}
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --coverage full --suite train --conditions $CONDS --config default \
  --variant-config "$VC" \
  --cards .local/a6/cards-all.jsonl --cards-out .local/a6/runs/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push $PUSH \
  --spend-ledger .local/a6/ledger.jsonl --spend-cap 3 --spend-headroom 0.1 --run-label $L \
  --timeline .local/a6/runs/$L.tl --out .local/a6/runs/$L.json "$@"
