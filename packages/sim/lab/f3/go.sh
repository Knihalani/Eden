#!/usr/bin/env bash
# F3 (D1120): the pre-registered Pi pair for `packetWhy`. Lab-provider (D97): Anthropic direct, no OpenRouter.
# Arms in one process, paired task by task: both+ask (the default) and both~WHY+ask (the default with packetWhy).
# Train and the reworded train, seeds 41-44, the 36 templates where the $0 funnel notes some item (sets.json).
set -uo pipefail
cd "$(dirname "$0")/../../../.."
unset OPENROUTER_API_KEY
D=.local/f3; R=$D/runs; mkdir -p $R
T=$(python3 -I -c "import json;print(','.join(json.load(open('packages/sim/lab/f3/sets.json'))['templates']))")
COMMON=(--config default --model claude-haiku-5-5 --grader claude-sonnet-5-5 --card-model claude-haiku-5-5
  --reader-model claude-haiku-5-5 --time-scale 1 --spend-ledger $D/ledger.jsonl --spend-cap 30 --spend-headroom 0.2
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload --tenant-prompt
  --conditions both+ask,both~WHY+ask --variant-config '{"WHY":{"packetWhy":true}}'
  --variants hidden,control,neutral --templates "$T")
REP=${REP:-1}
P=()
for g in train reworded; do
  [ $g = train ] && S=train1,train2,train3,train4,train5,train6 || S=train1r,train2r,train3r,train4r,train5r,train6r
  for s in 41 42 43 44; do
    n=$g-$s-r$REP
    [ -e $R/$n.json ] || bun packages/sim/src/lab/pi-ab.ts "${COMMON[@]}" --suite $S --seeds $s --budget 3 \
      --run-label f3-$n --cards-out $R/$n.cards.jsonl --timeline $R/$n.tl --out $R/$n.json >$R/$n.log 2>&1 &
    P+=($!)
  done
  # Four processes at once (one a seed): RSS reached 3.35 GB a process in the Haiku campaign.
  for p in "${P[@]}"; do wait $p; done
  P=()
done
echo "done $(date -u +%T)"
