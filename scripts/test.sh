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
#
# A file that already passed on exactly the inputs it has now is skipped (scripts/test-cache.ts, D650: the file, what it
# imports, the lockfile and configuration; the whole tree for a file that spawns or reads the repository). The run
# prints how many were skipped. CHECK_COLD=1 or TEST_CACHE=0 runs every file; so does any argument for `bun test`
# (a name filter would otherwise record a partial run as a pass).
set -euo pipefail
cd "$(dirname "$0")/.."

roots=()
pass=()
ignore=()
for a in "$@"; do
  if [ -d "$a" ]; then
    roots+=("${a%/}")
  elif [[ "$a" == --path-ignore-patterns=* ]]; then
    # scripts/test-select.ts defers whole files this way (D161): dropped from the list here, so the cache still applies.
    ignore+=("$a")
  else
    pass+=("$a")
  fi
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
for i in ${ignore[@]+"${ignore[@]}"}; do
  tests=$(echo "$tests" | grep -vxF "./${i#--path-ignore-patterns=}" || true)
done

# Isolate HOME for child processes too; scripts/test-preload.ts does the same in-process.
home=$(mktemp -d "${TMPDIR:-/tmp}/eden-test-XXXXXX")
trap 'rm -rf "$home"' EXIT

cache=()
if [ "${CHECK_COLD:-}" != "1" ] && [ "${TEST_CACHE:-1}" != "0" ] && [ ${#pass[@]} -eq 0 ]; then
  # shellcheck disable=SC2086 # one argument per file
  if planned=$(bun scripts/test-cache.ts plan "$home/cache-state.json" $tests); then
    tests=$planned
    cache=(--reporter=junit "--reporter-outfile=$home/junit.xml")
    if [ -z "$tests" ]; then exit 0; fi
  fi
fi

parallel=()
count=$(echo "$tests" | wc -l)
if [ "${TEST_SERIAL:-}" != "1" ] && [ "$count" -gt 1 ] && bun test --help 2>&1 | grep -q -- '--parallel='; then
  parallel=(--parallel)
fi

status=0
# shellcheck disable=SC2086 # one argument per file
HOME="$home" EDEN_HOME="$home/.eden" bun test ${parallel[@]+"${parallel[@]}"} ${cache[@]+"${cache[@]}"} \
  $tests ${pass[@]+"${pass[@]}"} || status=$?
# Files that passed are recorded even when another failed, so the next run is the failures and what changed.
if [ ${#cache[@]} -gt 0 ]; then bun scripts/test-cache.ts record "$home/cache-state.json" "$home/junit.xml" || true; fi
exit $status
