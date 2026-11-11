#!/bin/bash
# A8 connector calls on Pi (docs/research/a8-connector-calls.md): LABEL PUSH CONDITIONS then pi-ab flags. A6's run.sh
# with A8's ledger (cap $1.5); add `--recap-notice signal` for the recap as every run sent it before A8.
L=$1; PUSH=$2; CONDS=$3; shift 3
mkdir -p .local/a8/runs
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --coverage full --suite train --conditions $CONDS --config default \
  --cards .local/a8/cards-all.jsonl --cards-out .local/a8/runs/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push $PUSH \
  --spend-ledger .local/a8/ledger.jsonl --spend-cap 1.5 --spend-headroom 0.1 --run-label $L \
  --timeline .local/a8/runs/$L.tl --out .local/a8/runs/$L.json "$@"
