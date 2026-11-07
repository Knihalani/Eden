#!/bin/bash
# A30 (docs/research/a30-token-gap.md): LABEL PUSH CONDITIONS then pi-ab flags. A3's run.sh (train, house rules
# `--tenant-prompt`, D271) with A30's ledger (hard cap $2) and the D400 trial arm `few2` (pushCandidatesSettled 2).
L=$1; PUSH=$2; CONDS=$3; shift 3
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite train --conditions $CONDS --config default \
  --variant-config '{"few2":{"pushCandidatesSettled":2}}' --tenant-prompt \
  --cards .local/a30/cards-all.jsonl --cards-out .local/a30/runs/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push $PUSH \
  --spend-ledger .local/a30/ledger.jsonl --spend-cap 2 --spend-headroom 0.1 --run-label $L \
  --timeline .local/a30/runs/$L.tl --out .local/a30/runs/$L.json "$@"
