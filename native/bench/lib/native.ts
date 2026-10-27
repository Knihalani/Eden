/**
 * Loads the eden-native cdylib through `bun:ffi`. `NATIVE_LIB` picks another build (the target-cpu=native one,
 * for instance); the default is the plain release build.
 */
import { dlopen, FFIType, suffix } from "bun:ffi";
import { join } from "node:path";

export const LIB_PATH =
  process.env.NATIVE_LIB ??
  join(import.meta.dir, "..", "..", "eden-native", "target", "release", `libeden_native.${suffix}`);

const { ptr, u32 } = FFIType;

export const lib = dlopen(LIB_PATH, {
  eden_noop: { args: [], returns: FFIType.void },
  eden_sum_bytes: { args: [ptr, u32], returns: u32 },
  eden_sum_u16: { args: [ptr, u32], returns: u32 },
  eden_tokenize_hash: { args: [ptr, u32, ptr, u32], returns: u32 },
  eden_tokenize_hash_utf16: { args: [ptr, u32, ptr, u32], returns: u32 },
  eden_murmur3: { args: [ptr, u32, u32], returns: u32 },
  eden_secrets_init: { args: [], returns: u32 },
  eden_secrets_set_init: { args: [], returns: u32 },
  eden_secrets_rule_id: { args: [u32, ptr, u32], returns: u32 },
  eden_secrets_report: { args: [ptr, u32], returns: u32 },
  eden_secrets_scan: { args: [ptr, u32, ptr, u32], returns: u32 },
  eden_secrets_scan_set: { args: [ptr, u32, ptr, u32], returns: u32 },
}).symbols;

const encoder = new TextEncoder();
/** Reused input buffer: UTF-8 is at most 3 bytes per UTF-16 unit. */
let input = new Uint8Array(1 << 16);

/** Encodes `text` into the reused buffer and returns the byte length. */
export function encode(text: string): Uint8Array {
  if (text.length * 3 > input.length) input = new Uint8Array(text.length * 3);
  const { written } = encoder.encodeInto(text, input);
  return input.subarray(0, written);
}

/** Rust tokenize + hash, including marshalling (encodeInto a reused buffer). */
export function nativeTokenize(text: string, out: Uint32Array): number {
  const bytes = encode(text);
  return lib.eden_tokenize_hash(bytes, bytes.length, out, out.length);
}

let ruleIds: string[] | undefined;

/** The ids of the gitleaks rules the Rust scanner runs, by index. */
export function nativeRuleIds(): string[] {
  if (ruleIds) return ruleIds;
  const count = lib.eden_secrets_init();
  const buf = new Uint8Array(256);
  const decoder = new TextDecoder();
  ruleIds = Array.from({ length: count }, (_, i) =>
    decoder.decode(buf.subarray(0, lib.eden_secrets_rule_id(i, buf, 256))),
  );
  return ruleIds;
}

export function nativeReport(): unknown {
  const size = lib.eden_secrets_report(null, 0);
  const buf = new Uint8Array(size);
  lib.eden_secrets_report(buf, size);
  return JSON.parse(new TextDecoder().decode(buf));
}

const hitBuf = new Uint32Array(512);

/** Rule indices the Rust scanner fires on `text` (prefilter mode, or RegexSet mode with `set`). */
export function nativeScan(text: string, set = false): Uint32Array {
  const bytes = encode(text);
  const scan = set ? lib.eden_secrets_scan_set : lib.eden_secrets_scan;
  const n = scan(bytes, bytes.length, hitBuf, hitBuf.length);
  return hitBuf.subarray(0, n);
}

/** Sorted rule ids the Rust scanner fires on `text`. */
export function nativeSecretHits(text: string, set = false): string[] {
  const ids = nativeRuleIds();
  return Array.from(nativeScan(text, set), (index) => ids[index]!).sort();
}
