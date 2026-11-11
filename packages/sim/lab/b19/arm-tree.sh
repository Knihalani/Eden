#!/usr/bin/env bash
# B19 (D1040): a tree that runs the lab harness (packages/sim: suites, worlds, grader and prompts) at HARNESS
# against Eden's product packages at EDEN, so an Eden arm can be measured at any commit with everything else pinned.
#
#   bash packages/sim/lab/b19/arm-tree.sh EDEN_COMMIT DIR [HARNESS_COMMIT]
#
# The tree is a detached git worktree at HARNESS (default HEAD) whose product packages are replaced by EDEN's: files
# EDEN has are checked out, files added after EDEN are deleted. hermes-ab hosts Eden in-process (ContextPartner and
# createMcpServer from these packages), so the arm runs exactly EDEN's engine, server and sources code. Writes
# DIR/b19-arm.json (both commits and a hash of the product files) and refuses an existing DIR.
set -euo pipefail
EDEN=${1:?EDEN_COMMIT}
DIR=${2:?DIR}
HARNESS=${3:-HEAD}
PRODUCT=(engine graph llm primitives protocol redact sources server client)
[ -e "$DIR" ] && { echo "arm-tree: $DIR exists" >&2; exit 2; }
ROOT=$(git rev-parse --show-toplevel)
EDEN=$(git -C "$ROOT" rev-parse --short=9 "$EDEN^{commit}")
HARNESS=$(git -C "$ROOT" rev-parse --short=9 "$HARNESS^{commit}")
git -C "$ROOT" worktree add -q --detach "$DIR" "$HARNESS"
cd "$DIR"
paths=()
for p in "${PRODUCT[@]}"; do paths+=("packages/$p"); done
# Files added to the product packages after EDEN (tests, new modules) would otherwise survive the checkout.
git diff --no-renames --name-only --diff-filter=A "$EDEN" "$HARNESS" -- "${paths[@]}" | xargs -r git rm -q --
git checkout "$EDEN" -- "${paths[@]}"
bun install --frozen-lockfile >/dev/null 2>&1 || bun install >/dev/null
hash=$(git ls-files -s -- "${paths[@]}" | sha256sum | cut -c1-16)
printf '{"eden":"%s","harness":"%s","product":"%s","productHash":"%s"}\n' \
  "$EDEN" "$HARNESS" "${PRODUCT[*]}" "$hash" >b19-arm.json
cat b19-arm.json
