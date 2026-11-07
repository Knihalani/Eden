#!/bin/bash
# A3 on Pi (docs/research/a3-cost-speed.md): LABEL PUSH CONDITIONS then pi-ab flags. CL8's run.sh with every arm given
# the tenant's house rules (`--tenant-prompt`, D271), so every arm's fixed prefix is above the cache minimum.
# D274's cov arm ran on commit 7f9e37738: --variant-config '{"cov":{"pushCandidatesCovers":true}}'.
L=$1; PUSH=$2; CONDS=$3; shift 3
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite train --conditions $CONDS --config default \
  --tenant-prompt \
  --cards .local/a3/cards-all.jsonl --cards-out .local/a3/runs/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push $PUSH \
  --spend-ledger .local/a3/ledger.jsonl --spend-cap 2 --spend-headroom 0.1 --run-label $L \
  --timeline .local/a3/runs/$L.tl --out .local/a3/runs/$L.json "$@"
