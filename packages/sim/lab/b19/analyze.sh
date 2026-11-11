#!/usr/bin/env bash
# B19: the final run's three reports (Hermes short, Pi short, Pi days) from go.sh's results, one JSON each beside the
# text. PREFIX as go.sh (default h19), SEEDS (comma list, default 41,42,43,44).
#
#   [PREFIX=h19] [SEEDS=41,42,43,44] bash packages/sim/lab/b19/analyze.sh
set -euo pipefail
cd "$(dirname "$0")/../../../.."
P=${PREFIX:-h19}
IFS=, read -r -a SEEDS <<<"${SEEDS:-41,42,43,44}"
R=.local/b19/runs
OUT=.local/b19/report
mkdir -p $OUT
stems() { local IFS=,; local a=("${@/#/$R/}"); echo "${a[*]}"; }
report() {
  local name=$1 raw=$2 before=$3 final=$4
  python3 -I packages/sim/lab/b19/report.py --ledger .local/b19/ledger.jsonl --arm raw="$raw" --arm before="$before" \
    --arm final="$final" --json $OUT/$P-$name.json | tee $OUT/$P-$name.txt
}
report hermes-short $R/$P-h-raw $R/$P-h-before $R/$P-h-final
for k in ps pd; do
  arms=()
  for a in raw before final; do arms+=("$(stems "${SEEDS[@]/#/$P-$k-$a-}")"); done
  report "pi-$([ $k = ps ] && echo short || echo days)" "${arms[@]}"
done
