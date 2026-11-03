#!/usr/bin/env bash
# Formats the code, or checks it with --check (CI step 1).
#
# `prettier --check` alone lets long lines through: Prettier never breaks a comment or a literal.
# scripts/check-line-length.ts closes that gap. archived/ is history, not code under development.
set -euo pipefail
cd "$(dirname "$0")/.."

files=$(
  git ls-files --cached --others --exclude-standard -- '*.ts' '*.tsx' '*.mts' '*.js' '*.mjs' |
    grep -v -E '^archived/'
)
prettier=node_modules/.bin/prettier

# Prettier's cache skips a file whose content (not mtime, which checkouts reset) is unchanged since a run that found
# it formatted; the cache key also covers the Prettier version and options. It lives under the gitignored
# node_modules/.cache. CHECK_COLD=1 drops it, for a final run that trusts nothing from an earlier one.
cache=(--cache --cache-strategy content --cache-location node_modules/.cache/prettier/.prettier-cache)
if [ "${CHECK_COLD:-}" = "1" ]; then
  cache=()
fi

# shellcheck disable=SC2086 # one argument per file; tracked paths have no spaces
if [ "${1:-}" = "--check" ]; then
  status=0
  $prettier ${cache[@]+"${cache[@]}"} --check $files || status=1
  # Uncached and over every file, so an overlong comment is caught however warm Prettier's cache is.
  bun scripts/check-line-length.ts $files || status=1
  exit $status
fi
$prettier ${cache[@]+"${cache[@]}"} --write --log-level warn $files
