#!/bin/bash
# M13 (docs/research/m13-gate.md §0, bar 5): one pi-ab process for the pair `eden` against `eden~G` (`pushGate` on).
# P3's recipe (packages/sim/lab/p3/run.sh): Haiku 5.5 as agent, grader, card and reader model; cards replayed from the
# shipped coverage (D878); house rules cached in every arm (--tenant-prompt); payload notices; the market `direct`
# profile. One ledger, hard cap $8. A finished run is never run again.   LABEL then pi-ab flags.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
L=$1; shift
R=.local/m13/pi; mkdir -p $R
if [ -e "$R/$L.json" ]; then echo "pi.sh: $L is finished; not run again" >&2; exit 0; fi
echo "$(date -u +%FT%TZ) $L $(git rev-parse HEAD) $*" >> .local/m13/pi-starts.log
H=claude-haiku-5-5
exec env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --config default --tenant-prompt \
  --variant-config '{"G":{"pushGate":true}}' --conditions eden,eden~G \
  --model $H --grader $H --card-model $H --reader-model $H \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload \
  --spend-ledger .local/m13/pi-ledger.jsonl --spend-cap 8 --spend-headroom 0.1 --run-label $L \
  --timeline $R/$L.tl --out $R/$L.json "$@"
