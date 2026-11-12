#!/usr/bin/env bash
# heldout20's shipped coverage (D1080, as D872 made heldout19's): the cards and intent requests the shipped enricher
# (`buildPartner`, DEFAULT_CONFIG, the card role on Haiku 5.5 through the lab transport, D97) writes for every world
# of heldout20 seeds 41-44 (hidden, control, neutral) and each seed's `--days 2 --day-size 20` user. About $0.2.
# It reads no template and runs no funnel, eval or agent. Not yet run: F4's attempt stopped on the Anthropic
# account's credit (every call 400, $0). Run it once credit is back, from the repo root, on the tree whose default
# the final read measures (a later card form, e.g. a `:f<n>` key, needs its own recording, as B19 did):
#
#   bash packages/sim/lab/f4/record-coverage.sh [OUT_DIR]       # default .local/f4
#
# Then either append OUT_DIR/h20-cov.jsonl to the replay the final run names (`--coverage full --cards F --intent F`,
# B19's go.sh), or add its lines to cards-shipped.jsonl.gz and heldout20 to SHIPPED_FORM_COVERS in cards-disk.ts.
set -euo pipefail
OUT=${1:-.local/f4}
mkdir -p "$OUT"
USERS=$(for s in 41 42 43 44; do printf 'heldout20:%s,heldout20:%s:control,heldout20:%s:neutral,user:%s,' \
  "$s" "$s" "$s" "$s"; done)
[ -e "$OUT/h20-cov.jsonl" ] && { echo "$OUT/h20-cov.jsonl exists: not re-recording" >&2; exit 1; }
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cold-start.ts --users "${USERS%,}" --suite heldout20 --days 2 \
  --day-size 20 --cards-out "$OUT/h20-cov.part.jsonl" --spend-ledger "$OUT/ledger.jsonl" --spend-cap 3 \
  --spend-headroom 0.2 --run-label f4-h20-coverage --out "$OUT/h20-cov.json"
# A world whose card calls all failed (a 400 from the API, an exhausted credit) still exits 0: refuse it here.
if grep -Eq '"cardCalls": 0,' "$OUT/h20-cov.json"; then
  echo "a world made no card call: see $OUT/h20-cov.json" >&2
  exit 1
fi
mv "$OUT/h20-cov.part.jsonl" "$OUT/h20-cov.jsonl"
wc -l "$OUT/h20-cov.jsonl"
