#!/usr/bin/env bash
# Runs CI's test step locally, in parallel: the six slices CI's test jobs run (EDEN_TEST_SHARD=k/6, dealt by
# scripts/test-shard.ts from scripts/test-times.txt), as six processes at once. It runs the same files as
# `bun run test`, in about the time of the slowest slice instead of the sum.
#
#   ./scripts/test-parallel.sh [N]    N slices, default 6 (CI's count)
#
# Each slice's log is kept in a temp directory, printed at the end; a failing slice's tail is shown.
# Kept to bash 3.2 (macOS), like the other scripts.
set -uo pipefail
cd "$(dirname "$0")/.."

n="${1:-6}"
logs=$(mktemp -d "${TMPDIR:-/tmp}/eden-test-parallel.XXXXXX")
started=$(date +%s)

pids=()
for k in $(seq 1 "$n"); do
  EDEN_TEST_SHARD="$k/$n" ./scripts/test.sh >"$logs/slice-$k.log" 2>&1 &
  pids+=("$!")
done

status=0
pass=0
skip=0
fail=0
for k in $(seq 1 "$n"); do
  if wait "${pids[$((k - 1))]}"; then result=pass; else result=FAIL; status=1; fi
  log="$logs/slice-$k.log"
  counts=$(awk '/^ *[0-9]+ (pass|skip|fail)$/ { printf "%s %s, ", $1, $2 } /^Ran / { printf "%s", $0 }' "$log")
  echo "slice $k/$n: $result: $counts"
  pass=$((pass + $(awk '/^ *[0-9]+ pass$/ { s += $1 } END { print s + 0 }' "$log")))
  skip=$((skip + $(awk '/^ *[0-9]+ skip$/ { s += $1 } END { print s + 0 }' "$log")))
  fail=$((fail + $(awk '/^ *[0-9]+ fail$/ { s += $1 } END { print s + 0 }' "$log")))
  if [ "$result" = FAIL ]; then
    echo "---- last lines of slice $k ----"
    tail -40 "$log"
  fi
done

echo "all slices: $pass pass, $skip skip, $fail fail; $(($(date +%s) - started)) s; logs in $logs"
exit "$status"
