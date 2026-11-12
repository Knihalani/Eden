#!/usr/bin/env bash
# G1 (D1400): the pre-registered pair for `pushDaySeats`, F6's single-shot recipe (packages/sim/lab/final/go.sh) cut to
# two Eden arms on ONE tree (this checkout) and the shipped coverage (dev20's cards are in it, D1102): `base` (the
# default) against `seats` (GCFG). Every model call goes through the queue, answered by subagents (D1101): quote every
# number as "served by subagents, single-shot". Drive the queue as packages/sim/lab/final/README.md says.
# Outputs: .local/final/<PREFIX>/{base,seats}-<seed>.json and their .tl timelines.
#
#   PREFIX=g1 SEEDS=41,42,43,44 bash packages/sim/lab/g1/go.sh
set -euo pipefail
cd "$(dirname "$0")/../../../.."
unset OPENROUTER_API_KEY
SUITE=${SUITE:-dev20}
SEEDS=${SEEDS:-41,42,43,44}
P=${PREFIX:-g1}
GCFG=${GCFG:-'{"pushDaySeats":3}'}
L=$PWD/.local/final/$P
mkdir -p "$L"
export EDEN_LAB_QUEUE=${EDEN_LAB_QUEUE:-$L/q}
mkdir -p "$EDEN_LAB_QUEUE" "$L/b"
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$L/go.log"; }
COV=$L/cov.jsonl
[ -e "$COV" ] || gunzip -c packages/sim/lab/distilled/cards-shipped.jsonl.gz >"$COV"
WAIT=36000000
WAITS="{\"Q\":{\"pushCheckWaitMs\":$WAIT,\"readerPushWaitMs\":$WAIT}}"
COMMON=(--model claude-haiku-5-5 --grader claude-sonnet-5-5 --card-model claude-haiku-5-5
  --reader-model claude-haiku-5-5 --time-scale 1 --tenant-prompt --push payload
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --suite "$SUITE"
  --variants hidden,control,neutral --split "${SPLIT:-8}" --budget 5 --variant-config "$WAITS"
  --spend-ledger "$EDEN_LAB_QUEUE/ledger.jsonl" --spend-cap 100000 --spend-headroom 0
  --agent-sim single --coverage full --cards "$COV" --intent "$COV")
arm() { # NAME CONFIG SEED
  local out="$L/$1-$3"
  [ -e "$out.json" ] && return 0
  EDEN_LAB_QUEUE_RUN="$P-$1" env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts \
    --conditions "both~Q+ask@w$WAIT" "${COMMON[@]}" --seeds "$3" --config "$2" --run-label "$P-$1" \
    --cards-out "$out.cards.jsonl" --timeline "$out.tl" --out "$out.json" ${EXTRA:-} >"$out.log" 2>&1 || return 1
  python3 -I packages/sim/lab/final/check-order.py "$out.tl/tasks.jsonl" >>"$out.log" ||
    { log "go: $1-$3: a push check ended after the agent's first request"; return 1; }
}
log "go: suite=$SUITE seeds=$SEEDS cfg=$GCFG tree=$(git rev-parse --short=9 HEAD) queue=$EDEN_LAB_QUEUE"
# One process an arm a seed (four seeds in one process held 8.7 GB), AT_ONCE seeds side by side (both arms each).
IFS=, read -r -a SEED_ARR <<<"$SEEDS"
AT_ONCE=${AT_ONCE:-2}
fail=0
for ((i = 0; i < ${#SEED_ARR[@]}; i += AT_ONCE)); do
  pids=()
  for s in "${SEED_ARR[@]:i:AT_ONCE}"; do
    arm base default "$s" &
    pids+=($!)
    arm seats "$GCFG" "$s" &
    pids+=($!)
  done
  for pid in "${pids[@]}"; do wait "$pid" || fail=1; done
done
[ $fail -eq 0 ] || { log "go: an arm failed (see $L/*.log)"; exit 1; }
log "go: arms done"
