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
# Prettier runs on Bun, not on the Node its bin names: the same verdicts for about a quarter less CPU (874 files: 45 s
# of CPU on Node 22, 36 s on Bun 1.4.4; every file, its indentation stripped and lines joined, formatted byte for byte
# the same on both, D1945). The runtime's version is part of the key below.
prettier="bun node_modules/prettier/bin/prettier.cjs"

# The known-formatted set: one `<blob id> <path>` line per file content that Prettier found formatted, so a later run
# hands Prettier only the files whose content (or path, which picks the parser) it has not seen. Prettier's own
# --cache cannot do this across checkouts: it keys absolute paths, so every new git worktree started cold (13 s).
# The set lives under the git common dir, which every worktree of the repo shares, in a file named by a key over
# everything else that decides the result: the Prettier version, the version of Bun that runs it, every Prettier
# config, ignore, .editorconfig and package.json file (package.json may hold a "prettier" key or name a plugin), and
# bun.lock (any plugin's version). A key that covers too much only re-checks more. Content is hashed from the working
# tree, raw (--no-filters), so unstaged edits count. Writes go to a temp file renamed into place: worktrees that check
# at once can lose each other's additions (a later run re-checks those), never corrupt the set. The cold gate
# (CHECK_COLD=1) reads it too (D819): an entry is Prettier's own verdict on exactly that content under exactly that
# key, so it is not a result that could go stale. FORMAT_COLD=1 checks every file without it. Any failure here falls
# back to checking every file. `--key` prints the key (format-key.test.ts changes each input and expects a new one).
#
# What enters the set comes only from Prettier's exit status and bare paths, never from parsing its log: --check runs
# Prettier as `--list-different --no-color`, which prints each unformatted path alone on a line. (Parsing `[warn]
# path` log lines let FORCE_COLOR=1, which colours the tag, record an unformatted file as formatted.) A path checked
# is recorded only when its content hashes the same before and after Prettier read it.

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
  configs=$(printf '%s\n' "$configs" bun.lock | grep -v '^$' | sort -u)
  key=$(
    echo "prettier $version"
    echo "runtime bun $(bun --version)"
    paste -d' ' <(git hash-object --no-filters --stdin-paths <<<"$configs") <(echo "$configs")
  ) || return 1
  key=$(git hash-object --stdin <<<"$key") || return 1
  mkdir -p "$common/eden-check-cache" || return 1
  # Sets for an old key (another Prettier or config) and temp files a killed run left behind. The current key's set
  # is spared: a run that finds every file known never rewrites it, so its age says nothing about its use.
  # Each family prunes only its own name, so one family's pruning never reads a run of the other's as use.
  find "$common/eden-check-cache" -type f -mtime +14 \( -name 'prettier-*' -o -name '*.tmp.*' \) ! -name "prettier-$key" -delete || true
  echo "$common/eden-check-cache/prettier-$key"
}

# linelen_set: the line-length pass's set, same shape as shared_set's, keyed by everything that decides its verdict:
# the checker's source, the config it reads the limit from, the file list's definition (this script) and the Bun
# that runs it. Under FORMAT_COLD=1 it is not used.
linelen_set() {
  local common key
  common=$(git rev-parse --path-format=absolute --git-common-dir) || return 1
  key=$(
    echo "runtime bun $(bun --version)"
    git hash-object --no-filters --stdin-paths <<'EOF'
scripts/format.sh
scripts/check-line-length.ts
.prettierrc.json
EOF
  ) || return 1
  key=$(git hash-object --stdin <<<"$key") || return 1
  mkdir -p "$common/eden-check-cache" || return 1
  find "$common/eden-check-cache" -type f -mtime +14 -name 'linelen-*' ! -name "linelen-$key" -delete || true
  echo "$common/eden-check-cache/linelen-$key"
}

# entries PATHS: each path (one per line) as `<blob id> <path>`, hashed from the working tree.
entries() {
  paste -d' ' <(git hash-object --no-filters --stdin-paths <<<"$1") <(echo "$1")
}

set_file=
known=
unknown=
if [ "${1:-}" = "--key" ]; then
  basename "$(shared_set)"
  exit
fi
if [ "${FORMAT_COLD:-}" != "1" ]; then
  set_file=$(shared_set 2>/dev/null) || set_file=
fi
if [ -n "$set_file" ]; then
  current=$(entries "$files" 2>/dev/null) || set_file=
fi
todo=$files
if [ -n "$set_file" ]; then
  # Only well-formed lines are trusted; the rest are files Prettier has not passed in this configuration.
  known=$(grep -E '^[0-9a-f]{40,64} [^ ]+$' "$set_file" 2>/dev/null) || known=
  # Marks the set in use for the pruning in shared_set, which a run that writes nothing would otherwise not do.
  touch -c "$set_file" 2>/dev/null || true
  if unknown=$(grep -v -x -F -f <(echo "$known") <<<"$current"); then
    todo=$(cut -d' ' -f2- <<<"$unknown")
  elif [ $? = 1 ]; then
    todo= # grep's "no line left": every file is known
  fi
fi

