#!/usr/bin/env bash
# Builds every variant of the language-choice experiment and runs the cross-checks and benchmarks in sequence
# (never in parallel: they share 4 vCPUs). Output is Markdown; pass a directory to also keep one file per run.
set -euo pipefail
cd "$(dirname "$0")"
out="${1:-}"
node="${NODE:-/opt/node22/bin/node}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

(cd eden-native && cargo build --release)
(cd eden-native && cargo build --release --target wasm32-unknown-unknown)
(cd eden-native && RUSTFLAGS="-C target-cpu=native" cargo build --release --target-dir target-native)
(cd eden-napi && cargo build --release)

native_lib="$PWD/eden-native/target-native/release/libeden_native.so"
wasm="$PWD/eden-native/target/wasm32-unknown-unknown/release/eden_native.wasm"
napi="$PWD/eden-napi/target/release/libeden_napi.so"
bun build bench/tokenize.ts --target=node --format=esm --external bun:ffi --outfile "$tmp/tokenize.mjs" >/dev/null
bun build bench/napi.ts --target=node --format=esm --outfile "$tmp/napi.mjs" >/dev/null

run() {
  local name="$1"
  shift
  echo -e "\n<!-- $name -->"
  if [ -n "$out" ]; then
    mkdir -p "$out"
    "$@" | tee "$out/$name.md"
  else
    "$@"
  fi
}

run verify bun bench/verify.ts
run ffi bun bench/ffi.ts
run ffi-native-cpu env NATIVE_LIB="$native_lib" bun bench/ffi.ts
run tokenize-bun bun bench/tokenize.ts
run tokenize-bun-native-cpu env NATIVE_LIB="$native_lib" bun bench/tokenize.ts
run tokenize-node env NATIVE_WASM="$wasm" "$node" "$tmp/tokenize.mjs"
run secrets bun bench/secrets.ts
run secrets-native-cpu env NATIVE_LIB="$native_lib" bun bench/secrets.ts
run secrets-profile bun bench/secrets-profile.ts
run builtins bun bench/builtins.ts
run napi-bun bun bench/napi.ts
run napi-node env NATIVE_NAPI="$napi" "$node" "$tmp/napi.mjs"
