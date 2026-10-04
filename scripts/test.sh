#!/usr/bin/env bash
# Runs every test in the workspace.
#
# The suite is discovered rather than listed. Three hand-maintained lists (the
# `test` script, `test:legacy`, and the CI workflow) had already drifted apart
# far enough that CI was running a third of the tests and none of the packages
# under active development. A new package is now picked up automatically.
#
# `archived/` is excluded deliberately: it is a retired Python/Playwright tree
# whose files do not parse under the current toolchain.
set -euo pipefail
cd "$(dirname "$0")/.."

# Kept POSIX-ish: macOS still ships bash 3.2, which has no `mapfile`.
# bun test treats a bare `src` argument as a substring filter (packages/*/src).
# Root memory tests must be passed as files.
src_tests=$(
  find src -maxdepth 1 \( -name '*.test.ts' -o -name '*.test.tsx' \) -print 2>/dev/null \
    | sort
)
# Tests of the repo's own tooling (scripts/*.test.ts), passed as files for the
# same reason: a bare `scripts` argument would match any path containing it.
script_tests=$(find scripts -maxdepth 1 -name '*.test.ts' -print | sort)
pkg_tests=$(
  find packages apps benchmarks \( -name '*.test.ts' -o -name '*.test.tsx' \) -print \
    | grep -v '/node_modules/' \
    | sort
)
dirs=$(printf '%s\n' "$pkg_tests" | sed 's|/[^/]*$||' | sort -u)

if [ -z "$dirs" ] && [ -z "${src_tests:-}" ]; then
  echo "no test files found — check the discovery glob in scripts/test.sh" >&2
  exit 1
fi

echo "test dirs:" $dirs
echo "src tests:" $src_tests
echo "script tests:" $script_tests

# EDEN_TEST_SHARD=k/N runs the k-th of N slices of the test files, so CI can spread the suite
# over parallel jobs. scripts/test-shard.ts deals the files out by their measured times
# (scripts/test-times.txt); bun's own --shard deals them in path order, which put the slowest
# files together. The python tests run in slice 1 only. Read here, before the EDEN_* variables
# are cleared below.
shard=""
run_python=1
if [ -n "${EDEN_TEST_SHARD:-}" ]; then
  case "$EDEN_TEST_SHARD" in
    [1-9]*/[1-9]*) ;;
    *)
      echo "EDEN_TEST_SHARD must look like k/N, got: $EDEN_TEST_SHARD" >&2
      exit 1
      ;;
  esac
  shard="$EDEN_TEST_SHARD"
  [ "${EDEN_TEST_SHARD%%/*}" = "1" ] || run_python=0
  echo "test shard: $EDEN_TEST_SHARD"
fi

# Quarantined test files are skipped, not deleted: each one has a tracking
# issue in scripts/test-quarantine.txt, and un-quarantining is deleting its
# line. Tests quarantined individually use test.failing() in their own file.
quarantined=$(awk '!/^#/ && NF { print $1 }' scripts/test-quarantine.txt)
ignore=""
for f in $quarantined; do
  [ -f "$f" ] || { echo "scripts/test-quarantine.txt lists a missing file: $f" >&2; exit 1; }
  ignore="$ignore --path-ignore-patterns=$f"
done
echo "quarantined files:" $quarantined

# A slice ignores the files dealt to the other slices. bun still discovers the suite, so a test
# file the shard script was not given runs in every slice rather than in none.
if [ -n "$shard" ]; then
  others=$(printf '%s\n' "$pkg_tests" "$src_tests" "$script_tests" | bun scripts/test-shard.ts "$shard")
  for f in $others; do
    ignore="$ignore --path-ignore-patterns=$f"
  done
fi

# Tests must never touch the real ~/.eden (issue #67). Test files restore the
# EDEN_HOME they found, and bunfig.toml's preload (scripts/test-preload.ts)
# gives each bun test process its own HOME and EDEN_HOME. This is one more
# layer: the whole run, python tests included, gets a throwaway HOME, removed
# on exit. EDEN_* variables from the calling shell are cleared too, so none can
# point a test at a real store. Both match CI, which has no ~/.eden and sets no
# EDEN_* variable.
test_home=$(mktemp -d "${TMPDIR:-/tmp}/eden-test-home.XXXXXX")
trap 'rm -rf "$test_home"' EXIT
export HOME="$test_home"
for var in $(compgen -e | awk '/^EDEN_/'); do
  unset "$var"
done
echo "test HOME: $HOME"

# Python SDK tests live under packages/sdk-py. bun's discovery only finds
# *.test.ts, so run them here when python3 exists; environments without
# python3 skip quietly and stay green.
if [ "$run_python" = 1 ] && command -v python3 >/dev/null 2>&1; then
  echo "python tests: packages/sdk-py"
  python3 -m unittest discover -s packages/sdk-py/tests || {
    echo "python tests failed" >&2
    exit 1
  }
fi

# Not exec: the EXIT trap has to run to remove the throwaway HOME. set -e still
# makes bun's exit status the script's.
# shellcheck disable=SC2086 # word splitting is intended: one argument per dir/file
bun test "$@" $ignore $dirs $src_tests $script_tests
