#!/bin/bash
# N4 (docs/research/n4-agents.md) part A: a stronger model as the Pi AGENT. AGENT LABEL CONDITIONS then pi-ab flags.
# A29's run.sh on train with the agent model named: Haiku 5.5 stays Eden's card and reader model and the grader, cards
# replayed from the three checked-in files, house rules cached in every arm (--tenant-prompt, D271), payload notices,
# the market `direct` profile. One ledger, hard cap $20 (the session's Anthropic cap).
AGENT=$1; L=$2; CONDS=$3; shift 3
mkdir -p .local/n4/runs
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --coverage full --suite train --conditions $CONDS --config default \
  --tenant-prompt --cards .local/n4/cards-all.jsonl --cards-out .local/n4/runs/$L.cards.jsonl \
  --model $AGENT --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload \
  --spend-ledger .local/n4/ledger.jsonl --spend-cap 20 --spend-headroom 0.1 --run-label $L \
  --timeline .local/n4/runs/$L.tl --out .local/n4/runs/$L.json "$@"
