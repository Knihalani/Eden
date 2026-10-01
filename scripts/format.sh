#!/usr/bin/env bash
# Formats the code under the formatter, or checks it with --check (CI).
#
# The whatever loop joined lines to pass a net-line-deletion rule: src/index.ts
# went from 1,444 to 379 lines, its longest 1,001 characters. R-5 put Prettier
# (.prettierrc.json) on the files that loop touched, so every later diff in
# them stays reviewable; its follow-up extended it to all live code.
#
# `prettier --check` alone lets long lines through: Prettier never breaks a
# comment or a literal. scripts/check-line-length.ts closes that gap.
#
# Kept to bash 3.2 (macOS), like the other scripts: no mapfile.
set -euo pipefail
cd "$(dirname "$0")/.."

# Every tracked JS/TS file except two trees that are history, not code under
# development: archived/ (a retired product) and .whatever*/ (the parked
# optimizer's benches and logs). Tracked only, so an untracked scratch file is
# never rewritten or checked.
files=$(
  git ls-files -- '*.ts' '*.tsx' '*.mts' '*.cts' '*.js' '*.mjs' '*.cjs' |
    grep -v -E '^(archived|\.whatever[^/]*)/'
)
prettier=node_modules/.bin/prettier

# shellcheck disable=SC2086 # one argument per file; tracked paths have no spaces
if [ "${1:-}" = "--check" ]; then
  # Run both checks even if the first fails, so one run lists every problem.
  status=0
  $prettier --check $files || status=1
  bun scripts/check-line-length.ts $files || status=1
  exit $status
fi
$prettier --write --log-level warn $files
