#!/bin/bash
# usage: run.sh PHASE SUITE SEED VARIANTS CONDITIONS [VARIANT_CONFIG]
cd "$(dirname "$0")/../../../.."   # the repo root; jobs.txt lines: PHASE SUITE SEED VARIANTS CONDITIONS
P=$1; S=$2; N=$3; V=$4; C=$5; VC=${6:-'{}'}
mkdir -p .local/w2b/$P
L=w2b-$P-$S-$N
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --coverage full --suite $S --seeds $N --variants $V \
  --conditions $C --config default --variant-config "$VC" \
  --cards .local/w2b/enrich/cards-merged.jsonl --cards-out .local/w2b/$P/$L.cards.jsonl \
  --intent .local/w2b/enrich/intent-v2.jsonl \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push signals --budget 1 \
  --spend-ledger .local/ledger.jsonl --spend-cap 4 --spend-headroom 0.3 --run-label $L \
  --timeline .local/w2b/$P/$L.timeline --out .local/w2b/$P/$L.json > .local/w2b/$P/$L.log 2>&1
echo "$L exit $?"
