# native/: the language-choice experiment

Measures whether Eden's per-event CPU kernels (tokenize + hash, secret scanning) should stay in TypeScript on Bun,
use Bun built-ins, or move to Rust through `bun:ffi`, WebAssembly or Node-API. The findings, every table and the
recommendation are in [docs/research/language-choice.md](../docs/research/language-choice.md).

This directory is **outside the Bun workspace and the root tsconfig** on purpose: nothing in `packages/` imports
it, and the root `bun run check` only sees the bench files through Prettier and the line-length check.

| Path | What |
|---|---|
| `eden-native/` | Rust crate (cdylib + rlib), C ABI: FFI probes, tokenize + murmur3, gitleaks scanner (`regex`, `aho-corasick`) |
| `eden-napi/` | The same tokenizer behind Node-API via napi-rs, loadable by Node and Bun |
| `bench/lib/` | Text generator, timing harness, TS tokenizer, `bun:ffi` and WASM loaders, secret corpus |
| `bench/verify.ts` | Cross-checks: identical hashes and identical fired rules across TS, FFI, WASM |
| `bench/ffi.ts` | FFI call overhead and string marshalling |
| `bench/tokenize.ts` | Tokenize + murmur3 end to end (Bun; Node via a bundle) |
| `bench/secrets.ts` | Which gitleaks rules fire: TS gate vs Rust FFI / RegexSet / WASM, plus cold start |
| `bench/secrets-profile.ts` | Where the TS gate spends its time; a single-regex keyword gate in TS |
| `bench/builtins.ts` | `Bun.hash`, `Bun.hash.murmur32v3`, `normalize("NFKC")`, `toLowerCase` |
| `bench/napi.ts` | napi-rs call overhead and tokenize (Bun; Node via a bundle) |
| `run-all.sh` | Builds every variant and runs everything in sequence |

## Requirements

Bun 1.4.4, Rust 1.97 (`rustup target add wasm32-unknown-unknown` for the WASM build), Node 22 for the Node runs
(`NODE=/path/to/node`, default `/opt/node22/bin/node`). Run `bun install` at the repo root once (the secret
benchmarks import `packages/redact` by relative path).

## Build and run

```bash
cd native
./run-all.sh                 # build everything, run every check and benchmark (~95 s once built, 4 vCPUs)
./run-all.sh /tmp/run1       # the same, also keeping one Markdown file per run in /tmp/run1
```

Or step by step:

```bash
cd native/eden-native
cargo test --release                                                     # tokenizer + murmur3 unit tests
cargo build --release                                                    # target/release/libeden_native.so
cargo build --release --target wasm32-unknown-unknown                    # .../eden_native.wasm
RUSTFLAGS="-C target-cpu=native" cargo build --release --target-dir target-native
(cd ../eden-napi && cargo build --release)                               # libeden_napi.so (a Node-API addon)

cd ..
bun bench/verify.ts                                                      # must end "ALL CROSS-CHECKS AGREE"
bun bench/ffi.ts
NATIVE_LIB=$PWD/eden-native/target-native/release/libeden_native.so bun bench/tokenize.ts
bun bench/secrets.ts
bun bench/secrets-profile.ts
bun bench/builtins.ts
bun bench/napi.ts

# Node: bundle, then point the bundle at the artifacts (it cannot locate them relative to itself).
bun build bench/tokenize.ts --target=node --format=esm --external bun:ffi --outfile /tmp/tokenize.mjs
NATIVE_WASM=$PWD/eden-native/target/wasm32-unknown-unknown/release/eden_native.wasm node /tmp/tokenize.mjs
bun build bench/napi.ts --target=node --format=esm --outfile /tmp/napi.mjs
NATIVE_NAPI=$PWD/eden-napi/target/release/libeden_napi.so node /tmp/napi.mjs
```

Typecheck the benches with `node_modules/.bin/tsc -p native/bench/tsconfig.bench.json` from the repo root (the
file is not named `tsconfig.json`, so `scripts/typecheck.sh` does not pick it up).

Environment overrides: `NATIVE_LIB` (cdylib path), `NATIVE_WASM` (wasm path), `NATIVE_NAPI` (napi addon path).

## How the harness times

Each case warms up for 150 ms (and at least 200 calls), then takes 2000 samples. A sample runs the op enough times
to last at least 5 µs (50 µs for the call-overhead cases), so mean, p50 and p99 are per-op times over samples; for
ops under 5 µs the percentiles describe small batches (the `ops/sample` column), not single calls. The machine is a
shared 4-vCPU VM: expect 1.5-2x run-to-run swings on single cells and compare medians of several runs.
