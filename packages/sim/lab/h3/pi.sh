#!/bin/bash
# H3 (docs/research/h3-pushcheck-lean.md §1b): one pi-ab process for the pair `eden` against `eden~D` (the screened
# `pushCheckDedupe` arm). M13's recipe (packages/sim/lab/m13/pi.sh): Haiku 5.5 as agent, grader, card, reader and
# check model; cards replayed; house rules cached in every arm; payload notices; the market `direct` profile. One
# ledger, hard cap $15 across the session. A finished run is never run again.   LABEL DEDUPE then pi-ab flags.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
L=$1; K=$2; shift 2
R=.local/h3/pi/$L; mkdir -p $R
if [ -e "$R/out.json" ]; then echo "pi.sh: $L is finished; not run again" >&2; exit 0; fi
echo "$(date -u +%FT%TZ) $L $(git rev-parse HEAD) dedupe=$K $*" >> .local/h3/pi-starts.log
H=claude-haiku-5-5
exec env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --config default --tenant-prompt \
  --variant-config "{\"D\":{\"pushCheckDedupe\":$K}}" --conditions eden,eden~D \
  --model $H --grader $H --card-model $H --reader-model $H \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload \
  --spend-ledger .local/h3/ledger.jsonl --spend-cap 15 --spend-headroom 0.3 --run-label $L \
  --budget 1.2 --timeline $R/out.tl --out $R/out.json "$@"
