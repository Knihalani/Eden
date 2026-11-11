#!/bin/bash
# A16 loop moonshots on Pi (docs/research/a16-loop.md): LABEL PUSH CONDITIONS then pi-ab flags. A6's run.sh with
# A3's tenant prompt in every arm (D271) and A16's ledger; A16_VC names each trial switch's variant.
L=$1; PUSH=$2; CONDS=$3; shift 3
VC=${A16_VC:-'{}'}
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --coverage full --suite train --conditions $CONDS --config default \
  --variant-config "$VC" --tenant-prompt \
  --cards .local/a16/cards-all.jsonl --cards-out .local/a16/runs/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push $PUSH \
  --spend-ledger .local/a16/ledger.jsonl --spend-cap 2.5 --spend-headroom 0.1 --run-label $L \
  --timeline .local/a16/runs/$L.tl --out .local/a16/runs/$L.json "$@"
