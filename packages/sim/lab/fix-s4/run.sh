#!/bin/bash
# The variants name the deleted D213/D214 switches: run it on commit a0ed239f (claude/fix-s4-connectors) to reproduce.
SEED=$1
cd "$(git rev-parse --show-toplevel)"
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --coverage full --suite heldout14 --seeds $SEED \
  --variants hidden,control,neutral --conditions eden,eden~gmail30,eden~coalesce --config default \
  --variant-config '{"gmail30":{"syncMaxAgeBySource":["gmail:30"]},"coalesce":{"syncCoalesceMs":30000}}' \
  --cards packages/sim/lab/cards/cards-v2.jsonl --cards-out .local/s4/pi/s4-$SEED.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push signals --budget 0.45 \
  --spend-ledger .local/ledger.jsonl --spend-cap 1 --spend-headroom 0.3 --run-label s4-pi-$SEED --out .local/s4/pi/s4-$SEED.json
