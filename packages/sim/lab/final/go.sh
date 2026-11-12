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
#   1. Coverage for each tree's own card form, on the world's clock (cold-start.ts, `--clock world`, F8 #287), worlds
#      hidden/control/neutral of every seed, through the queue; each arm replays the shipped file plus its own.
#   2. Three pi-ab arms side by side, `--agent-sim single`: raw (`tools`, final tree), before and final (`both+ask`,
#      their trees). Each arm has its own EDEN_LAB_QUEUE_RUN (pricing). The push check and the first observe wait for
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
mkdir -p "$EDEN_LAB_QUEUE"
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
coverage() { # TREE NAME
  local out="$L/cov-$2" pids=() u fail=0
  [ -e "$out.jsonl" ] && return 0
  mkdir -p "$out.d"
  for u in ${USERS//,/ }; do
    [ -e "$out.d/$u.done" ] && continue
    (cd "$1" && EDEN_LAB_QUEUE_RUN="$P-cov-$2" env -u OPENROUTER_API_KEY bun packages/sim/src/lab/cold-start.ts \
      --users "$u" --suite "$SUITE" --clock world --cards-out "$out.d/$u.jsonl" \
      --spend-ledger "$EDEN_LAB_QUEUE/ledger.jsonl" --spend-cap 100000 --spend-headroom 0 --run-label "$P-cov-$2" \
      --out "$out.d/$u.json" \
      >"$out.d/$u.log" 2>&1 && touch "$out.d/$u.done") &
    pids+=($!)
  done
  for pid in "${pids[@]}"; do wait "$pid" || fail=1; done
  [ $fail -eq 0 ] || { log "go: a $2 coverage world failed (see $out.d/*.log)"; return 1; }
  if grep -Eq '"cardCalls": 0,' "$out".d/*.json; then
    log "go: a $2 world made no card call (see $out.d/*.json): stopped"
    return 1
  fi
  gunzip -c packages/sim/lab/distilled/cards-shipped.jsonl.gz >"$out.jsonl.tmp"
  cat "$out".d/*.jsonl >>"$out.jsonl.tmp"
  mv "$out.jsonl.tmp" "$out.jsonl"
}
log "go: step 1 coverage (drive the queue now)"
coverage "$TB" before &
CB=$!
coverage "$TF" final &
CF=$!
wait $CB && wait $CF || { log "go: coverage failed: stopped"; exit 1; }
log "go: step 1 done"

# 2. The arms. One process an arm (all seeds), the three side by side so their calls share the queue's batches.
WAIT=36000000
COMMON=(--agent-sim single --model claude-haiku-5-5 --grader claude-sonnet-5-5 --card-model claude-haiku-5-5
  --reader-model claude-haiku-5-5 --time-scale 1 --tenant-prompt --push payload
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --suite "$SUITE" --seeds "$SEEDS"
  --variants hidden,control,neutral --split "$SPLIT" --budget 5 --config "{\"pushCheckWaitMs\":$WAIT}"
  --spend-ledger "$EDEN_LAB_QUEUE/ledger.jsonl" --spend-cap 100000 --spend-headroom 0)
arm() { # TREE ARM CONDITION COVERAGE
  local out="$L/$2"
  [ -e "$out.json" ] && return 0
  (cd "$1" && EDEN_LAB_QUEUE_RUN="$P-$2" env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts \
    --conditions "$3" "${COMMON[@]}" --coverage full --cards "$4" --intent "$4" --run-label "$P-$2" \
    --cards-out "$out.cards.jsonl" --timeline "$out.tl" --out "$out.json" ${EXTRA:-}) >"$out.log" 2>&1
}
# A --dry start of every arm first (modules, worlds, coverage; no model call).
for a in "$TF raw tools $L/cov-final.jsonl" "$TB before both+ask@w$WAIT $L/cov-before.jsonl" \
  "$TF final both+ask@w$WAIT $L/cov-final.jsonl"; do
  read -r t n c v <<<"$a"
  (cd "$t" && env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --conditions "$c" "${COMMON[@]}" \
    --coverage full --cards "$v" --intent "$v" --seeds "${SEED_ARR[0]}" --out "$L/dry-$n.json" --dry) \
    >"$L/dry-$n.log" 2>&1 || { log "go: the $n arm does not start (see $L/dry-$n.log): stopped"; exit 2; }
done
log "go: step 2 arms (drive the queue now)"
arm "$TF" raw tools "$L/cov-final.jsonl" &
A1=$!
arm "$TB" before "both+ask@w$WAIT" "$L/cov-before.jsonl" &
A2=$!
arm "$TF" final "both+ask@w$WAIT" "$L/cov-final.jsonl" &
A3=$!
fail=0
for pid in $A1 $A2 $A3; do wait "$pid" || fail=1; done
[ $fail -eq 0 ] || { log "go: an arm failed (see $L/*.log): stopped"; exit 1; }
log "go: step 2 done"

# 3. The report.
bash packages/sim/lab/final/report.sh "$L" "$SUITE" | tee "$L/report.txt"
log "go: done"
