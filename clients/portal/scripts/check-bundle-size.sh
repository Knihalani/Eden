#!/usr/bin/env bash
# ponytail: bundle-size budget gate. Fails CI if any single client
# chunk exceeds the per-chunk or total-byte thresholds.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHUNKS_DIR="$ROOT/.next/static/chunks"

if [ ! -d "$CHUNKS_DIR" ]; then
  echo "→ no .next/static/chunks found — run 'bun run build' first."
  exit 1
fi

# Per-chunk ceiling. Anything bigger is a signal to investigate.
PER_CHUNK_MAX_BYTES=$((500 * 1024))   # 500 KB per chunk
# Total payload ceiling for all client-side JS. 6 MB ≈ current baseline
# (matches the prompt-100 prompt's "establish budgets based on current baseline").
TOTAL_MAX_BYTES=$((6 * 1024 * 1024)) # 6 MB total

LARGEST=0
LARGEST_FILE=""
TOTAL=0
for f in "$CHUNKS_DIR"/*.js "$CHUNKS_DIR"/*.css; do
  [ -e "$f" ] || continue
  size=$(wc -c < "$f" | tr -d ' ')
  TOTAL=$((TOTAL + size))
  if [ "$size" -gt "$LARGEST" ]; then
    LARGEST=$size
    LARGEST_FILE="$f"
  fi
done

LARGEST_KB=$((LARGEST / 1024))
TOTAL_MB=$((TOTAL / 1024 / 1024))
echo "→ largest chunk: $(basename "$LARGEST_FILE") = ${LARGEST_KB} KB (max $((PER_CHUNK_MAX_BYTES / 1024)) KB)"
echo "→ total payload : ${TOTAL_MB} MB (max $((TOTAL_MAX_BYTES / 1024 / 1024)) MB)"

if [ "$LARGEST" -gt "$PER_CHUNK_MAX_BYTES" ]; then
  echo "✗ FAILED: largest chunk ${LARGEST_KB} KB > $((PER_CHUNK_MAX_BYTES / 1024)) KB"
  exit 1
fi
if [ "$TOTAL" -gt "$TOTAL_MAX_BYTES" ]; then
  echo "✗ FAILED: total payload ${TOTAL_MB} MB > $((TOTAL_MAX_BYTES / 1024 / 1024)) MB"
  exit 1
fi
echo "✓ bundle-size budgets OK"
