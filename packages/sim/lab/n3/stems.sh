#!/bin/bash
# N3: a Modal fan-out's shards (.local/modal/RUN/<shard>/out.json, out.timeline/) as the STEM.json and STEM.tl pairs
# the lab's Python reports read (a9/late.py, a17/days.py, a30/gap.py, a8/pair.py): prints the stems, one per shard.
# usage: stems.sh RUN [OUTDIR]
RUN=$1; OUT=${2:-.local/n3/runs}; mkdir -p "$OUT"
for d in .local/modal/$RUN/s*/; do
  [ -f "$d/out.json" ] || continue
  s="$OUT/$RUN-$(basename "$d" | sed 's/^s[0-9]*-//')"
  ln -sfn "$(realpath "$d/out.json")" "$s.json"; ln -sfn "$(realpath "$d/out.timeline")" "$s.tl"
  echo "$s"
done
