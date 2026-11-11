#!/usr/bin/env bash
# M11: the funnel's arms for one expansion file (lab only, $0). Usage: arms.sh NAME EXP.json [SUITES]
# Writes .local/m11/f/NAME-{1,2}.json (intentMicro 1: every item, no requests from the calls; 2: where none) and
# prints hidden/decoys per suite and the neutral packets from funnel-arms.py.
set -euo pipefail
unset OPENROUTER_API_KEY
name=$1; exp=$2; suites=${3:-train}
mkdir -p .local/m11/f
for m in 1 2; do
  bun run funnel --jobs 4 --suite "$suites" --json ".local/m11/f/$name-$m.json" --set "{\"intentMicro\":$m}" \
    -- --neutral --micro "$exp" > ".local/m11/f/$name-$m.log" 2>&1
done
python3 -I packages/sim/lab/m11/funnel_arms.py ".local/m11/f/base-$suites.json" ".local/m11/f/$name-1.json" ".local/m11/f/$name-2.json"
