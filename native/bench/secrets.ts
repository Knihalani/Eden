/**
 * Kernel 4 (Bun only): "which rules fire" over the vendored gitleaks rules, TS (packages/redact) against Rust via
 * bun:ffi (keyword prefilter + per-rule regex, or a RegexSet first) and Rust via WASM, on benign email text and on
 * ~2 KiB of email with three secrets. Compile (cold-start) times are measured first, once each.
 */
import { THREE_SECRETS } from "./lib/corpus";
import { emailText } from "./lib/gen";
import { bench, now, perKiB, table, type Stats } from "./lib/harness";
import { encode, lib, LIB_PATH } from "./lib/native";
import { gitleaksHits, secretHits } from "./lib/ts-secrets";
import { secretRules } from "../../packages/redact/src/secrets";
import { loadWasm } from "./lib/wasm";

console.log(`lib: ${LIB_PATH}`);

// Cold start: compile every rule once (the TS gate compiles a rule lazily, on its first run).
let start = now();
const tsRules = secretRules();
for (const rule of tsRules) rule.spans("");
const tsCompileMs = (now() - start) / 1e6;
start = now();
const rustRules = lib.eden_secrets_init();
const rustCompileMs = (now() - start) / 1e6;
start = now();
const setBuilt = lib.eden_secrets_set_init();
const setCompileMs = (now() - start) / 1e6;
start = now();
const wasm = loadWasm();
const wasmRules = wasm.secretsInit();
const wasmCompileMs = (now() - start) / 1e6;
const cold: [string, number, number][] = [
  ["TS: build + first run (compiles) of every rule regex, incl. eden-*", tsRules.length, tsCompileMs],
  ["Rust FFI: parse TOML, compile rule + allowlist regexes, Aho-Corasick", rustRules, rustCompileMs],
  [`Rust FFI: RegexSet over every rule (built: ${setBuilt === 1})`, rustRules, setCompileMs],
  ["Rust WASM: instantiate + parse, compile, Aho-Corasick (no RegexSet)", wasmRules, wasmCompileMs],
];
console.log(`\n| cold start | rules | ms |\n|---|---:|---:|`);
for (const [what, rules, ms] of cold) console.log(`| ${what} | ${rules} | ${ms.toFixed(1)} |`);

const hits = new Uint32Array(512);
const scan = (text: string, set: boolean) => {
  const bytes = encode(text);
  return (set ? lib.eden_secrets_scan_set : lib.eden_secrets_scan)(bytes, bytes.length, hits, hits.length);
};

const inputs: [string, string][] = [
  ["benign ASCII 256 B", emailText(256)],
  ["benign ASCII 2 KiB", emailText(2048)],
  ["benign non-ASCII 2 KiB", emailText(2048, true)],
  ["benign ASCII 16 KiB", emailText(16384)],
  ["3 secrets ~2 KiB", THREE_SECRETS],
];
const rows: (Stats & { extra: Record<string, string> })[] = [];
for (const [label, text] of inputs) {
  const bytes = new TextEncoder().encode(text).length;
  const cases: [string, () => number][] = [
    ["TS secretHits (full gate, incl. eden-*)", () => secretHits(text).length],
    ["TS gitleaks rules only", () => gitleaksHits(text).length],
    ["Rust FFI prefilter + regex", () => scan(text, false)],
    ["Rust FFI RegexSet + prefilter", () => scan(text, true)],
    ["Rust WASM prefilter + regex", () => wasm.secretScan(text)],
  ];
  for (const [name, op] of cases) {
    const stats = bench(`${label}: ${name}`, op);
    rows.push({ ...stats, extra: { "ns/KiB": perKiB(stats.meanNs, bytes), "rules fired": String(op()) } });
  }
}
table("Secret scanning: which gitleaks rules fire", rows);
