#!/bin/bash
# B18 (docs/research/b18-heldout18.md): one pi-ab process of the blind confirmation on heldout18. ARM LABEL then pi-ab
# flags. A29's run.sh (packages/sim/lab/a29/run.sh) on heldout18, with the arm choosing the checkout the process runs:
#   pre    the default as of main @ e037a0eb (a git worktree at .local/b18/pre), condition `eden`
#   now    the default as of this checkout (main @ 5026ba51 plus lab and doc files only), condition `eden`
#   tools  the agent alone with its search tools, this checkout, condition `tools`
# Every arm gets the same flags, cards file, ledger and seeds. A finished run is never run again: the script refuses
# when its results file exists. A start is logged, so a restart after a crash shows in .local/b18/starts.log.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
ARM=$1; L=$2; shift 2
case $ARM in
  pre) DIR=$ROOT/.local/b18/pre; COND=eden ;;
  now) DIR=$ROOT; COND=eden ;;
  tools) DIR=$ROOT; COND=tools ;;
  *) echo "run.sh: arm is pre, now or tools" >&2; exit 2 ;;
esac
R=$ROOT/.local/b18/runs
mkdir -p "$R"
if [ -e "$R/$L.json" ]; then echo "run.sh: $L is finished; not run again" >&2; exit 0; fi
echo "$(date -u +%FT%TZ) $L $ARM $(git -C "$DIR" rev-parse HEAD) $*" >> "$ROOT/.local/b18/starts.log"
cd "$DIR"
exec env -u OPENROUTER_API_KEY bun packages/sim/src/lab/pi-ab.ts --suite "${B18_SUITE:-heldout18}" \
  --conditions $COND --config default --tenant-prompt \
  --cards "$ROOT/.local/b18/cards-all.jsonl" --cards-out "$R/$L.cards.jsonl" \
  --model claude-haiku-5-5 --grader claude-haiku-5-5 --card-model claude-haiku-5-5 --reader-model claude-haiku-5-5 \
  --source-profile packages/sim/lab/before-after/market-profiles/direct.json --push payload \
  --spend-ledger "$ROOT/.local/b18/ledger.jsonl" --spend-cap 15 --spend-headroom 0.1 --run-label "$L" \
  --timeline "$R/$L.tl" --out "$R/$L.json" "$@"
