#!/usr/bin/env bash
# Runs every test in the workspace (CI step 3), or those under the directories given (`scripts/test.sh packages/llm`;
# scripts/test-select.ts passes them for `test:changed` and `test:pkg`). Discovered, not listed: a new package is picked
# up automatically. archived/ is excluded; it is history and does not build under this workspace. Arguments that are
# not directories go to `bun test`.
#
# Files run in parallel, one worker per core (`bun test --parallel`, which implies --isolate: each file gets a fresh
# global, and each worker loads scripts/test-preload.ts, so every worker has its own temp HOME). Measured on a 4-core
# container: 32.3 s serial, about 20 s parallel (docs/TESTING.md). TEST_SERIAL=1 runs each part (the main run, then
# the tail below) in one process; a Bun without --parallel does too.
#
# Files listed in scripts/test-tail.txt (D811) run after the rest, eight at a time, on a machine nothing else is
# loading: they wait on real time (a deadline, a sleeping connector, a child process) and assert on it, so the CPU
# contention of the main run made them flaky, and in the main run they held a worker while doing nothing. The main run
# starts the slowest files first (`bun test --timings`, from the last run's durations, kept beside the other caches
# under the git common dir: an order, never a result). In the main run a test gets `TEST_TIMEOUT_MS` (120 s) unless it
# names its own: a per-test limit is there to catch a hang, and Bun's 5 s default failed CPU-bound tests under
# parallel load (weak-points-1111.md R1), as 20 s did at load 18-36 (long-reply.test.ts's 3 s fuzz tests at 21-32 s,
# D1945) and 60 s did for render-fast, opt-round3 and test-cache at load 10-35 (D1965). A test names a limit of its
# own to wait longer, never a shorter one to catch slowness: that is the CPU bounds' and work counts' job. The tail
# keeps Bun's 5 s (`TEST_TAIL_TIMEOUT_MS`): its deadline tests that
# assert nothing about time relied on it to fail a deadline not honoured, and it runs unloaded. The run ends with the
# slowest files and every test over 3.5 s (scripts/test-report.ts), so a test that grows slow still shows. Arguments
# for `bun test` (a name filter, `-t X`) run everything in one invocation: a filter that matches tests of only one part
# would fail the other ("matched 0 tests").
#
# A file that already passed on exactly the inputs it has now is skipped (scripts/test-cache.ts, D650: the file, what it
# imports, the lockfile and configuration; the whole tree for a file that spawns or reads the repository). The run
# prints how many were skipped. For the loop only: the merge gate is CHECK_COLD=1 (D657). CHECK_COLD=1 or TEST_CACHE=0
# runs every file; so does any argument for `bun test`
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

cached=0
if [ "${CHECK_COLD:-}" != "1" ] && [ "${TEST_CACHE:-1}" != "0" ] && [ ${#pass[@]} -eq 0 ]; then
  # shellcheck disable=SC2086 # one argument per file
  if planned=$(bun scripts/test-cache.ts plan "$home/cache-state.json" $tests); then
    tests=$planned
    cached=1
    if [ -z "$tests" ]; then exit 0; fi
  fi
fi

# The tail: listed files among those selected (comments and blank lines in the list are skipped).
tail_list=$(grep -v -E '^\s*(#|$)' scripts/test-tail.txt | sed 's|^|./|' || true)
tail_tests=$(grep -x -F -f <(echo "$tail_list") <<<"$tests" || true)
main_tests=$(grep -v -x -F -f <(echo "$tail_list") <<<"$tests" || true)
if [ ${#pass[@]} -gt 0 ]; then
  main_tests=$tests
  tail_tests=
fi

has_parallel=0
if [ "${TEST_SERIAL:-}" != "1" ] && bun test --help 2>&1 | grep -q -- '--parallel='; then has_parallel=1; fi
timings=
if [ "$has_parallel" = 1 ] && bun test --help 2>&1 | grep -q -- '--timings='; then
  if common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) &&
    mkdir -p "$common/eden-check-cache" 2>/dev/null; then
    timings=$common/eden-check-cache/test-timings.json
    # Bun refuses a file of any other shape and stops the run: a missing, torn or foreign one starts empty (files in
    # path order). Bun's own writes are atomic (a temp file renamed).
    bun -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (j.version !== 1 || typeof j.files !== "object") process.exit(1)' "$timings" 2>/dev/null ||
      echo '{"version":1,"files":{}}' >"$timings"
  fi
fi

status=0
# run NAME FILES JOBS TIMEOUT: one `bun test` over FILES, its junit report at $home/NAME.xml.
run() {
  local files=$2 jobs=$3 timeout=$4 opts=()
  [ -n "$files" ] || return 0
  if [ "$has_parallel" = 1 ] && [ "$(echo "$files" | wc -l)" -gt 1 ]; then
    opts=("--parallel=$jobs")
    if [ -n "$timings" ]; then opts+=("--timings=$timings" --update-timings); fi
  fi
  # shellcheck disable=SC2086 # one argument per file
  HOME="$home" EDEN_HOME="$home/.eden" bun test ${opts[@]+"${opts[@]}"} "--timeout=$timeout" \
    --reporter=junit "--reporter-outfile=$home/$1.xml" $files ${pass[@]+"${pass[@]}"} || status=$?
}
cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)
run main "$main_tests" "$cores" "${TEST_TIMEOUT_MS:-120000}"
[ -z "$tail_tests" ] || echo "── the tail (scripts/test-tail.txt): files that wait on real time, after the rest"
run tail "$tail_tests" "${TEST_TAIL_JOBS:-8}" "${TEST_TAIL_TIMEOUT_MS:-5000}"
bun scripts/test-report.ts "$home/main.xml" "$home/tail.xml" || true
# Files that passed are recorded even when another failed, so the next run is the failures and what changed.
if [ "$cached" = 1 ]; then
  for x in main tail; do bun scripts/test-cache.ts record "$home/cache-state.json" "$home/$x.xml" || true; done
fi
exit $status
