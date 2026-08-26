#!/usr/bin/env bash
# Run the full 10-POC suite: benchmarks then test files.
set -e
cd "$(dirname "$0")/../.."
echo "════════════════════════════════════════════════"
echo " Eden 10x POC suite — $(date '+%Y-%m-%d %H:%M')"
echo "════════════════════════════════════════════════"
for f in benchmarks/poc/poc1-cold-start.ts \
         benchmarks/poc/poc2-hot-path.ts \
         benchmarks/poc/poc3-speculative.ts \
         benchmarks/poc/poc4-etags.ts \
         benchmarks/poc/poc5-prompt-cache.ts \
         benchmarks/poc/pocA-shared-cache.ts \
         benchmarks/poc/pocB-compile-speed.ts \
         benchmarks/poc/pocF-billing-bytes.ts \
         benchmarks/poc/pocG-cache-fill.ts \
         benchmarks/poc/pocI-import-fidelity.ts \
         benchmarks/poc/pocJ-predictive-warming.ts; do
  bun run "$f"
done
bun test benchmarks/poc/poc6-hooks.test.ts \
         benchmarks/poc/poc8-selfheal.test.ts \
         benchmarks/poc/pocC-islands.test.ts
