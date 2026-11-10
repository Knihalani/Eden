#!/bin/bash
# pair.sh RUN [RUN...]: the paired connector-call and hidden effects of eden~yield and eden~lazy against eden over the
# shards of lab_fanout runs (.local/modal/RUN/<shard>/out.json), by a8/pair.py (task-level bootstrap, 1:1:8 mix).
cd "$(dirname "$0")/../../../.." || exit 1
stems=()
for run in "$@"; do
  for shard in .local/modal/"$run"/s*/; do
    stem=.local/modal/$run/$(basename "$shard")-stem
    ln -sfn "$(basename "$shard")/out.json" "$stem.json"
    ln -sfn "$(basename "$shard")/out.timeline" "$stem.tl"
    stems+=("$stem")
  done
done
arm() { local IFS=,; local out=(); for s in "${stems[@]}"; do out+=("$s:$1"); done; echo "${out[*]}"; }
python3 -I packages/sim/lab/a8/pair.py base="$(arm eden)" yield="$(arm 'eden~yield')" lazy="$(arm 'eden~lazy')" \
  --pair base,yield --pair base,lazy
