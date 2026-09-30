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
dirs=$(
  find packages apps benchmarks \( -name '*.test.ts' -o -name '*.test.tsx' \) -print \
    | grep -v '/node_modules/' \
    | sed 's|/[^/]*$||' \
    | sort -u
)

if [ -z "$dirs" ] && [ -z "${src_tests:-}" ]; then
  echo "no test files found — check the discovery glob in scripts/test.sh" >&2
  exit 1
fi

echo "test dirs:" $dirs
echo "src tests:" $src_tests

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

# Tests must never touch the real ~/.eden. Many test files restore EDEN_HOME by
# deleting it, after which edenHome() falls back to $HOME/.eden, so the whole
# run gets a throwaway HOME. It also matches CI, whose HOME has no ~/.eden.
HOME=$(mktemp -d "${TMPDIR:-/tmp}/eden-test-home.XXXXXX")
export HOME
echo "test HOME: $HOME"

# Python SDK tests live under packages/sdk-py. bun's discovery only finds
# *.test.ts, so run them here when python3 exists; environments without
# python3 skip quietly and stay green.
if command -v python3 >/dev/null 2>&1; then
  echo "python tests: packages/sdk-py"
  python3 -m unittest discover -s packages/sdk-py/tests || {
    echo "python tests failed" >&2
    exit 1
  }
fi

# shellcheck disable=SC2086 # word splitting is intended: one argument per dir/file
exec bun test "$@" $ignore $dirs $src_tests
