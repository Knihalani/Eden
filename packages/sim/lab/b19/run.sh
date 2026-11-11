#!/usr/bin/env bash
# B19 (D1040–D1042, docs/research/b19-final-bench.md): one harness process for one arm. Everything but Eden's code is
# pinned across arms: agent, grader, card and reader models (all Anthropic through the lab provider, D97), seeds,
# suites, variants, shipped coverage (D878), time scale 1, concurrency, and one spend ledger with a hard cap.
#
#   HARNESS=<commit> FINAL=<commit> [BEFORE=5026ba512] [KIND=hermes|pi] \
#     bash packages/sim/lab/b19/run.sh ARM LABEL [harness flags…]
#
# ARM: raw (the agent alone: `hermes`, Pi's `tools`), before (Eden at BEFORE), final (Eden at FINAL); Eden's arms are
# `hermes+eden` on Hermes and `both+ask` on Pi, the shape integrators ship (own tools, Eden's packets and its ask).
# Each arm runs from its own tree under $B19_TREES (default ../b19/trees, outside the repo): arm-tree.sh's worktree
# with the harness at HARNESS and Eden's product packages at the arm's commit, built on first use and checked against
# its b19-arm.json on every start. A finished label is never run again; every start is logged to .local/b19/starts.log.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
unset OPENROUTER_API_KEY
ARM=${1:?raw|before|final}
L=${2:?label}
shift 2
: "${HARNESS:?}" "${FINAL:?}"
BEFORE=${BEFORE:-5026ba512}
KIND=${KIND:-hermes}
B=$PWD/.local/b19
R=$B/runs
TREES=${B19_TREES:-$(dirname "$PWD")/b19/trees}
mkdir -p "$R" "$TREES"
case $KIND:$ARM in
  hermes:raw) EDEN=$FINAL COND=hermes ;;
  hermes:before) EDEN=$BEFORE COND=hermes+eden ;;
  hermes:final) EDEN=$FINAL COND=hermes+eden ;;
  pi:raw) EDEN=$FINAL COND=tools ;;
  pi:before) EDEN=$BEFORE COND=both+ask ;;
  pi:final) EDEN=$FINAL COND=both+ask ;;
  *)
    echo "run.sh: unknown harness or arm $KIND:$ARM" >&2
    exit 2
    ;;
esac
EDEN=$(git rev-parse --short=9 "$EDEN^{commit}")
H=$(git rev-parse --short=9 "$HARNESS^{commit}")
T=$TREES/$EDEN-on-$H
[ -d "$T" ] || bash packages/sim/lab/b19/arm-tree.sh "$EDEN" "$T" "$H" >&2
grep -q "\"eden\":\"$EDEN\",\"harness\":\"$H\"" "$T/b19-arm.json" || {
  echo "run.sh: $T is not $EDEN on $H" >&2
  exit 2
}
if [ -e "$R/$L.json" ]; then
  echo "run.sh: $L is finished; not run again" >&2
  exit 0
fi
echo "$(date -u +%FT%TZ) $L kind=$KIND arm=$ARM eden=$EDEN harness=$H $*" >>"$B/starts.log"
COMMON=(--conditions "$COND" --config default --model claude-haiku-5-5 --grader claude-sonnet-5-5
  --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 --time-scale 1
  --spend-ledger "$B/ledger.jsonl" --spend-cap "${CAP:-40}" --spend-headroom 0.2 --run-label "$L"
  --cards-out "$R/$L.cards.jsonl" --timeline "$R/$L.tl" --out "$R/$L.json")
cd "$T"
if [ "$KIND" = hermes ]; then
  exec env -u OPENROUTER_API_KEY bun packages/sim/src/lab/hermes-ab.ts \
    --hermes-src "${HERMES_SRC:-/home/user/hermes/src}" --concurrency "${HC:-4}" "${COMMON[@]}" "$@"
fi
exec env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts "${COMMON[@]}" "$@"
