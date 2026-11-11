#!/bin/bash
# A15 on Pi (docs/research/a15-retrieval.md): LABEL PUSH CONDITIONS then pi-ab flags. A2's run.sh with A15's
# ledger; the trial was a flag, `eden+pushReach` (D330, rejected; the switch is in commit 1041e04d only).
L=$1; PUSH=$2; CONDS=$3; shift 3
MODEL=${A15_MODEL:-claude-haiku-5-5}
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --coverage full --suite train --conditions $CONDS --config default \
  --cards .local/a15/cards-all.jsonl --cards-out .local/a15/runs/$L.cards.jsonl \
  --model $MODEL --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push $PUSH \
  --spend-ledger .local/a15/ledger.jsonl --spend-cap 2.5 --spend-headroom 0.1 --run-label $L \
  --timeline .local/a15/runs/$L.tl --out .local/a15/runs/$L.json "$@"
