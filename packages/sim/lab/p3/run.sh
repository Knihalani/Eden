#!/bin/bash
# P3 (docs/research/p3-baselines.md): one pi-ab process. AGENT LABEL then pi-ab flags. N4's run.sh (packages/sim/lab/n4)
# with P3's ledger: Haiku 5.5 is Eden's card and reader model and the grader whatever the agent, cards replayed from the
# three checked-in files (seeds 41-44; later users' cards are made in-run), house rules cached in every arm
# (--tenant-prompt, D271), payload notices, the market `direct` profile. One ledger for the session, hard cap $30.
# A finished run is never run again (its results file exists); every start is logged in .local/p3/starts.log.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
AGENT=$1; L=$2; shift 2
R=.local/p3/runs; mkdir -p $R
if [ -e "$R/$L.json" ]; then echo "run.sh: $L is finished; not run again" >&2; exit 0; fi
[ -e .local/p3/cards-all.jsonl ] || cat packages/sim/lab/cards/cards-v2.jsonl packages/sim/lab/cards/cards-train.jsonl \
  packages/sim/lab/cards/cards-train-4344.jsonl > .local/p3/cards-all.jsonl
echo "$(date -u +%FT%TZ) $L $AGENT $(git rev-parse HEAD) $*" >> .local/p3/starts.log
exec env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite train --config default --tenant-prompt \
  --cards .local/p3/cards-all.jsonl --cards-out $R/$L.cards.jsonl \
  --model $AGENT --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload \
  --spend-ledger .local/p3/ledger.jsonl --spend-cap 30 --spend-headroom 0.1 --run-label $L \
  --timeline $R/$L.tl --out $R/$L.json "$@"
