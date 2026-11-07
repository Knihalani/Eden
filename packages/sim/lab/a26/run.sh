#!/bin/bash
# A26 (docs/research/a26-reshow.md): LABEL PUSH then pi-ab flags. A17's run.sh with its own ledger and a $1.20 hard
# cap; arms eden vs eden+pushReshow (D340's decider). Cards from the three checked-in card files concatenated.
L=$1; PUSH=$2; shift 2
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite train --conditions eden,eden+pushReshow \
  --config default --tenant-prompt \
  --cards ${CARDS:-.local/a26/cards-all.jsonl} --cards-out .local/a26/runs/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push $PUSH \
  --spend-ledger .local/a26/ledger.jsonl --spend-cap 1.2 --spend-headroom 0.1 --run-label $L \
  --timeline .local/a26/runs/$L.tl --out .local/a26/runs/$L.json "$@"
