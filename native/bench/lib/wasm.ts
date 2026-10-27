/**
 * Loads the eden-native crate built for wasm32-unknown-unknown, on Bun or Node. Input and output buffers are
 * allocated once inside the module's memory; JS writes the UTF-8 input there with `encodeInto` and reads hashes
 * back through a view (views are rebuilt if the memory grows).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const here = typeof import.meta.dirname === "string" ? import.meta.dirname : new URL(".", import.meta.url).pathname;

export const WASM_PATH =
  process.env.NATIVE_WASM ??
  join(here, "..", "..", "eden-native", "target", "wasm32-unknown-unknown", "release", "eden_native.wasm");

interface Exports {
  memory: WebAssembly.Memory;
  eden_alloc(size: number): number;
  eden_tokenize_hash(ptr: number, len: number, out: number, cap: number): number;
  eden_secrets_init(): number;
  eden_secrets_rule_id(index: number, out: number, cap: number): number;
  eden_secrets_scan(ptr: number, len: number, out: number, cap: number): number;
}

const INPUT_BYTES = 1 << 17;
const OUT_WORDS = 1 << 15;

export function loadWasm() {
  const module = new WebAssembly.Module(readFileSync(WASM_PATH));
  const exports = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
  const inPtr = exports.eden_alloc(INPUT_BYTES);
  const outPtr = exports.eden_alloc(OUT_WORDS * 4);
  const encoder = new TextEncoder();
  let buffer: ArrayBuffer | undefined;
  let bytes!: Uint8Array;
  let words!: Uint32Array;
  const views = () => {
    if (exports.memory.buffer !== buffer) {
      buffer = exports.memory.buffer;
      bytes = new Uint8Array(buffer, inPtr, INPUT_BYTES);
      words = new Uint32Array(buffer, outPtr, OUT_WORDS);
    }
  };
  const write = (text: string): number => {
    views();
    return encoder.encodeInto(text, bytes).written;
  };
  return {
    /** Rust tokenize + hash in WASM, including marshalling; hashes are copied into `out`. */
    tokenize(text: string, out: Uint32Array): number {
      const len = write(text);
      const count = exports.eden_tokenize_hash(inPtr, len, outPtr, OUT_WORDS);
      views();
      out.set(words.subarray(0, Math.min(count, out.length)));
      return count;
    },
    /** How many gitleaks rules fire on `text` (indices left in module memory), for timing. */
    secretScan(text: string): number {
      const len = write(text);
      return exports.eden_secrets_scan(inPtr, len, outPtr, OUT_WORDS);
    },
    /** Sorted gitleaks rule ids the WASM scanner fires on `text`. */
    secretHits(text: string): string[] {
      const len = write(text);
      const n = exports.eden_secrets_scan(inPtr, len, outPtr, OUT_WORDS);
      views();
      const hits = Array.from(words.subarray(0, n));
      return hits.map((index) => ruleId(index)).sort();
    },
    secretsInit: () => exports.eden_secrets_init(),
  };
  function ruleId(index: number): string {
    views();
    const n = exports.eden_secrets_rule_id(index, inPtr, 256);
    views();
    return new TextDecoder().decode(bytes.slice(0, n));
  }
}
