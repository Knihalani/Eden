#!/usr/bin/env bash
# M10: one funnel arm, its score line and neutral line. Usage: arm.sh SUITES SEEDS NAME [funnel args...]
set -euo pipefail
unset OPENROUTER_API_KEY
S=$1; SEEDS=$2; NAME=$3; shift 3
# train5 and train6 are M10's held-out families: read once, by the parent session, for the bar.
if [[ "$S" == *train5* || "$S" == *train6* ]] && [[ "${M10_HELDOUT:-}" != "1" ]]; then
  echo "arm.sh: train5/train6 are held out (M10_HELDOUT=1 for the one read)" >&2
  exit 2
fi
mkdir -p .local/m10/arms
bun run funnel --suite "$S" --seeds "$SEEDS" "$@" --json ".local/m10/arms/$NAME.json" -- --neutral > ".local/m10/arms/$NAME.log" 2>&1
echo "$NAME $(grep -E '^  TOTAL +hidden [0-9]+/[0-9]+ +decoys' ".local/m10/arms/$NAME.log" | sed 's/  */ /g') | $(grep 'merged NEUTRAL TOTAL' ".local/m10/arms/$NAME.log" | sed 's/; ask.*//;s/merged NEUTRAL TOTAL: //')"
