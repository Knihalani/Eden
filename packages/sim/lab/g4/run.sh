#!/usr/bin/env bash
# G4 (target 4): the multi-turn comparison of go.sh's step 2b with more arms, on this checkout (served by subagents,
# D1101). Coverage as go.sh records it (cold-start.ts on the world's clock), then one pi-ab process an arm:
#
#   SUITE=dev20 SEED=41 LIMIT=40 PREFIX=g4a bash packages/sim/lab/g4/run.sh
#
# Arms (ARMS="name=config ..." overrides): mt-raw (`tools`), mt-final (the default), and one arm per config given
# (default: F11's LK4). Run g4b also had mt-lku, LK4 with `pushLookupUnchecked` (D1552, deleted; code in c736020c).
# Read with `python3 -I packages/sim/lab/final/wall.py .local/final/$PREFIX --arms mt-final,... --hold`.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
unset OPENROUTER_API_KEY
SUITE=${SUITE:-dev20}
SEED=${SEED:-41}
P=${PREFIX:-g4}
L=$PWD/.local/final/$P
mkdir -p "$L"
export EDEN_LAB_QUEUE=${EDEN_LAB_QUEUE:-$L/q}
mkdir -p "$EDEN_LAB_QUEUE" "$L/b"
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$L/go.log"; }
LK='{"pushLookup":3,"pushLookupAny":true,"pushLookupQuiet":true}'
ARMS=${ARMS:-"mt-lk=$LK"}
SUITE_LIST=$(bun -e \
  'import { parseSuites } from "./packages/sim/src/lab/suites.ts"; console.log(parseSuites(process.argv[1]).join(" "))' \
  "$SUITE")
USERS=$(for x in $SUITE_LIST; do printf '%s:%s %s:%s:control %s:%s:neutral ' "$x" "$SEED" "$x" "$SEED" "$x" "$SEED"; done)
COV="$L/cov"
if [ ! -e "$COV.jsonl" ]; then
  log "g4: coverage (drive the queue now)"
  mkdir -p "$COV.d"
  pids=()
  for u in $USERS; do
    [ -e "$COV.d/$u.done" ] && continue
    (EDEN_LAB_QUEUE_RUN="$P-cov" bun packages/sim/src/lab/cold-start.ts --users "$u" --suite "$SUITE" --clock world \
      --cards-out "$COV.d/$u.jsonl" --spend-ledger "$EDEN_LAB_QUEUE/ledger.jsonl" --spend-cap 100000 \
      --spend-headroom 0 --run-label "$P-cov" --out "$COV.d/$u.json" >"$COV.d/$u.log" 2>&1 &&
      touch "$COV.d/$u.done") &
    pids+=($!)
  done
  fail=0
  for pid in "${pids[@]}"; do wait "$pid" || fail=1; done
  [ $fail -eq 0 ] || { log "g4: a coverage world failed"; exit 1; }
  gunzip -c packages/sim/lab/distilled/cards-shipped.jsonl.gz >"$COV.jsonl.tmp"
  cat "$COV".d/*.jsonl >>"$COV.jsonl.tmp"
  mv "$COV.jsonl.tmp" "$COV.jsonl"
  log "g4: coverage done"
fi
WAIT=36000000
WAITS="{\"Q\":{\"pushCheckWaitMs\":$WAIT,\"readerPushWaitMs\":$WAIT}}"
EDEN_COND="both~Q+ask@w$WAIT"
COMMON=(--model claude-haiku-5-5 --grader claude-sonnet-5-5 --card-model claude-haiku-5-5
  --reader-model claude-haiku-5-5 --time-scale 1 --tenant-prompt --push payload
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --suite "$SUITE"
  --variants hidden,control,neutral --split "${SPLIT:-8}" --budget 5 --variant-config "$WAITS"
  --spend-ledger "$EDEN_LAB_QUEUE/ledger.jsonl" --spend-cap 100000 --spend-headroom 0
  --seeds "$SEED" --limit "${LIMIT:-40}")
arm() { # NAME CONDITION CONFIG
  local name=$1 cond=$2 cfg=$3 out="$L/$1"
  [ -e "$out.json" ] && return 0
  EDEN_LAB_QUEUE_RUN="$P-$name" bun packages/sim/src/lab/pi-ab.ts --conditions "$cond" "${COMMON[@]}" \
    --config "$cfg" --coverage full --cards "$COV.jsonl" --intent "$COV.jsonl" --run-label "$P-$name" \
    --cards-out "$out.cards.jsonl" --timeline "$out.tl" --out "$out.json" >"$out.log" 2>&1 || return 1
  if [ "$cond" != tools ]; then
    python3 -I packages/sim/lab/final/check-order.py "$out.tl/tasks.jsonl" >>"$out.log" || log "g4: $name: late checks"
  fi
}
log "g4: arms (drive the queue now)"
pids=()
arm mt-raw tools default &
pids+=($!)
arm mt-final "$EDEN_COND" default &
pids+=($!)
for a in $ARMS; do
  arm "${a%%=*}" "$EDEN_COND" "${a#*=}" &
  pids+=($!)
done
fail=0
for pid in "${pids[@]}"; do wait "$pid" || fail=1; done
[ $fail -eq 0 ] || { log "g4: an arm failed (see $L/*.log)"; exit 1; }
log "g4: done"
