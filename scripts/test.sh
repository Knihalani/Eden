#!/usr/bin/env bash
# Runs every test in the workspace (CI step 3), or those under the directories given (`scripts/test.sh packages/llm`;
# scripts/test-select.ts passes them for `test:changed` and `test:pkg`). Discovered, not listed: a new package is picked
# up automatically. archived/ is excluded; it is history and does not build under this workspace. Arguments that are
# not directories go to `bun test`.
#
# Files run in parallel, one worker per core (`bun test --parallel`, which implies --isolate: each file gets a fresh
# global, and each worker loads scripts/test-preload.ts, so every worker has its own temp HOME). Measured on a 4-core
# container: 32.3 s serial, about 20 s parallel (docs/TESTING.md). TEST_SERIAL=1 runs in one process, as before; a
# Bun without --parallel does too.
set -euo pipefail
cd "$(dirname "$0")/.."

roots=()
pass=()
for a in "$@"; do
  if [ -d "$a" ]; then roots+=("${a%/}"); else pass+=("$a"); fi
done
if [ ${#roots[@]} -eq 0 ]; then
  for d in packages examples scripts; do [ -d "$d" ] && roots+=("$d"); done
fi
tests=$(
  find "${roots[@]}" \( -name '*.test.ts' -o -name '*.test.tsx' \) -print |
    grep -v '/node_modules/' | sort | sed 's|^|./|' || true
)
if [ -z "$tests" ]; then
  echo "no test files found under ${roots[*]} — check the discovery glob in scripts/test.sh" >&2
  exit 1
fi

parallel=()
count=$(echo "$tests" | wc -l)
if [ "${TEST_SERIAL:-}" != "1" ] && [ "$count" -gt 1 ] && bun test --help 2>&1 | grep -q -- '--parallel='; then
  parallel=(--parallel)
fi

# Isolate HOME for child processes too; scripts/test-preload.ts does the same in-process.
home=$(mktemp -d "${TMPDIR:-/tmp}/eden-test-XXXXXX")
trap 'rm -rf "$home"' EXIT
# shellcheck disable=SC2086 # one argument per file
HOME="$home" EDEN_HOME="$home/.eden" bun test ${parallel[@]+"${parallel[@]}"} $tests ${pass[@]+"${pass[@]}"}
