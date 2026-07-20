#!/usr/bin/env bash
# ponytail: bundle-size budget gate (K43). Fails CI if any single client
# chunk exceeds the per-chunk or total-byte thresholds.
# Recurses under .next/static/chunks (incl. nested app/ route chunks).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHUNKS_DIR="$ROOT/.next/static/chunks"

if [ ! -d "$CHUNKS_DIR" ]; then
  echo "→ no .next/static/chunks found — run 'bun run build' first."
  exit 1
fi

# Tightened ceilings (A10 / coord A3). Largest observed ~327 KB; total ~6 MB.
PER_CHUNK_MAX_BYTES=$((400 * 1024))   # 400 KB per chunk (was 500 KB)
TOTAL_MAX_BYTES=$((6 * 1024 * 1024))  # 6 MB total

LARGEST=0
LARGEST_FILE=""
TOTAL=0
OVERSIZED=0

# Recurse: Next may nest chunks under app/ or other subdirs.
while IFS= read -r -d '' f; do
  size=$(wc -c < "$f" | tr -d ' ')
  TOTAL=$((TOTAL + size))
  if [ "$size" -gt "$LARGEST" ]; then
    LARGEST=$size
    LARGEST_FILE="$f"
  fi
  if [ "$size" -gt "$PER_CHUNK_MAX_BYTES" ]; then
    OVERSIZED=$((OVERSIZED + 1))
    echo "✗ oversized: ${f#"$CHUNKS_DIR"/} = $((size / 1024)) KB"
  fi
done < <(find "$CHUNKS_DIR" \( -name '*.js' -o -name '*.css' \) -type f -print0)

if [ "$TOTAL" -eq 0 ] || [ -z "$LARGEST_FILE" ]; then
  echo "→ no JS/CSS chunks found under $CHUNKS_DIR"
  exit 1
fi

LARGEST_KB=$((LARGEST / 1024))
# Fractional MB (e.g. 5.95) via awk — integer division previously printed "5 MB".
TOTAL_MB=$(awk -v t="$TOTAL" 'BEGIN { printf "%.2f", t / 1024 / 1024 }')
echo "→ largest chunk: ${LARGEST_FILE#"$CHUNKS_DIR"/} = ${LARGEST_KB} KB (max $((PER_CHUNK_MAX_BYTES / 1024)) KB)"
echo "→ total payload : ${TOTAL_MB} MB (max $((TOTAL_MAX_BYTES / 1024 / 1024)) MB)"
echo "→ files scanned : recursive under chunks/"

if [ "$OVERSIZED" -gt 0 ]; then
  echo "✗ FAILED: $OVERSIZED chunk(s) exceed $((PER_CHUNK_MAX_BYTES / 1024)) KB"
  exit 1
fi
if [ "$LARGEST" -gt "$PER_CHUNK_MAX_BYTES" ]; then
  echo "✗ FAILED: largest chunk ${LARGEST_KB} KB > $((PER_CHUNK_MAX_BYTES / 1024)) KB"
  exit 1
fi
if [ "$TOTAL" -gt "$TOTAL_MAX_BYTES" ]; then
  echo "✗ FAILED: total payload ${TOTAL_MB} MB > $((TOTAL_MAX_BYTES / 1024 / 1024)) MB"
  exit 1
fi
echo "✓ bundle-size budgets OK"
