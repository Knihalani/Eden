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

# The known-formatted set: one `<blob id> <path>` line per file content that Prettier found formatted, so a later run
# hands Prettier only the files whose content (or path, which picks the parser) it has not seen. Prettier's own
# --cache cannot do this across checkouts: it keys absolute paths, so every new git worktree started cold (13 s).
# The set lives under the git common dir, which every worktree of the repo shares, in a file named by a key over
# everything else that decides the result: the Prettier version and every Prettier config, ignore, .editorconfig
# and package.json file (package.json may hold a "prettier" key). Content is hashed from the working tree, raw
# (--no-filters), so unstaged edits count. Writes go to a temp file renamed into place: worktrees that check at once
# can lose each other's additions (a later run re-checks those), never corrupt the set. CHECK_COLD=1 neither reads
# nor writes it, for a final run that trusts nothing from an earlier one. Any failure here falls back to checking
# every file.

# shared_set: the set's path for this checkout, creating its directory; fails when anything is missing.
shared_set() {
  local common version configs key
  common=$(git rev-parse --path-format=absolute --git-common-dir) || return 1
  version=$(sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' node_modules/prettier/package.json) || return 1
  [ -n "$version" ] || return 1
  configs=$(
    git ls-files --cached --others --exclude-standard |
      grep -E '(^|/)(\.prettierrc[^/]*|prettier\.config\.[^/]*|\.prettierignore|\.editorconfig|package\.json)$' |
      grep -v -E '^archived/'
  ) || return 1
  key=$(
    echo "prettier $version"
    paste -d' ' <(git hash-object --no-filters --stdin-paths <<<"$configs") <(echo "$configs")
  ) || return 1
  key=$(git hash-object --stdin <<<"$key") || return 1
  mkdir -p "$common/eden-check-cache" || return 1
  # Sets for an old key (another Prettier or config) and temp files a killed run left behind.
  find "$common/eden-check-cache" -type f -mtime +14 -delete || true
  echo "$common/eden-check-cache/prettier-$key"
}

# entries PATHS: each path (one per line) as `<blob id> <path>`, hashed from the working tree.
entries() {
  paste -d' ' <(git hash-object --no-filters --stdin-paths <<<"$1") <(echo "$1")
}

set_file=
known=
if [ "${CHECK_COLD:-}" != "1" ]; then
  set_file=$(shared_set 2>/dev/null) || set_file=
fi
if [ -n "$set_file" ]; then
  current=$(entries "$files" 2>/dev/null) || set_file=
fi
todo=$files
if [ -n "$set_file" ]; then
  # Only well-formed lines are trusted; the rest are files Prettier has not passed in this configuration.
  known=$(grep -E '^[0-9a-f]{40,64} [^ ]+$' "$set_file" 2>/dev/null) || known=
  if unknown=$(grep -v -x -F -f <(echo "$known") <<<"$current"); then
    todo=$(cut -d' ' -f2- <<<"$unknown")
  elif [ $? = 1 ]; then
    todo= # grep's "no line left": every file is known
  fi
fi

# remember OUTPUT: adds the files Prettier just passed to the set: all of $todo less any path its OUTPUT names (a
# file --check found unformatted), re-hashed now so --write records the formatted content.
remember() {
  [ -n "$set_file" ] && [ -n "$todo" ] || return 0
  {
    local named passed tmp
    named=$(sed -n -E 's/^\[(warn|error)\] ([^ :]+).*/\2/p' <<<"$1")
    passed=$(grep -v -x -F -f <(echo "$named") <<<"$todo") || return 0
    tmp=$(mktemp "$set_file.tmp.XXXXXX") || return 0
    # Newest last; the cap keeps the set to a few MB however many contents it has seen.
    if { echo "$known" && entries "$passed"; } | grep -E '^[0-9a-f]{40,64} [^ ]+$' | awk '!seen[$0]++' |
      tail -n 50000 >"$tmp"; then
      mv -f "$tmp" "$set_file"
    else
      rm -f "$tmp"
    fi
  } 2>/dev/null
  return 0
}

# run FLAGS...: Prettier over $todo, skipped when the set already holds every file. Results are remembered only from
# a clean exit, or from --check's exit 1 (unformatted files, each named); exit 2 (a syntax error, a crash) remembers
# nothing.
run() {
  if [ -z "$todo" ]; then
    echo "Prettier: all $(wc -l <<<"$files" | tr -d ' ') files already known formatted (CHECK_COLD=1 rechecks)."
    return 0
  fi
  local out status=0
  # shellcheck disable=SC2086 # one argument per file; tracked paths have no spaces
  out=$($prettier "$@" $todo 2>&1) || status=$?
  [ -z "$out" ] || echo "$out"
  if [ "$status" = 0 ] || { [ "$status" = 1 ] && [ "$1" = --check ]; }; then
    remember "$out"
  fi
  return "$status"
}

if [ "${1:-}" = "--check" ]; then
  status=0
  run --check || status=1
  # Uncached and over every file, so an overlong comment is caught whatever the known-formatted set holds: the set
  # records Prettier's verdict only, and this checker (and the limit it reads) can change without changing its key.
  # shellcheck disable=SC2086
  bun scripts/check-line-length.ts $files || status=1
  exit $status
fi
run --write --log-level warn
