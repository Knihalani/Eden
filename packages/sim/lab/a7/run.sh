#!/bin/bash
# A7 on Pi (docs/research/a7-adoption.md): LABEL then pi-ab flags. D276's owed live check: the default with no
# model key (`eden+nokey`, D291: no card enricher, no intent requests, no reader) beside the keyed default and tools.
L=$1; shift
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite train --conditions tools,eden,eden+nokey \
  --config default --variants hidden,control,neutral --limit 12 \
  --cards .local/a7/cards-all.jsonl --cards-out .local/a7/runs/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload \
  --spend-ledger .local/a7/ledger.jsonl --spend-cap 1.5 --spend-headroom 0.1 --run-label $L \
  --timeline .local/a7/runs/$L.tl --out .local/a7/runs/$L.json "$@"
