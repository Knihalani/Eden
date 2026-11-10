#!/bin/bash
# C4 live Pi check of `askBehind` (D430, docs/research/c4-ask-path.md): LABEL CONDITIONS then pi-ab flags.
# B1 run.sh with C4 own ledger (cap $2), `--tenant-prompt`; `--noise-sources 995` gives Eden's arm 995 noise connectors.
# One Eden arm per process: pi-ab runs every world of a seed at once, each with its own 995 simulated connectors.
L=$1; CONDS=$2; shift 2
mkdir -p .local/c4/runs
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite ${SUITE:-train} --conditions $CONDS \
  --config default \
  --cards .local/c4/cards-all.jsonl --cards-out .local/c4/runs/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload \
  --spend-ledger .local/c4/ledger.jsonl --spend-cap 2 --spend-headroom 0.1 --run-label $L --tenant-prompt \
  --timeline .local/c4/runs/$L.tl --out .local/c4/runs/$L.json "$@"
