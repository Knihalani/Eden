#!/usr/bin/env bash
# Typechecks every TypeScript program in the workspace.
#
# There is no build step: `main`/`exports` point straight at src/*.ts and bun
# strips types unchecked, so tsc is the only thing that ever looks at them.
# That makes the set of programs tsc is pointed at a load-bearing list.
#
# It used to be one entry — `tsc -p tsconfig.json` — and the root program does
# not include apps/web at all, nor apps/site/src/app (it excludes it). Both Next
# apps carry their own tsconfig and nothing ever ran them, so ~3,000 lines of
# apps/web had no static gate of any kind: a dangling import of a module that
# did not exist, and a .then(load) passing an API response as an options bag,
# both sat in the tree while `bun run typecheck` reported success.
#
# So, like scripts/test.sh, this discovers rather than names. Every file called
# exactly `tsconfig.json` is one program. `tsconfig.base.json` is excluded by
# that exact-name match: it is extended, never built. Adding a fourth program
# needs no edit here.
#
# Kept to POSIX-ish bash (no mapfile/readarray) because macOS still ships
# bash 3.2 while CI runs bash 5.
set -euo pipefail
cd "$(dirname "$0")/.."

# -prune the heavy trees rather than filtering after the fact; archived/ alone
# is ~17k source files of a prior product and carries its own tsconfigs.
projects=$(
  find . \
    \( -name node_modules -o -name .next -o -name dist -o -path ./archived \) -prune -o \
    -name tsconfig.json -print |
    sort
)

if [ -z "$projects" ]; then
  echo "no tsconfig.json found — refusing to report success" >&2
  exit 1
fi

echo "typecheck programs:" $projects

# Run all of them even if an early one fails, so a single command surfaces every
# error in the workspace instead of only the first program's.
status=0
for p in $projects; do
  echo "── tsc -p $p"
  if ! npx tsc -p "$p" --noEmit; then
    status=1
  fi
done

exit $status
