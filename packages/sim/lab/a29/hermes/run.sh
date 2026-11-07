#!/bin/bash
# Hermes on the blind heldout17 (A29's end-of-day confirmation, Hermes half): three arms, seeds 41-42 in parallel.
cd /home/user/hwt3
H="--card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 --model claude-haiku-5-5 --grader claude-haiku-5-5"
P="--source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload"
for S in 41 42; do
  env -u OPENROUTER_API_KEY bun packages/sim/src/lab/hermes-ab.ts --hermes-src /home/user/hermes-agent --concurrency 3 \
    --suite heldout17 --variants hidden,control,neutral --time-scale 1 \
    --config default --conditions hermes,hermes-eden,hermes+eden --budget 1 --seeds $S --cards packages/sim/lab/cards/cards-v2.jsonl $H $P \
    --spend-ledger .local/h17/ledger.jsonl --spend-cap 2.2 --run-label h17-hermes-$S --out .local/h17/h-$S.json > .local/h17/h-$S.log 2>&1 &
done
wait
echo done > .local/h17/done.txt
