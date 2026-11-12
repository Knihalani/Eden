#!/bin/bash
# F5 (docs/research/f5-rule-sheet.md §1b): one pi-ab process for the pair `eden` against `eden~F` (the screened rule
# sheet arm, its settings as JSON in $2). H3's recipe (packages/sim/lab/h3/pi.sh): Haiku 5.5 as agent, grader, card,
# reader and check model; cards replayed; house rules cached in every arm; payload notices; the market `direct`
# profile. One ledger, a hard cap across the session. A finished run is never run again.   LABEL SETTINGS pi-ab flags.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
L=$1; SETTINGS=$2; shift 2
R=.local/f5/pi/$L; mkdir -p $R
if [ -e "$R/out.json" ]; then echo "pi.sh: $L is finished; not run again" >&2; exit 0; fi
echo "$(date -u +%FT%TZ) $L $(git rev-parse HEAD) $SETTINGS $*" >> .local/f5/pi-starts.log
H=claude-haiku-5-5
exec env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --config default --tenant-prompt \
  --variant-config "{\"F\":$SETTINGS}" --conditions eden,eden~F \
  --model $H --grader $H --card-model $H --reader-model $H \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload \
  --spend-ledger .local/f5/ledger.jsonl --spend-cap 40 --spend-headroom 0.3 --run-label $L \
  --budget ${F5_BUDGET:-1.6} --timeline $R/out.tl --out $R/out.json "$@"
