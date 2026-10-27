#!/usr/bin/env bash
# Runs every test in the workspace (CI step 3). Discovered, not listed: a new package is picked up
# automatically. archived/ is excluded; it is history and does not build under this workspace.
set -euo pipefail
cd "$(dirname "$0")/.."

roots=$(for d in packages examples scripts; do [ -d "$d" ] && echo "$d"; done)
# shellcheck disable=SC2086 # one argument per root
tests=$(
  find $roots \( -name '*.test.ts' -o -name '*.test.tsx' \) -print |
    grep -v '/node_modules/' | sort | sed 's|^|./|'
)
if [ -z "$tests" ]; then
  echo "no test files found — check the discovery glob in scripts/test.sh" >&2
  exit 1
fi

# Isolate HOME for child processes too; scripts/test-preload.ts does the same in-process.
home=$(mktemp -d "${TMPDIR:-/tmp}/eden-test-XXXXXX")
trap 'rm -rf "$home"' EXIT
# shellcheck disable=SC2086 # one argument per file
HOME="$home" EDEN_HOME="$home/.eden" bun test $tests "$@"
