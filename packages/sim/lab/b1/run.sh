#!/bin/bash
# B1 live Pi check of `pushCutBehind` (D405, docs/research/b1-scale-path.md): LABEL CONDITIONS then pi-ab flags.
# A28's run.sh with B1's own ledger (cap $1.5); `--noise-sources 995` gives Eden's arm 995 noise connectors.
# One Eden arm per process: pi-ab runs every world of a seed at once, each with its own 995 simulated connectors.
L=$1; CONDS=$2; shift 2
mkdir -p .local/b1/runs
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --coverage full --suite ${SUITE:-train} --conditions $CONDS \
  --config default \
  --cards .local/b1/cards-all.jsonl --cards-out .local/b1/runs/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload \
  --spend-ledger .local/b1/ledger.jsonl --spend-cap 1.5 --spend-headroom 0.1 --run-label $L \
  --timeline .local/b1/runs/$L.tl --out .local/b1/runs/$L.json "$@"
