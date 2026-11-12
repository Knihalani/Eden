#!/bin/bash
# F2 (docs/research/f2-push-recall.md §4): one pi-ab process for the pair `eden` against `eden~R` (`pushCheckRecall`
# FORM). H3's recipe (../h3/pi.sh): Haiku 5.5 as agent, grader, card, reader and check models; cards replayed; house
# rules cached in every arm; payload notices; the market `direct` profile. One ledger. A finished run is never run
# again.   LABEL FORM then pi-ab flags (--suite, --seeds, --variants).
set -euo pipefail
cd "$(dirname "$0")/../../../.."
L=$1; K=$2; shift 2
R=.local/f2/pi/$L; mkdir -p $R
if [ -e "$R/out.json" ]; then echo "pi.sh: $L is finished; not run again" >&2; exit 0; fi
echo "$(date -u +%FT%TZ) $L $(git rev-parse HEAD) recall=$K $*" >> .local/f2/pi-starts.log
H=claude-haiku-5-5
exec env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --config default --tenant-prompt \
  --variant-config "{\"R\":{\"pushCheckRecall\":$K}}" --conditions eden,eden~R \
  --model $H --grader $H --card-model $H --reader-model $H \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload \
  --spend-ledger .local/f2/ledger.jsonl --spend-cap 60 --spend-headroom 0.3 --run-label $L \
  --budget ${F2_BUDGET:-1.2} --timeline $R/out.tl --out $R/out.json "$@"
