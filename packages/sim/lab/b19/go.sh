#!/usr/bin/env bash
# B19's final run (pre-registered in docs/research/b19-final-bench.md §2, D1043): heldout19, read once, three arms on
# Hermes (short) and Pi (short and days). Run only on the parent's go, from this branch after merging the final main:
#
#   FINAL=<final main commit> bash packages/sim/lab/b19/go.sh
#
# HARNESS is this checkout's HEAD (the final main's lab code with B19's tooling merged in). The ledger's hard cap is
# what the dry runs spent plus $25, never above the session's $40. Every process runs once (run.sh refuses a finished
# label); the three arms of a step run side by side, so their wall times share one load.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
unset OPENROUTER_API_KEY
: "${FINAL:?the final main commit}"
export FINAL BEFORE=5026ba512 HARNESS
HARNESS=$(git rev-parse --short=9 HEAD)
if ! git merge-base --is-ancestor "$FINAL" HEAD; then
  echo "go.sh: HEAD does not contain $FINAL: merge it first" >&2
  exit 2
fi
L=.local/b19
SPENT=$(python3 -I -c "import json;print(sum(json.loads(l).get('costUsd',0) for l in open('$L/ledger.jsonl')))")
export CAP
CAP=$(python3 -I -c "print(round(min(40.0, $SPENT + 25.0), 2))")
echo "$(date -u +%FT%TZ) go: final=$FINAL harness=$HARNESS spent=$SPENT cap=$CAP" | tee -a $L/starts.log
MARKET=(--source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload)
SEEDS=(41 42 43 44)

# 0. Both trees, and the proof they run identical tasks, worlds and prompts (hashes and counts only, no task text).
TREES=${B19_TREES:-$(dirname "$PWD")/b19/trees}
for e in "$BEFORE" "$FINAL"; do
  e=$(git rev-parse --short=9 "$e^{commit}")
  [ -d "$TREES/$e-on-$HARNESS" ] || bash packages/sim/lab/b19/arm-tree.sh "$e" "$TREES/$e-on-$HARNESS" "$HARNESS"
  (cd "$TREES/$e-on-$HARNESS" && env -u OPENROUTER_API_KEY bun "$OLDPWD/packages/sim/lab/b19/tasks-hash.ts" \
    heldout19 41,42,43,44 2 20) >"$L/tasks-hash-$e.txt"
done
B9=$(git rev-parse --short=9 "$BEFORE^{commit}")
F9=$(git rev-parse --short=9 "$FINAL^{commit}")
if ! cmp -s "$L/tasks-hash-$B9.txt" "$L/tasks-hash-$F9.txt"; then
  echo "go.sh: the before and final trees do not run identical heldout19 tasks; nothing was spent" >&2
  exit 2
fi

# 1. Hermes, one request a session: all four seeds in one process an arm, four workers each.
for a in raw before final; do
  KIND=hermes HC=4 bash packages/sim/lab/b19/run.sh $a h19-h-$a --suite heldout19 --seeds 41,42,43,44 \
    --variants hidden,control,neutral --budget 6 "${MARKET[@]}" >$L/h19-h-$a.log 2>&1 &
done
wait
# 2. Pi, one request a session: one seed a process (memory), the three arms of a seed side by side.
for s in "${SEEDS[@]}"; do
  for a in raw before final; do
    KIND=pi bash packages/sim/lab/b19/run.sh $a h19-ps-$a-$s --suite heldout19 --seeds $s \
      --variants hidden,control,neutral --budget 2 --tenant-prompt "${MARKET[@]}" >$L/h19-ps-$a-$s.log 2>&1 &
  done
  wait
done
# 3. Pi over a user's days: one user a process, two days of 20 requests (heldout19's 40 templates bound a user).
for s in "${SEEDS[@]}"; do
  for a in raw before final; do
    KIND=pi bash packages/sim/lab/b19/run.sh $a h19-pd-$a-$s --suite heldout19 --seeds $s --days 2 --day-size 20 \
      --budget 2 --tenant-prompt "${MARKET[@]}" >$L/h19-pd-$a-$s.log 2>&1 &
  done
  wait
done
echo "$(date -u +%FT%TZ) go: done" | tee -a $L/starts.log
