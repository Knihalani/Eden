#!/usr/bin/env bash
# The final benchmark (served by subagents, D1101; single-shot agent): Eden before the F wave against Eden final and
# the agent alone, on one suite, every model call through ONE queue transport directory answered by Claude Code
# subagents. Run from the repo root on claude/final-pipeline (with the final main merged):
#
#   FINAL=<commit> SUITE=heldout20 bash packages/sim/lab/final/go.sh            # the final read (once)
#   FINAL=HEAD SUITE=dev20 SEEDS=41 PREFIX=reh bash packages/sim/lab/final/go.sh # a rehearsal
#
# The script blocks on the queue: while it runs, the session drives the batches (packages/sim/lab/final/README.md:
# `drive.sh` lists what waits, haiku subagents answer `agent`/`eden.*` batches, sonnet subagents `grader` batches).
# Steps (each skipped when its output exists, so a stopped run resumes where it stopped):
#   0. Trees: BEFORE (default 006b505c, the pre-F-wave main) and FINAL, each with this checkout's harness (B19's
#      arm-tree.sh); both must run identical tasks (tasks-hash.ts), and every arm passes a `--dry` start.
#   1. The final tree's coverage on the world's clock (cold-start.ts, `--clock world`, F8 #287), worlds
#      hidden/control/neutral of every seed, through the queue; each arm replays the shipped file plus its own.
#   2. Single-shot (`--agent-sim single`) raw (`tools`) and final (`both+ask`), then 2b the multi-turn sample (MT_LIMIT
#      tasks a world), then 2b' the before tree's coverage and arm (SKIP_BEFORE=1 drops it), then 2c REALISM. That
#      order puts the owner's targets first, against the subagents' weekly cap; report.sh reads whatever finished.
#      Each arm has its own EDEN_LAB_QUEUE_RUN (pricing). The push check and the first observe wait for
#      the queue (`pushCheckWaitMs`, `@w`): a subagent answers in minutes, where the API's would land in ~1.5 s.
#   3. report.sh: hidden raised, concerns, paired template-clustered CIs, splits, stage attribution, cost and wait.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
unset OPENROUTER_API_KEY
: "${FINAL:?the final commit (FINAL=<commit>)}"
SUITE=${SUITE:-heldout20}
SEEDS=${SEEDS:-41,42,43,44}
P=${PREFIX:-final}
SPLIT=${SPLIT:-8}
BEFORE=${BEFORE:-006b505c}
L=$PWD/.local/final/$P
mkdir -p "$L"
export EDEN_LAB_QUEUE=${EDEN_LAB_QUEUE:-$L/q}
mkdir -p "$EDEN_LAB_QUEUE" "$L/b" # b/: the workers' batch files (worker.md)
HARNESS=$(git rev-parse --short=9 HEAD)
B9=$(git rev-parse --short=9 "$BEFORE^{commit}")
F9=$(git rev-parse --short=9 "$FINAL^{commit}")
TREES=${FINAL_TREES:-$(dirname "$PWD")/final-trees}
mkdir -p "$TREES"
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$L/go.log"; }
log "go: suite=$SUITE seeds=$SEEDS before=$B9 final=$F9 harness=$HARNESS split=$SPLIT queue=$EDEN_LAB_QUEUE"
IFS=, read -r -a SEED_ARR <<<"$SEEDS"

# 0. Trees and the proof they run identical tasks.
for e in "$B9" "$F9"; do
  T="$TREES/$e-on-$HARNESS"
  [ -d "$T" ] || bash packages/sim/lab/b19/arm-tree.sh "$e" "$T" "$HARNESS" >>"$L/go.log" 2>&1
  (cd "$T" && env -u OPENROUTER_API_KEY bun "$OLDPWD/packages/sim/lab/b19/tasks-hash.ts" "$SUITE" "$SEEDS" 2 20) \
    >"$L/tasks-hash-$e.txt"
done
if ! cmp -s "$L/tasks-hash-$B9.txt" "$L/tasks-hash-$F9.txt"; then
  log "go: the before and final trees do not run identical $SUITE tasks: stopped"
  exit 2
