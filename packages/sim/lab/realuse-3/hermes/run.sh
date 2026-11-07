#!/bin/bash
cd "$(git rev-parse --show-toplevel)"
H="--card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 --model claude-haiku-5-5 --grader claude-haiku-5-5"
P="--source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload"
for S in 41 42; do
  env -u OPENROUTER_API_KEY bun packages/sim/src/lab/hermes-ab.ts --hermes-src "$HERMES" \
    --concurrency 3 --suite heldout16 --variants hidden,control,neutral --time-scale 1 --config default \
    --conditions hermes,hermes+eden,hermes+eden~reader --variant-config '{"reader":{"pushCandidates":0}}' \
    --budget 2 --seeds $S --cards packages/sim/lab/cards/cards-v2.jsonl $H $P \
    --spend-ledger .local/r3/ledger.jsonl --spend-cap 2.2 --run-label r3-hermes-$S --out .local/r3/h16-$S.json \
    > .local/r3/h16-$S.log 2>&1
  echo "seed $S exit $?" >> .local/r3/done.txt
done
