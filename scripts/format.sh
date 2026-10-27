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

# shellcheck disable=SC2086 # one argument per file; tracked paths have no spaces
if [ "${1:-}" = "--check" ]; then
  status=0
  $prettier --check $files || status=1
  bun scripts/check-line-length.ts $files || status=1
  exit $status
fi
$prettier --write --log-level warn $files
