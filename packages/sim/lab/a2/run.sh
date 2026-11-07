#!/bin/bash
# A2 on Pi (docs/research/a2-quality.md): LABEL PUSH CONDITIONS then pi-ab flags. CL8's run.sh with A2's arms:
# lift = pushCandidateLift (D266 trial), past = askPastShown (D267), both = the two, ls = lift + pushCandidateStress (D268).
L=$1; PUSH=$2; CONDS=$3; shift 3
VC='{"lift":{"pushCandidateLift":true},"past":{"askPastShown":true},"both":{"pushCandidateLift":true,"askPastShown":true},"ls":{"pushCandidateLift":true,"pushCandidateStress":true}}'
MODEL=${A2_MODEL:-claude-haiku-5-5}
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite train --conditions $CONDS --config default \
  --variant-config "$VC" \
  --cards .local/a2/cards-all.jsonl --cards-out .local/a2/runs/$L.cards.jsonl \
  --model $MODEL --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push $PUSH \
  --spend-ledger .local/a2/ledger.jsonl --spend-cap 3 --spend-headroom 0.1 --run-label $L \
  --timeline .local/a2/runs/$L.tl --out .local/a2/runs/$L.json "$@"
