#!/bin/bash
cd "$(git rev-parse --show-toplevel)"
H="--card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 --model claude-haiku-5-5 --grader claude-haiku-5-5"
P="--source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload"
for S in 41 42; do
  env -u OPENROUTER_API_KEY bun packages/sim/src/lab/hermes-ab.ts --coverage full --hermes-src $HERMES --concurrency 3 \
    --suite train1,train2,train3,train4,train5,train6 --limit 6 --variants hidden,control,neutral --time-scale 1 \
    --config default --conditions hermes,hermes+eden --budget 1 --seeds $S --cards packages/sim/lab/cards/cards-v2.jsonl $H $P \
    --spend-ledger .local/hx/ledger.jsonl --spend-cap 1.2 --run-label ax-hermes-$S --out .local/hx/h-$S.json > .local/hx/h-$S.log 2>&1
  echo "seed $S exit $?" >> .local/hx/done.txt
done
