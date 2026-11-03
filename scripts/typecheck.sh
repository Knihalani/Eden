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

# --incremental keeps each program's build info under the gitignored node_modules/.cache, one file per tsconfig
# (named from its path) so two programs never overwrite each other's. A warm run re-checks only what an edit can
# reach: an edit to a widely imported file costs close to a cold run. CHECK_COLD=1 checks from scratch.
cache_dir=node_modules/.cache/tsc
mkdir -p "$cache_dir"
status=0
for p in $projects; do
  flags=(--noEmit)
  if [ "${CHECK_COLD:-}" != "1" ]; then
    name=$(echo "${p#./}" | tr '/' '_')
    flags+=(--incremental --tsBuildInfoFile "$cache_dir/${name%.json}.tsbuildinfo")
  fi
  echo "── tsc -p $p ${flags[*]}"
  node_modules/.bin/tsc -p "$p" "${flags[@]}" || status=1
done
exit $status
