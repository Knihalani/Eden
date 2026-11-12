#!/usr/bin/env bash
# The final benchmark's report: quality (report.py) and cost and wait [EST] (F7's price-queue.py), from a go.sh run.
#   bash packages/sim/lab/final/report.sh RUN_DIR SUITE
set -euo pipefail
cd "$(dirname "$0")/../../../.."
RUN=${1:?run dir}
SUITE=${2:?suite}
P=$(basename "$RUN")
FILES=$(env -u OPENROUTER_API_KEY bun -e \
  'import { parseSuites } from "./packages/sim/src/lab/suites.ts"; console.log(parseSuites(process.argv[1]).join(" "))' \
  "$SUITE" | tr ' ' '\n' | sed 's#^#packages/sim/src/lab/hidden-#; s#$#.ts#' | while read -r f; do [ -e "$f" ] && echo "$f"; done)
# shellcheck disable=SC2086
python3 -I packages/sim/lab/final/report.py "$RUN" --labels $FILES
echo
echo "== cost and wait [EST] (F7 price-queue.py: tokens from sizes, Haiku list prices; per arm and role)"
count() { python3 -I -c "import json,sys;print(len(json.load(open(sys.argv[1]))['results']))" "$1"; }
ARGS=()
for a in raw before final; do
  [ -e "$RUN/$a.json" ] && ARGS+=(--arm "$a=$P-$a:$(count "$RUN/$a.json")")
done
# The call log less the processes an arm restarted from (cost.py's `calls`), beside the same done/ answers.
DQ=$(mktemp -d)
ln -s "$(realpath "$RUN/q/done")" "$DQ/done"
python3 -I packages/sim/lab/final/cost.py --dedupe-calls "$RUN/q" >"$DQ/calls.jsonl"
python3 -I packages/sim/lab/f7/price-queue.py "$DQ" "${ARGS[@]}"
rm -rf "$DQ"
