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
dirs=$(
  find packages apps \( -name '*.test.ts' -o -name '*.test.tsx' \) -print \
    | grep -v '/node_modules/' \
    | sed 's|/[^/]*$||' \
    | sort -u
)

if [ -z "$dirs" ]; then
  echo "no test files found — check the discovery glob in scripts/test.sh" >&2
  exit 1
fi

echo "test dirs:" $dirs

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

# shellcheck disable=SC2086 # word splitting is intended: one argument per dir
exec bun test "$@" $dirs
