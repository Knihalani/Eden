#!/usr/bin/env bash
# Typechecks every TypeScript program in the workspace (CI step 2).
#
# There is no build step: packages export src/*.ts directly and Bun strips types unchecked, so the checker is the
# only thing that ever looks at them. Every file named exactly tsconfig.json outside archived/ is a program.
#
# TYPECHECK picks the checker:
#   (unset) or tsc   TypeScript 5's tsc: the gate (`bun run check`) until TypeScript 7 is stable.
#   tsgo             TypeScript 7's native preview (@typescript/native-preview, pinned): about 5x faster cold and
#                    after an edit to a widely imported file (docs/TESTING.md); `bun run check:fast` uses it.
#   parity           Both, one after the other; fails, printing both outputs, when their errors (file, line, column
#                    and code) differ. Run it after bumping either checker.
set -euo pipefail
cd "$(dirname "$0")/.."

mode=${TYPECHECK:-tsc}
case "$mode" in
  tsc | tsgo | parity) ;;
  *)
    echo "TYPECHECK must be tsc, tsgo or parity (got '$mode')" >&2
    exit 2
    ;;
esac

projects=$(
  find . \( -name node_modules -o -name dist -o -path ./archived -o -path ./.claude \) -prune -o \
    -name tsconfig.json -print | sort
)
if [ -z "$projects" ]; then
  echo "no tsconfig.json found — refusing to report success" >&2
  exit 1
fi

# --incremental keeps each program's build info under the gitignored node_modules/.cache, one file per checker and
# tsconfig (named from its path) so two programs, or the two checkers' formats, never overwrite each other's. A warm
# run re-checks only what an edit can reach: an edit to a widely imported file costs close to a cold run.
# CHECK_COLD=1 checks from scratch.
cache_dir=node_modules/.cache/tsc

# A new git worktree has no build info, and its first check ran cold (11 s against 3.4 s warm). Its paths are
# relative to the build info file, so another worktree's carries over: copy in the most recently written one, which
# is most likely to be of a nearby commit (in an audit run, a sibling on the same integration branch; main's can be
# 40 files behind and save nothing). A copy, never a link: two checkouts writing one file would race. tsc trusts
# nothing in it unchecked: each file's recorded version is its content hash, so a copy from another branch re-checks
# what differs, and an unreadable one (copied mid-write) is treated as absent.
seed_cache() {
  local here wt from= tmp
  here=$(pwd -P)
  while IFS= read -r wt; do
    [ -f "$wt/node_modules/.cache/tsc/tsconfig.tsbuildinfo" ] || continue
    [ "$(cd "$wt" && pwd -P)" != "$here" ] || continue
    if [ -z "$from" ] || [ "$wt/node_modules/.cache/tsc/tsconfig.tsbuildinfo" -nt "$from/tsconfig.tsbuildinfo" ]; then
      from=$wt/node_modules/.cache/tsc
    fi
  done < <(git worktree list --porcelain | sed -n 's/^worktree //p')
  [ -n "$from" ] || return 0
  mkdir -p node_modules/.cache
  tmp=$(mktemp -d node_modules/.cache/tsc.seed.XXXXXX) || return 0
  cp "$from"/*.tsbuildinfo "$tmp"/ 2>/dev/null || true
  # A rename, so a check running beside this one sees no directory or a whole one; if one appeared meanwhile, keep it.
  if [ -d "$cache_dir" ] || ! mv "$tmp" "$cache_dir" 2>/dev/null; then rm -rf "$tmp"; fi
  rm -rf "${cache_dir:?}/${tmp##*/}" # mv moved it inside a directory created between the test and the rename
  [ -d "$cache_dir" ] && echo "── seeded $cache_dir from ${from%/node_modules/.cache/tsc}"
}
if [ "${CHECK_COLD:-}" != "1" ] && [ ! -d "$cache_dir" ]; then
  seed_cache || true
fi
mkdir -p "$cache_dir"

# check CHECKER PROJECT [EXTRA FLAGS...]: one program through one checker.
check() {
  local checker=$1 p=$2
  shift 2
  local flags=(--noEmit "$@")
  if [ "${CHECK_COLD:-}" != "1" ]; then
    local name
    name=$(echo "${p#./}" | tr '/' '_')
    local suffix=.tsbuildinfo
    [ "$checker" = tsgo ] && suffix=.tsgo.tsbuildinfo
    flags+=(--incremental --tsBuildInfoFile "$cache_dir/${name%.json}$suffix")
  fi
  echo "── $checker -p $p ${flags[*]}"
  "node_modules/.bin/$checker" -p "$p" "${flags[@]}"
}

# The errors in one checker's output, as `file(line,col): error TSnnnn`, sorted: the message wording may differ
# between TypeScript 5 and 7, the place and the code may not.
errors_of() {
  grep -oE '^[^ ].*\([0-9]+,[0-9]+\): error TS[0-9]+' "$1" | sort || true
}

status=0
for p in $projects; do
  if [ "$mode" != parity ]; then
    check "$mode" "$p" || status=1
    continue
  fi
  tsc_out=$(mktemp)
  tsgo_out=$(mktemp)
  tsc_status=0
  tsgo_status=0
  check tsc "$p" --pretty false > "$tsc_out" 2>&1 || tsc_status=$?
  check tsgo "$p" --pretty false > "$tsgo_out" 2>&1 || tsgo_status=$?
  if [ "$tsc_status" != 0 ] || [ "$tsgo_status" != 0 ]; then status=1; fi
  # Agreement: the same errors, and both passed or both failed (a failure with no parsed error, a crash, counts).
  tsc_ok=no
  tsgo_ok=no
  [ "$tsc_status" = 0 ] && tsc_ok=yes
  [ "$tsgo_status" = 0 ] && tsgo_ok=yes
  if [ "$(errors_of "$tsc_out")" = "$(errors_of "$tsgo_out")" ] && [ "$tsc_ok" = "$tsgo_ok" ]; then
    echo "── parity on $p: tsc and tsgo agree ($(errors_of "$tsc_out" | grep -c . || true) errors)"
    cat "$tsc_out"
  else
    echo "── PARITY FAILURE on $p: tsc (exit $tsc_status) and tsgo (exit $tsgo_status) disagree" >&2
    echo "── tsc:" >&2
    cat "$tsc_out" >&2
    echo "── tsgo:" >&2
    cat "$tsgo_out" >&2
    status=1
  fi
  rm -f "$tsc_out" "$tsgo_out"
done
exit $status