fi
TB="$TREES/$B9-on-$HARNESS"
TF="$TREES/$F9-on-$HARNESS"
# DRY_ONLY=1: trees and task hashes above, then a `--dry` start of every arm on the shipped coverage (modules, worlds,
# FINAL_CONFIG; no model call, nothing queued), and stop: the start-up check to run at the freeze.
if [ "${DRY_ONLY:-0}" = 1 ]; then
  W=36000000
  for a in "$TF raw tools default" "$TB before both~Q+ask@w$W default" \
    "$TF final both~Q+ask@w$W ${FINAL_CONFIG:-default}"; do
    read -r t n c g <<<"$a"
    (cd "$t" && env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --conditions "$c" --config "$g" \
      --variant-config "{\"Q\":{\"pushCheckWaitMs\":$W,\"readerPushWaitMs\":$W}}" --agent-sim single \
      --model claude-haiku-5-5 --grader claude-sonnet-5-5 --card-model claude-haiku-5-5 \
      --reader-model claude-haiku-5-5 --suite "$SUITE" --seeds "${SEED_ARR[0]}" --variants hidden,control,neutral \
      --split "$SPLIT" --spend-ledger "$EDEN_LAB_QUEUE/ledger.jsonl" --spend-cap 100000 --spend-headroom 0 \
      --out "$L/dry-$n.json" --dry) >"$L/dry-$n.log" 2>&1 || {
      log "go: dry: the $n arm does not start ($L/dry-$n.log)"
      exit 2
    }
  done
  log "go: dry run passed (trees, task hashes, every arm starts)"
  exit 0
fi

# 1. Coverage, each tree its own (identical card prompts across the trees replay from the queue, answered once).
# `--users` takes one suite a world: a group name (dev20) is expanded to its suites.
SUITE_LIST=$(env -u OPENROUTER_API_KEY bun -e \
  'import { parseSuites } from "./packages/sim/src/lab/suites.ts"; console.log(parseSuites(process.argv[1]).join(" "))' \
  "$SUITE")
USERS=$(for x in $SUITE_LIST; do for s in "${SEED_ARR[@]}"; do printf '%s:%s,%s:%s:control,%s:%s:neutral,' \
  "$x" "$s" "$x" "$s" "$x" "$s"; done; done)
