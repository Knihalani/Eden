#!/usr/bin/env bash
# Diagnosis of the final default on heldout19 (Pi, the agent alone vs Eden), B19's settings. Lab-provider (D97).
set -uo pipefail
cd /home/user/Eden
unset OPENROUTER_API_KEY
D=.local/diag; R=$D/runs; mkdir -p $R
SUITE=heldout19; SEEDS=(41 42 43 44)
USERS=$(for s in "${SEEDS[@]}"; do printf '%s:%s,%s:%s:control,%s:%s:neutral,user:%s,' $SUITE $s $SUITE $s $SUITE $s $s; done)
if [ ! -e $D/cov-final.jsonl ]; then
  bun packages/sim/src/lab/cold-start.ts --users "${USERS%,}" --suite $SUITE --days 2 --day-size 20 \
    --cards-out $D/cov-final.part.jsonl --spend-ledger $D/ledger.jsonl --spend-cap 15 --spend-headroom 0.2 \
    --run-label diag-coverage --out $D/cov-final.json >$D/cov.log 2>&1 && mv $D/cov-final.part.jsonl $D/cov-final.jsonl
fi
gunzip -c packages/sim/lab/distilled/cards-shipped.jsonl.gz >$D/cov.jsonl
cat $D/cov-final.jsonl >>$D/cov.jsonl
COMMON=(--config default --model claude-haiku-5-5 --grader claude-sonnet-5-5 --card-model claude-haiku-5-5
  --reader-model claude-haiku-5-5 --time-scale 1 --spend-ledger $D/ledger.jsonl --spend-cap 15 --spend-headroom 0.2
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload
  --coverage full --cards $D/cov.jsonl --intent $D/cov.jsonl --tenant-prompt --suite $SUITE)
P=()
for s in "${SEEDS[@]}"; do
  for c in tools both+ask; do
    n=ps-${c/+/-}-$s
    [ -e $R/$n.json ] || bun packages/sim/src/lab/pi-ab.ts --conditions $c "${COMMON[@]}" --seeds $s \
      --variants hidden,control,neutral --budget 2 --run-label diag-$n --cards-out $R/$n.cards.jsonl \
      --timeline $R/$n.tl --out $R/$n.json >$R/$n.log 2>&1 &
    P+=($!)
  done
done
for p in "${P[@]}"; do wait $p; done
echo "short done $(date -u +%T)"
P=()
for s in "${SEEDS[@]}"; do
  for c in tools both+ask; do
    n=pd-${c/+/-}-$s
    [ -e $R/$n.json ] || bun packages/sim/src/lab/pi-ab.ts --conditions $c "${COMMON[@]}" --seeds $s --days 2 \
      --day-size 20 --budget 2 --run-label diag-$n --cards-out $R/$n.cards.jsonl \
      --timeline $R/$n.tl --out $R/$n.json >$R/$n.log 2>&1 &
    P+=($!)
  done
done
for p in "${P[@]}"; do wait $p; done
echo "days done $(date -u +%T)"
