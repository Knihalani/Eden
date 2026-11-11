#!/bin/bash
# A29 (docs/research/a29-heldout17.md): the end-of-day blind check on heldout17. LABEL PUSH CONDITIONS then pi-ab
# flags. RealUse-3's run.sh on heldout17 with the tenant's house rules (`--tenant-prompt`, D271), A29's ledger (hard cap
# $6) and the `nonudge` variant (the default minus askNudge, D316). Cards: the three checked-in card files concatenated.
L=$1; PUSH=$2; CONDS=$3; shift 3
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --coverage full --suite heldout17 --conditions $CONDS --config default \
  --variant-config '{"nonudge":{"askNudge":false}}' --tenant-prompt \
  --cards .local/a29/cards-all.jsonl --cards-out .local/a29/runs/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push $PUSH \
  --spend-ledger .local/a29/ledger.jsonl --spend-cap 6 --spend-headroom 0.1 --run-label $L \
  --timeline .local/a29/runs/$L.tl --out .local/a29/runs/$L.json "$@"
