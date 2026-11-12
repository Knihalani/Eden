#!/usr/bin/env bash
# F3 (D1124): the pre-registered Pi run for `packetChanges` (primary) and `packetWhy` v2 (secondary) on dev20's
# silent-edit templates. Lab-provider (D97): Anthropic direct, no OpenRouter. Three arms in one process a seed, paired:
# both+ask (the default), both~CH+ask (packetChanges), both~CW+ask (packetChanges and packetWhy).
# dev20 has no shipped coverage yet (f8-dev20.md): the shipped file is replayed for the base worlds' items and the rest
# (planted items and their earlier versions) is carded live in-run.
set -uo pipefail
cd "$(dirname "$0")/../../../.."
unset OPENROUTER_API_KEY
D=${F3_DIR:-.local/f3}; R=$D/runs2; mkdir -p $R
[ -e $D/shipped.jsonl ] || gunzip -c packages/sim/lab/distilled/cards-shipped.jsonl.gz >$D/shipped.jsonl
T=$(bun -e 'import {DEV20A_SILENT as a} from "./packages/sim/src/lab/hidden-dev20a"; import {DEV20B_SILENT as b} from "./packages/sim/src/lab/hidden-dev20b"; import {DEV20C_SILENT as c} from "./packages/sim/src/lab/hidden-dev20c"; import {DEV20D_SILENT as d} from "./packages/sim/src/lab/hidden-dev20d"; console.log([...a,...b,...c,...d].join(","))')
COMMON=(--config default --model claude-haiku-5-5 --grader claude-sonnet-5-5 --card-model claude-haiku-5-5
  --reader-model claude-haiku-5-5 --time-scale 1 --spend-ledger $D/ledger2.jsonl --spend-cap 30 --spend-headroom 0.2
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload --tenant-prompt
  --coverage full --cards $D/shipped.jsonl --intent $D/shipped.jsonl
  --conditions both+ask,both~CH+ask,both~CW+ask
  --variant-config '{"CH":{"packetChanges":true},"CW":{"packetChanges":true,"packetWhy":true}}'
  --variants hidden,control,neutral --templates "$T" --suite dev20a,dev20b,dev20c,dev20d --noise-edits 16)
P=()
for s in 41 42 43 44; do
  n=dev20-$s
  [ -e $R/$n.json ] || bun packages/sim/src/lab/pi-ab.ts "${COMMON[@]}" --seeds $s --budget ${BUDGET:-4} \
    --run-label f3b-$n --cards-out $R/$n.cards.jsonl --timeline $R/$n.tl --out $R/$n.json "$@" >$R/$n.log 2>&1 &
  P+=($!)
done
for p in "${P[@]}"; do wait $p; done
echo "done $(date -u +%T)"
