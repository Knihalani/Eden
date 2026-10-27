/**
 * Kernel 3: tokenize + murmur3, end to end from a JS string to a filled Uint32Array, at 256 B, 2 KiB and 16 KiB,
 * ASCII and ~10% non-ASCII. On Bun: TS, Rust via bun:ffi (UTF-8 via encodeInto, and UTF-16), Rust via WASM.
 * On Node (bundled by `bun build --target=node`, see native/README.md): TS and Rust via WASM.
 */
import { emailText, SIZES } from "./lib/gen";
import { bench, perKiB, table, type Stats } from "./lib/harness";
import { tokenizeHash } from "./lib/tokenize";
import { loadWasm } from "./lib/wasm";

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const wasm = loadWasm();
const out = new Uint32Array(8192);

type Op = (text: string) => number;
const ops: [string, Op][] = [["TS", (text) => tokenizeHash(text, out)]];
if (isBun) {
  const murmur = (Bun as unknown as { hash: { murmur32v3(token: string): number } }).hash.murmur32v3;
  ops.push(["TS scan + Bun.hash.murmur32v3(token)", (text) => tokenizeHash(text, out, (token) => murmur(token))]);
  // A computed specifier keeps `bun build --target=node` from bundling (and hoisting) the bun:ffi loader.
  const specifier = ["./lib", "native"].join("/");
  const native = (await import(specifier)) as typeof import("./lib/native");
  let units = new Uint16Array(1 << 15);
  ops.push(["Rust FFI (encodeInto UTF-8)", (text) => native.nativeTokenize(text, out)]);
  ops.push([
    "Rust FFI (UTF-16 charCodeAt loop)",
    (text) => {
      if (text.length > units.length) units = new Uint16Array(text.length);
      for (let i = 0; i < text.length; i++) units[i] = text.charCodeAt(i);
      return native.lib.eden_tokenize_hash_utf16(units, text.length, out, out.length);
    },
  ]);
}
ops.push(["Rust WASM (encodeInto)", (text) => wasm.tokenize(text, out)]);

const rows: (Stats & { extra: Record<string, string> })[] = [];
for (const nonAscii of [false, true]) {
  for (const size of SIZES) {
    const text = emailText(size, nonAscii);
    const bytes = new TextEncoder().encode(text).length;
    for (const [name, op] of ops) {
      const stats = bench(`${nonAscii ? "non-ASCII" : "ASCII"} ${size} B: ${name}`, () => op(text));
      rows.push({ ...stats, extra: { "ns/KiB": perKiB(stats.meanNs, bytes), tokens: String(op(text)) } });
    }
  }
}
table("Tokenize + murmur3 (end to end, incl. marshalling)", rows);
