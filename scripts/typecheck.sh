#!/usr/bin/env bash
# Typechecks every TypeScript program in the workspace (CI step 2).
#
# There is no build step: packages export src/*.ts directly and Bun strips types unchecked, so tsc is the
# only thing that ever looks at them. Every file named exactly tsconfig.json outside archived/ is a program.
set -euo pipefail
cd "$(dirname "$0")/.."

projects=$(
  find . \( -name node_modules -o -name dist -o -path ./archived -o -path ./.claude \) -prune -o \
    -name tsconfig.json -print | sort
)
if [ -z "$projects" ]; then
  echo "no tsconfig.json found — refusing to report success" >&2
  exit 1
fi

status=0
for p in $projects; do
  echo "── tsc -p $p"
  node_modules/.bin/tsc -p "$p" --noEmit || status=1
done
exit $status