# One cold-start process a world: a process cards its users one after another and a user's card calls mostly one at a
# time, so through the queue (minutes a call) one process would take hours; worlds side by side put their calls in the
# queue together, and identical card prompts (the same base world under several suites and variants) are answered once.
coverage() { # TREE NAME [cold-start flags...]
  local t=$1 name=$2 out="$L/cov-$2" pids=() u fail=0
  shift 2
  [ -e "$out.jsonl" ] && return 0
  mkdir -p "$out.d"
  for u in ${USERS//,/ }; do
    [ -e "$out.d/$u.done" ] && continue
    (cd "$t" && EDEN_LAB_QUEUE_RUN="$P-cov-$name" env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cold-start.ts \
      --users "$u" --suite "$SUITE" --clock world --cards-out "$out.d/$u.jsonl" \
      --spend-ledger "$EDEN_LAB_QUEUE/ledger.jsonl" --spend-cap 100000 --spend-headroom 0 --run-label "$P-cov-$name" \
      --out "$out.d/$u.json" "$@" \
      >"$out.d/$u.log" 2>&1 && touch "$out.d/$u.done") &
    pids+=($!)
  done
  for pid in "${pids[@]}"; do wait "$pid" || fail=1; done
  [ $fail -eq 0 ] || { log "go: a $name coverage world failed (see $out.d/*.log)"; return 1; }
  if grep -Eq '"cardCalls": 0,' "$out".d/*.json; then
    log "go: a $name world made no card call (see $out.d/*.json): stopped"
    return 1
  fi
  gunzip -c packages/sim/lab/distilled/cards-shipped.jsonl.gz >"$out.jsonl.tmp"
  cat "$out".d/*.jsonl >>"$out.jsonl.tmp"
  mv "$out.jsonl.tmp" "$out.jsonl"
}
# Order (integrator, against the subagents' weekly cap): the final tree's coverage, raw and final single-shot, the
# multi-turn sample, then the before tree (coverage and arm), then realism, so a run cut short still holds the owner's
# targets. FINAL_CONFIG reaches the final tree's coverage when it is a JSON object (cold-start's `--set`); a preset name
# cannot, so the card form would be the default's: promote the profile into DEFAULT_CONFIG instead (F12's plan).
FCFG=${FINAL_CONFIG:-default}
COVSET=()
case "$FCFG" in
  default) ;;
  \{*) COVSET=(--set "$FCFG") ;;
  *) log "go: FINAL_CONFIG=$FCFG is a preset: the final tree's coverage runs its default configuration" ;;
esac
# BEFORE_COVERAGE_ONLY=1: the before tree's coverage alone, then stop. BEFORE is fixed, so its coverage can be made
# ahead of the final (same PREFIX, same queue); the final run then finds cov-before.jsonl and skips it.
if [ "${BEFORE_COVERAGE_ONLY:-0}" = 1 ]; then
  log "go: before coverage only (drive the queue now)"
  coverage "$TB" before || { log "go: before coverage failed: stopped"; exit 1; }
  log "go: before coverage done ($L/cov-before.jsonl)"
  exit 0
fi
log "go: step 1 final coverage (drive the queue now)"
coverage "$TF" final "${COVSET[@]}" || { log "go: coverage failed: stopped"; exit 1; }
log "go: step 1 done"

# 2. The arms. One process an arm (all seeds), the three side by side so their calls share the queue's batches.
# Through the queue a push check takes a minute or more (a subagent), so every wait on it is lifted: the check's own
# (`pushCheckWaitMs`), the push observe's cap (`readerPushWaitMs`, 60 s: F7 found checks landing after the agent's first
# call on 21 of 36 tasks without it) and the harness's first observe (`@w`). check-order.py asserts it after each arm.
# FINAL_CONFIG (a preset name or JSON, e.g. F12's candidate profile) is the final arm's configuration; the before arm
# runs `default` at BEFORE. The waits are a variant (`~Q`) over either, so a preset keeps its own settings.
WAIT=36000000
WAITS="{\"Q\":{\"pushCheckWaitMs\":$WAIT,\"readerPushWaitMs\":$WAIT}}"
EDEN_COND="both~Q+ask@w$WAIT"
COMMON=(--model claude-haiku-5-5 --grader claude-sonnet-5-5 --card-model claude-haiku-5-5
  --reader-model claude-haiku-5-5 --time-scale 1 --tenant-prompt --push payload
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --suite "$SUITE"
  --variants hidden,control,neutral --split "$SPLIT" --budget 5 --variant-config "$WAITS"
  --spend-ledger "$EDEN_LAB_QUEUE/ledger.jsonl" --spend-cap 100000 --spend-headroom 0)
arm() { # TREE ARM CONDITION COVERAGE CONFIG [flags...]
  local t=$1 name=$2 cond=$3 cov=$4 cfg=$5 out="$L/$2"
  shift 5
  [ -e "$out.json" ] && return 0
  (cd "$t" && EDEN_LAB_QUEUE_RUN="$P-$name" env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts \
    --conditions "$cond" "${COMMON[@]}" --config "$cfg" --coverage full --cards "$cov" --intent "$cov" \
    --run-label "$P-$name" --cards-out "$out.cards.jsonl" --timeline "$out.tl" --out "$out.json" "$@" ${EXTRA:-}) \
    >"$out.log" 2>&1 || return 1
  # The push check must land before the agent's first model request, or the arm measured late injection.
  if [ "$cond" != tools ] && ! python3 -I packages/sim/lab/final/check-order.py "$out.tl/tasks.jsonl" >>"$out.log"; then
    log "go: $name: a push check ended after the agent's first request (see $out.log): stopped"
    return 1
  fi
}
SINGLE=(--agent-sim single --seeds "$SEEDS")
# A --dry start of the final tree's arms first (modules, worlds, coverage, configuration; no model call).
for a in "$TF raw tools $L/cov-final.jsonl default" "$TF final $EDEN_COND $L/cov-final.jsonl $FCFG"; do
  read -r t n c v g <<<"$a"
  (cd "$t" && env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --conditions "$c" "${COMMON[@]}" \
    --config "$g" --coverage full --cards "$v" --intent "$v" --seeds "${SEED_ARR[0]}" --out "$L/dry-$n.json" --dry) \
    >"$L/dry-$n.log" 2>&1 || { log "go: the $n arm does not start (see $L/dry-$n.log): stopped"; exit 2; }
done
log "go: step 2 single-shot raw and final (drive the queue now)"
arm "$TF" raw tools "$L/cov-final.jsonl" default "${SINGLE[@]}" &
A1=$!
arm "$TF" final "$EDEN_COND" "$L/cov-final.jsonl" "$FCFG" "${SINGLE[@]}" &
A3=$!
fail=0
for pid in $A1 $A3; do wait "$pid" || fail=1; done
[ $fail -eq 0 ] || { log "go: an arm failed (see $L/*.log): stopped"; exit 1; }
log "go: step 2 done"

# 2b. The multi-turn sample (the owner's cost and speed targets need the agent's own turns, which single-shot cannot
# see): the real Pi loop through the queue, raw against final, MT_LIMIT tasks a world of MT_SEEDS (default: the first
# seed, 20 a world: 60 tasks an arm on a one-suite run).
MT=(--seeds "${MT_SEEDS:-${SEED_ARR[0]}}" --limit "${MT_LIMIT:-20}")
log "go: step 2b multi-turn sample (drive the queue now)"
arm "$TF" mt-raw tools "$L/cov-final.jsonl" default "${MT[@]}" &
M1=$!
arm "$TF" mt-final "$EDEN_COND" "$L/cov-final.jsonl" "$FCFG" "${MT[@]}" &
M2=$!
fail=0
for pid in $M1 $M2; do wait "$pid" || fail=1; done
[ $fail -eq 0 ] || { log "go: a multi-turn arm failed (see $L/mt-*.log): stopped"; exit 1; }
log "go: step 2b done"

# 2b'. The before tree: its own coverage, then its single-shot arm (the comparison with the pre-campaign product).
if [ "${SKIP_BEFORE:-0}" != 1 ]; then
  log "go: step 2b' before coverage and arm (drive the queue now)"
  coverage "$TB" before || { log "go: before coverage failed: stopped"; exit 1; }
  (cd "$TB" && env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --conditions "$EDEN_COND" "${COMMON[@]}" \
    --config default --coverage full --cards "$L/cov-before.jsonl" --intent "$L/cov-before.jsonl" \
    --seeds "${SEED_ARR[0]}" --out "$L/dry-before.json" --dry) >"$L/dry-before.log" 2>&1 ||
    { log "go: the before arm does not start (see $L/dry-before.log): stopped"; exit 2; }
  arm "$TB" before "$EDEN_COND" "$L/cov-before.jsonl" default "${SINGLE[@]}" ||
    { log "go: the before arm failed (see $L/before.log): stopped"; exit 1; }
  log "go: step 2b' done"
fi

# 2c. Optional (REALISM=heavy): the same single-shot comparison, raw against final only, with every world as a heavy
# real user's (`--realism heavy`, F8, D1103: twenty connectors, 600 rule-like noise items a world). Run after the main
# arms and skipped unless asked, so a short day can drop it. The realism items' cards are in the shipped file (they
# depend only on the seed); the planted items' are the final tree's own coverage.
if [ "${REALISM:-off}" != off ]; then
  log "go: step 2c realism=$REALISM (drive the queue now)"
  arm "$TF" rh-raw tools "$L/cov-final.jsonl" default "${SINGLE[@]}" --realism "$REALISM" &
  R1=$!
  arm "$TF" rh-final "$EDEN_COND" "$L/cov-final.jsonl" "$FCFG" "${SINGLE[@]}" --realism "$REALISM" &
  R2=$!
  fail=0
  for pid in $R1 $R2; do wait "$pid" || fail=1; done
  [ $fail -eq 0 ] || { log "go: a realism arm failed (see $L/rh-*.log): stopped"; exit 1; }
  log "go: step 2c done"
fi

# 3. The report: quality (report.py), then quality, cost and speed side by side (cost.py), then F7's per-role pricing.
{
  bash packages/sim/lab/final/report.sh "$L" "$SUITE"
  echo
  python3 -I packages/sim/lab/final/cost.py "$L"
  echo
  python3 -I packages/sim/lab/final/wall.py "$L" --hold
  echo
  echo "== answers rejected by batch.ts put (format failures, re-queued and answered again; F7 §13), by arm and role"
  if [ -e "$EDEN_LAB_QUEUE/invalid.jsonl" ]; then
    python3 -I -c 'import json,sys,collections
c=collections.Counter((r.get("run"),r.get("role")) for r in map(json.loads,open(sys.argv[1])) if r)
[print(f"  {run} {role}: {n}") for (run,role),n in sorted(c.items(),key=str)]' "$EDEN_LAB_QUEUE/invalid.jsonl"
  else
    echo "  none"
  fi
  if [ -e "$L/rh-final.json" ]; then
    echo
    echo "== realism heavy (F8, D1103): raw against final, single-shot"
    mkdir -p "$L/rh"
    for a in raw final; do ln -sf "../rh-$a.json" "$L/rh/$a.json"; ln -sfn "../rh-$a.tl" "$L/rh/$a.tl"; done
    python3 -I packages/sim/lab/final/report.py "$L/rh" | sed -n '/== per arm/,/== hidden raised by label/p'
  fi
} | tee "$L/report.txt"
log "go: done"
