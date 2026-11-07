#!/bin/bash
# A12 on Pi (docs/research/a12-quality.md): LABEL PUSH CONDITIONS then pi-ab flags. A2's run.sh with A12's arms:
# reader = pushCandidates 0 (the pre-D237 reader push, for reference), nudge = askNudge (D316 trial).
L=$1; PUSH=$2; CONDS=$3; shift 3
VC='{"reader":{"pushCandidates":0},"nudge":{"askNudge":true}}'
MODEL=${A12_MODEL:-claude-haiku-5-5}
GRADER=${A12_GRADER:-claude-haiku-5-5}
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite train --conditions $CONDS --config default \
  --variant-config "$VC" \
  --cards .local/a12/cards-all.jsonl --cards-out .local/a12/runs/$L.cards.jsonl \
  --model $MODEL --grader $GRADER --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push $PUSH \
  --spend-ledger .local/a12/ledger.jsonl --spend-cap 3 --spend-headroom 0.1 --run-label $L \
  --timeline .local/a12/runs/$L.tl --out .local/a12/runs/$L.json "$@"
