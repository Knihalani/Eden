#!/bin/bash
# A21 live Pi check of the 1,000-source default (docs/research/a21-scale.md): LABEL CONDITIONS then pi-ab flags.
# A8's run.sh with A21's ledger (cap $1.5); `--noise-sources 995` gives Eden's arm 995 noise connectors beside the five.
L=$1; CONDS=$2; shift 2
mkdir -p .local/a21/runs
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite train --conditions $CONDS --config default \
  --cards .local/a21/cards-all.jsonl --cards-out .local/a21/runs/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload \
  --spend-ledger .local/a21/ledger.jsonl --spend-cap 1.5 --spend-headroom 0.1 --run-label $L \
  --timeline .local/a21/runs/$L.tl --out .local/a21/runs/$L.json "$@"
