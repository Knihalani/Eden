#!/bin/bash
# qrun.sh NAME LOST CONFIG [extra flags]: quality-cli (stale and deleted deliveries), 16 users x 20 sessions, connector
# 5% of connectors notifying, signal-only notices. A cap of 300 items (in CONFIG) cuts the five sources' copies, as F1's runs did, so
# lookups search them live; report with packages/sim/lab/f1/fresh.py.
cd "$(dirname "$0")/../../../.." || exit 1
unset BUN_OPTIONS
name=$1; lost=$2; cfg=$3; shift 3
mkdir -p .local/n1
bun packages/sim/src/quality-cli.ts --users 16 --sessions 20 --updates 0.6 --deletes 0.1 --jobs 4 --push signals \
  --notify-share 0.05 --lost-notices "$lost" --config "$cfg" "$@" > .local/n1/q-$name.json \
  2> .local/n1/q-$name.err || echo "FAILED $name"
