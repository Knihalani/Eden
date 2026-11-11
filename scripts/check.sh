#!/usr/bin/env bash
# The gate (`bun run check`; `CHECK_COLD=1 bun run check` before every merge, D657): format:check, typecheck and the
# tests. The three run at once (D811): the formatter and the checker are single processes beside a test run of one
# worker per core, so one after another left cores idle (83-85 s on 4 cores, 2026-11-11; 63-64 s at once, with the
# test changes of D811). Not under `nice`: on a quiet machine it gained nothing, and on one loaded by other work it
# left the two behind that work (204 s against 92 s with four busy loops running). The tests print as they run;
# format:check's and typecheck's output follows, whole. The gate fails when any step does. CHECK_SERIAL=1 runs them
# one after another, as before.
set -uo pipefail
cd "$(dirname "$0")/.."

steps=(format:check typecheck test)
if [ "${CHECK_SERIAL:-}" = "1" ]; then
  for s in "${steps[@]}"; do bun run "$s" || exit 1; done
  exit 0
fi

out=$(mktemp -d "${TMPDIR:-/tmp}/eden-check-XXXXXX")
trap 'rm -rf "$out"' EXIT
start=$(date +%s)
pids=()
for s in format:check typecheck; do
  (
    bun run "$s" >"$out/$s.log" 2>&1
    echo $? >"$out/$s.status"
  ) &
  pids+=($!)
done
status=0
bun run test || status=1
wait "${pids[@]}"

for s in format:check typecheck; do
  code=$(cat "$out/$s.status" 2>/dev/null || echo 1)
  echo "════ $s (exit $code)"
  cat "$out/$s.log"
  [ "$code" = 0 ] || status=1
done
echo "════ check: $([ $status = 0 ] && echo passed || echo FAILED) in $(($(date +%s) - start)) s"
exit $status