# remember MODE SET KNOWN BEFORE PASSED: adds PASSED (paths, one per line, all in the checked list) to SET, hashed
# now so --write records the formatted content. For check, an entry is kept only if it also is in BEFORE, hashed
# before the checker ran: a file edited while it ran was checked in some other content.
remember() {
  local mode=$1 file=$2 known_entries=$3 before=$4 passed=$5 fresh tmp
  [ -n "$file" ] && [ -n "$passed" ] || return 0
  {
    fresh=$(entries "$passed") || return 0
    if [ "$mode" = check ]; then
      fresh=$(grep -x -F -f <(echo "$before") <<<"$fresh") || return 0
    fi
    tmp=$(mktemp "$file.tmp.XXXXXX") || return 0
    # Newest last; the cap keeps the set to a few MB however many contents it has seen.
    if { echo "$known_entries" && echo "$fresh"; } | grep -E '^[0-9a-f]{40,64} [^ ]+$' | awk '!seen[$0]++' |
      tail -n 50000 >"$tmp"; then
      mv -f "$tmp" "$file"
    else
      rm -f "$tmp"
    fi
  } 2>/dev/null
  return 0
}

# all_known: true, saying so, when the set holds every file and Prettier has nothing to do (it fails on no files).
all_known() {
  [ -z "$todo" ] || return 1
  echo "Prettier: all $(wc -l <<<"$files" | tr -d ' ') files already known formatted (FORMAT_COLD=1 rechecks)."
}

# check: Prettier's --check over $todo, reported in its words but run as --list-different. Exit 0 remembers all of
# $todo. Exit 1 remembers $todo less the listed paths, and only when every listed line is exactly a path in $todo
# (anything else, a log line say, remembers nothing). Exit 2 (a syntax error, a crash) remembers nothing.
check() {
  all_known && return 0
  local out status=0 passed
  echo "Checking formatting..."
  # Errors (stderr) go straight to the terminal; only stdout, the bare paths, is read.
  # shellcheck disable=SC2086 # one argument per file; tracked paths have no spaces
  out=$(FORCE_COLOR=0 $prettier --list-different --no-color $todo) || status=$?
  if [ "$status" = 0 ]; then
    echo "All matched files use Prettier code style!"
    remember check "$set_file" "$known" "$unknown" "$todo"
    return 0
  fi
  [ -z "$out" ] || sed 's/^/[warn] /' <<<"$out"
  if [ "$status" = 1 ] && [ -n "$out" ]; then
    local n
    n=$(wc -l <<<"$out" | tr -d ' ')
    [ "$n" = 1 ] && n="the above file" || n="$n files"
    echo "[warn] Code style issues found in $n. Run Prettier with --write to fix."
    if ! grep -q -v -x -F -f <(echo "$todo") <<<"$out"; then
      passed=$(grep -v -x -F -f <(echo "$out") <<<"$todo") && remember check "$set_file" "$known" "$unknown" "$passed"
    fi
  fi
  return "$status"
}

# write: Prettier's --write over $todo; only a clean exit, every file now formatted, is remembered.
write() {
  all_known && return 0
  local status=0
  # shellcheck disable=SC2086
  $prettier --write --log-level warn $todo || status=$?
  [ "$status" != 0 ] || remember write "$set_file" "$known" "$unknown" "$todo"
  return "$status"
}

if [ "${1:-}" = "--check" ]; then
  status=0
  check || status=1
  # The line-length pass caches the same way, against its own key (linelen_set): the known-formatted set cannot
  # speak for it because this checker and the limit it reads change without changing Prettier's key. Only a clean
  # pass over the whole checked list is remembered: the checker reports its failures by path, and a failure means
  # the run rechecks, which is the rare path.
  ll_set= ll_known= ll_before=
  if [ "${FORMAT_COLD:-}" != "1" ]; then
    ll_set=$(linelen_set 2>/dev/null) || ll_set=
  fi
  if [ -n "$ll_set" ]; then
    ll_entries=${current:-}
    if [ -z "$ll_entries" ]; then
      ll_entries=$(entries "$files" 2>/dev/null) || ll_set=
    fi
  fi
  ll_todo=$files
  if [ -n "$ll_set" ]; then
    ll_known=$(grep -E '^[0-9a-f]{40,64} [^ ]+$' "$ll_set" 2>/dev/null) || ll_known=
    touch -c "$ll_set" 2>/dev/null || true
    if ll_before=$(grep -v -x -F -f <(echo "$ll_known") <<<"$ll_entries"); then
      ll_todo=$(cut -d' ' -f2- <<<"$ll_before")
    else
      ll_todo= ll_before=
    fi
  fi
  if [ -z "$ll_todo" ]; then
    echo "Line length: all $(wc -l <<<"$files" | tr -d ' ') files already known within the limit (FORMAT_COLD=1 rechecks)."
  else
    # shellcheck disable=SC2086
    if bun scripts/check-line-length.ts $ll_todo; then
      remember check "$ll_set" "$ll_known" "$ll_before" "$ll_todo"
    else
      status=1
    fi
  fi
  exit $status
fi
write
