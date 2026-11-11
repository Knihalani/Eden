#!/bin/bash
# A22 on Pi (docs/research/a22-quality.md): LABEL PUSH CONDITIONS then pi-ab flags. A15's run.sh with A22's ledger and
# the tenant's house rules in every arm (`--tenant-prompt`, D271); the trial was `eden+linkLine` (D360, rejected; the switch is in commit 3a3e51b9 only).
L=$1; PUSH=$2; CONDS=$3; shift 3
MODEL=${A22_MODEL:-claude-haiku-5-5}
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --coverage full --suite train --conditions $CONDS --config default \
  --cards .local/a22/cards-all.jsonl --cards-out .local/a22/runs/$L.cards.jsonl \
  --model $MODEL --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push $PUSH --tenant-prompt \
  --spend-ledger .local/a22/ledger.jsonl --spend-cap 2.5 --spend-headroom 0.1 --run-label $L \
  --timeline .local/a22/runs/$L.tl --out .local/a22/runs/$L.json "$@"
