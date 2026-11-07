#!/bin/bash
# CL3's Pi runs (docs/research/cl-cl3.md): pi-ab on the direct market profile, Haiku 5.5 in every role, Anthropic
# direct (lab transport, D97), one shared spend ledger. PUSH=payload for item-carrying notices (default signals).
# usage: run.sh LABEL SUITES SEED CONDITIONS VARIANTCFG CARDS [extra pi-ab args, e.g. --day 4]
L=$1; S=$2; SEED=$3; C=$4; V=$5; CARDS=$6; shift 6
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite "$S" --seeds "$SEED" \
  --variants hidden,control --conditions "$C" --config default --variant-config "$V" \
  --cards "$CARDS" --cards-out ".local/cl3/pi/$L.cards.jsonl" \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push "${PUSH:-signals}" --budget 0.6 \
  --spend-ledger .local/cl3/ledger.jsonl --spend-cap 2 --spend-headroom 0.3 --run-label "$L" \
  --out ".local/cl3/pi/$L.json" "$@" > ".local/cl3/pi/$L.log" 2>&1
