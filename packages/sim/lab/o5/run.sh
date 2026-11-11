#!/bin/bash
# O5 (docs/research/o4-new-user.md §6a): the paid check of `syncKick` on new users. SEED LABEL LIMIT SUITE then pi-ab
# flags. One process a suite and seed (`all.sh` loops them): a process writes its results only at its end, and two
# whole-seed runs were lost to a container restart.
# Pi on train1-6, each user new (`--connect-at 10,45`), arms eden and eden~K. Haiku 5.5 in every role on the
# Anthropic API (lab transport, D97), cards replayed at 2.7 s a call, house rules cached in every arm, payload
# notices, the market `direct` profile. One ledger, hard cap $15 (the session's Anthropic cap).
SEED=$1; L=$2; LIMIT=$3; SUITE=$4; shift 4
mkdir -p .local/o5/runs
[ -f .local/o5/cards-all.jsonl ] || cat packages/sim/lab/cards/cards-v2.jsonl packages/sim/lab/cards/cards-train.jsonl \
  packages/sim/lab/cards/cards-train-4344.jsonl > .local/o5/cards-all.jsonl
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite $SUITE --seeds $SEED --limit $LIMIT \
  --variants hidden,control,neutral --conditions eden,eden~K --variant-config '{"K":{"syncKick":true}}' \
  --config default --connect-at 10,45 --tenant-prompt \
  --cards .local/o5/cards-all.jsonl --cards-out .local/o5/runs/$L.cards.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload \
  --spend-ledger .local/o5/ledger.jsonl --spend-cap 15 --spend-headroom 0.1 --run-label $L \
  --timeline .local/o5/runs/$L.tl --out .local/o5/runs/$L.json "$@"
