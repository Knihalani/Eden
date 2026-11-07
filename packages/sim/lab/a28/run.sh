#!/bin/bash
# A28 live Pi check of the cut-copy budget (D390, docs/research/a28-scale.md): LABEL CONDITIONS then pi-ab flags.
# A8's run.sh with A28's own ledger (cap $1.5); `--noise-sources 995` gives Eden's arm 995 noise connectors.
# One Eden arm per process (two passed 12.8 GB); SUITE=train1,train2,train3 halves the worlds (seed 42 whole OOM'd).
L=$1; CONDS=$2; shift 2
# The eden~cut arm needs the D390 code: git checkout def8c153 (deleted after the measurement).
mkdir -p .local/a28/runs
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite ${SUITE:-train} --conditions $CONDS \
  --config default \
  --cards .local/a28/cards-all.jsonl --cards-out .local/a28/runs/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload \
  --spend-ledger .local/a28/ledger.jsonl --spend-cap 1.5 --spend-headroom 0.1 --run-label $L \
  --timeline .local/a28/runs/$L.tl --out .local/a28/runs/$L.json "$@"
