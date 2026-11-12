#!/usr/bin/env bash
# F6 (docs/research/f6-uptake.md): uptake levers on Pi, four arms paired in one process a seed. Lab-provider (D97):
# every call to Anthropic through the lab transport, never OpenRouter.
#   bash packages/sim/lab/f6/run.sh LABEL SUITE SEEDS VARIANTS [extra pi-ab flags…]
set -uo pipefail
cd "$(dirname "$0")/../../../.."
unset OPENROUTER_API_KEY
L=${1:?label}; SUITE=${2:?suite}; SEEDS=${3:?seeds}; VARIANTS=${4:?variants}; shift 4
D=.local/f6; R=$D/runs; mkdir -p "$R"
ARMS=${ARMS:-both+ask,both~C+ask,both+ask+guide,both~C+ask+guide}
P=()
for s in ${SEEDS//,/ }; do
  n=$L-$s
  [ -e "$R/$n.json" ] && continue
  env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --conditions "$ARMS" \
    --variant-config '{"C":{"checkedLead":true}}' --config default --model claude-haiku-5-5 \
    --grader claude-sonnet-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 --time-scale 1 \
    --spend-ledger $D/ledger.jsonl --spend-cap "${CAP:-45}" --spend-headroom 0.2 \
    --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload --tenant-prompt \
    --suite "$SUITE" --seeds "$s" --variants "$VARIANTS" --budget "${BUDGET:-6}" --run-label "f6-$n" \
    --cards-out "$R/$n.cards.jsonl" --timeline "$R/$n.tl" --out "$R/$n.json" "$@" >"$R/$n.log" 2>&1 &
  P+=($!)
done
for p in "${P[@]}"; do wait "$p"; done
echo "$L done $(date -u +%T)"
