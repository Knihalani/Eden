#!/bin/bash
# RealUse-3 on Pi, heldout16 blind (docs/research/realuse-3/pi-heldout16.md): LABEL PUSH CONDITIONS then pi-ab flags.
# CL7's run.sh on heldout16 with the reader arm (`eden~reader`: pushCandidates 0, as docs/profiles/minus-candidates.json).
L=$1; PUSH=$2; CONDS=$3; shift 3
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite heldout16 --conditions $CONDS --config default \
  --variant-config '{"reader":{"pushCandidates":0}}' \
  --cards .local/ru3/cards-all.jsonl --cards-out .local/ru3/runs/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push $PUSH \
  --spend-ledger .local/ru3/ledger.jsonl --spend-cap 4 --spend-headroom 0.1 --run-label $L \
  --timeline .local/ru3/runs/$L.tl --out .local/ru3/runs/$L.json "$@"
