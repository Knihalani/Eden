#!/usr/bin/env bash
# Runs bench/runtime.bench.ts on Bun and on Node (bundled for Node by `bun build`), to compare JavaScriptCore and V8 on
# the same TypeScript. Needs `node` on PATH (Node 22 was measured).
set -euo pipefail
cd "$(dirname "$0")"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
bun build runtime.bench.ts --target=node --outfile="$out/runtime.js" >/dev/null
echo "== Bun $(bun --version) (JavaScriptCore)"
bun runtime.bench.ts
echo "== Node $(node --version) (V8)"
node "$out/runtime.js"
