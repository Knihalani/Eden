#!/bin/bash
# N4 (docs/research/n4-agents.md) part B: a new user's first card calls, one lane against two and four (`cardsLanes`,
# D521). LABEL then pi-ab flags. Haiku 5.5 in every role, no --cards file (every card and request is made in-run),
# --cards-calls 4: the arm with K lanes gets 4 × K calls, the moment one lane has made four.
L=$1; shift
mkdir -p .local/n4/runs
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite train --conditions 'eden,eden~l2,eden~l4' \
  --config default --variant-config '{"l2":{"cardsLanes":2},"l4":{"cardsLanes":4}}' --tenant-prompt --cards-calls 4 \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload \
  --spend-ledger .local/n4/ledger.jsonl --spend-cap 20 --spend-headroom 0.1 --run-label $L \
  --timeline .local/n4/runs/$L.tl --out .local/n4/runs/$L.json "$@"
