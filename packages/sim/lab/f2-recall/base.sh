#!/bin/bash
# F2: one funnel process with the live check and its dump.   SUITE SEED
set -euo pipefail
cd "$(dirname "$0")/../../../.."
mkdir -p .local/f2/base
s=$1; n=$2; d=.local/f2/base
env -u OPENROUTER_API_KEY timeout 3600 bun run funnel --suite $s --seeds $n --jobs 1 -- --neutral --check live \
  --check-cache $d/$s-$n.cache.jsonl --check-dump $d/$s-$n.dump.jsonl --spend-ledger .local/f2/ledger.jsonl \
  --spend-cap 40 --run-label f2-base --json $d/$s-$n.json > $d/$s-$n.log 2>&1
