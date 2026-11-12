#!/bin/bash
# F7 (docs/research/f7-cost-latency.md §2): one pi-ab process, the shipped integrator shape `both+ask` against it with
# each F7 switch on. H3's recipe (packages/sim/lab/h3/pi.sh): Haiku 5.5 as agent, grader, card, reader and check
# model; shipped card coverage replayed; house rules cached in every arm; payload notices; the market `direct`
# profile; time scale 1. One ledger, hard cap $40 for the session. A finished run is never run again.
#   LABEL then pi-ab flags (--suite, --seeds, --variants).
set -euo pipefail
cd "$(dirname "$0")/../../../.."
L=$1; shift
R=.local/f7/pi/$L; mkdir -p $R
if [ -e "$R/out.json" ]; then echo "pi.sh: $L is finished; not run again" >&2; exit 0; fi
echo "$(date -u +%FT%TZ) $L $(git rev-parse HEAD) ${F7_CONDITIONS:-} $*" >> .local/f7/pi-starts.log
H=claude-haiku-5-5
exec env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --config default --tenant-prompt \
  --conditions "${F7_CONDITIONS:-both+ask,both+ask+pushCheckLeanStop,both+ask+pushCheckLeanLead}" \
  --model $H --grader $H --card-model $H --reader-model $H \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload \
  --spend-ledger .local/f7/ledger.jsonl --spend-cap 40 --spend-headroom 0.3 --run-label $L \
  --budget ${F7_BUDGET:-2} --timeline $R/out.tl --out $R/out.json "$@"
