#!/bin/bash
# O5: every train suite of one seed through run.sh, one process each, skipping those whose results exist. SEED.
SEED=$1
for S in train1 train2 train3 train4 train5 train6; do
  L=o5-nu-$SEED-$S
  [ -f .local/o5/runs/$L.json ] && continue
  packages/sim/lab/o5/run.sh $SEED $L 0 $S --budget 0.4 > .local/o5/runs/$L.log 2>&1
done
