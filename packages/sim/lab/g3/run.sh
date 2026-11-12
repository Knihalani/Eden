#!/usr/bin/env bash
# G3 (target 3: agent + Eden net cheaper than the agent alone): F6's multi-turn step (final/go.sh 2b) with several
# Eden arms side by side, one pi-ab process an arm, all on one queue (served by subagents, D1101). Shipped coverage
# (cards-shipped covers dev20 seeds 41-44 on the world clock, D1102), so no coverage step.
#
#   PREFIX=r1 LIMIT=40 SEEDS=41 ARMS="raw D LK NC" bash packages/sim/lab/g3/run.sh
#
# Arms: raw (`tools`), D (the default), LK (F11's D1252 lookup: pushLookup 3, pushLookupAny, pushLookupQuiet; it needs a
# tree with those trial switches, claude/f11-turns: on main, run ARMS="raw D NC"),
# NC (default minus the push check: the pre-D828 unchecked candidates). The session drives the queue
# (packages/sim/lab/final/README.md "Driving the queue").
set -euo pipefail
cd "$(dirname "$0")/../../../.."
unset OPENROUTER_API_KEY
P=${PREFIX:-r1}
L=$PWD/.local/g3/$P
mkdir -p "$L"
export EDEN_LAB_QUEUE=${EDEN_LAB_QUEUE:-$PWD/.local/g3/q}
mkdir -p "$EDEN_LAB_QUEUE"
W=36000000
WAITS="\"pushCheckWaitMs\":$W,\"readerPushWaitMs\":$W"
VARIANTS="{\"Q\":{$WAITS},\"LK\":{$WAITS,\"pushLookup\":3,\"pushLookupAny\":true,\"pushLookupQuiet\":true},\"NC\":{$WAITS,\"pushCheck\":false}${EXTRA_VARIANTS:+,$EXTRA_VARIANTS}}"
COMMON=(--model claude-haiku-5-5 --grader claude-sonnet-5-5 --card-model claude-haiku-5-5
  --reader-model claude-haiku-5-5 --time-scale 1 --tenant-prompt --push payload
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --suite "${SUITE:-dev20}"
  --variants hidden,control,neutral --split "${SPLIT:-8}" --budget 5 --variant-config "$VARIANTS"
  --spend-ledger "$EDEN_LAB_QUEUE/ledger.jsonl" --spend-cap 100000 --spend-headroom 0
  --seeds "${SEEDS:-41}" --limit "${LIMIT:-40}")
arm() { # NAME CONDITION
  local out="$L/$1"
  [ -e "$out.json" ] && return 0
  EDEN_LAB_QUEUE_RUN="$P-$1" bun packages/sim/src/lab/pi-ab.ts --conditions "$2" "${COMMON[@]}" \
    --run-label "$P-$1" --timeline "$out.tl" --out "$out.json" ${DRY:+--dry} >"$out.log" 2>&1 || {
    echo "arm $1 failed (see $out.log)"
    return 1
  }
  if [ "$2" != tools ] && [ -z "${DRY:-}" ]; then
    python3 -I packages/sim/lab/final/check-order.py "$out.tl/tasks.jsonl" >>"$out.log" ||
      echo "arm $1: a push check ended after the agent's first request (see $out.log)"
  fi
}
pids=()
for a in ${ARMS:-raw D LK NC}; do
  case $a in
  raw) arm raw tools & ;;
  D) arm D "both~Q+ask@w$W" & ;;
  *) arm "$a" "both~$a+ask@w$W" & ;;
  esac
  pids+=($!)
done
fail=0
for pid in "${pids[@]}"; do wait "$pid" || fail=1; done
echo "$(date -u +%FT%TZ) g3 run $P done (fail=$fail)" | tee -a "$L/go.log"
exit $fail
