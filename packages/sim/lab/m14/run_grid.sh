#!/usr/bin/env bash
# The M14 recipe grid (D1023): each recipe a LOGO run over the four sources, four runs side by side, one thread each.
# Usage: run_grid.sh OUTDIR "recipe1 recipe2 ..." [extra logo.py args]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
L=${LOGO_DIR:-.local/m14/logo}
PY=${PY:-.local/m14/venv/bin/python}
out=$1; recipes=$2; shift 2
mkdir -p "$out"
src=(--source "m2=$L/m2-train.jsonl:$L/m2-test.jsonl" --source "sim=$L/sim.jsonl" --source "g2=$L/g2.jsonl"
     --source "g3=$L/g3.jsonl")
for r in $recipes; do
  name=${r//,/+}; [ "$r" = "-" ] && r="" && name=plain
  echo "$name"
done | xargs -P "${JOBS:-4}" -I{} bash -c '
  name={}; r=${name//+/,}; [ "$name" = plain ] && r=""
  LOGO_THREADS=1 '"$PY"' -I '"$here"'/logo.py run --model hashnet --recipe "$r" '"${src[*]@Q}"' \
    --seeds 1,2 --epochs 3 --cap 2000 --max-test 600 '"$*"' --out '"$out"'/$name.json > '"$out"'/$name.log 2>&1
  echo "done $name"'
