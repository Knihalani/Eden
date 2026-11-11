#!/bin/bash
# M8 (docs/research/m8-router.md): route logs of one synth split, one days-calls process a seed (zero router: the
# engine's inputs logged, nothing skipped). A seed whose worlds do not fit the base world's noise is dropped.
#   packages/sim/lab/m8/gen.sh SUITE FROM TO OUTDIR      e.g. synth-train@10 1 150 .local/m8/logs3/train
unset OPENROUTER_API_KEY
C="--days 10 --night-h 20 --day-size 12-16 --mix 1:1:3 --arrive-days 0-6 --noise-sources 995 --noise-vocab 1000"
C="$C --notify-share 0.05"
mkdir -p "$4"
for s in $(seq "$2" "$3"); do
  [ -s "$4/$s.jsonl" ] && continue
  bun packages/sim/src/lab/days-calls.ts --seeds "$s" --suite "$1" $C --route-log "$4/$s.jsonl" >"$4/$s.txt" 2>&1 ||
    rm -f "$4/$s.jsonl"
done
