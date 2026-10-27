/**
 * napi-rs (Node-API) on Bun and Node: call overhead and tokenize + murmur3 with napi's own string marshalling
 * (a JS string in, UTF-8 `String` in Rust) or with encodeInto bytes. Checks the hashes against the TS tokenizer
 * first. Node runs a bundle of this file (see native/README.md); `NATIVE_NAPI` overrides the addon's path.
 */
import { join } from "node:path";
import { emailText, SIZES } from "./lib/gen";
import { bench, perKiB, table, type Stats } from "./lib/harness";
import { tokenizeHash } from "./lib/tokenize";

interface Addon {
  noop(): void;
  sumBytes(bytes: Uint8Array): number;
  tokenizeHash(text: string, out: Uint32Array): number;
  tokenizeHashBytes(bytes: Uint8Array, len: number, out: Uint32Array): number;
}

const here = typeof import.meta.dirname === "string" ? import.meta.dirname : new URL(".", import.meta.url).pathname;
const path = process.env.NATIVE_NAPI ?? join(here, "..", "eden-napi", "target", "release", "libeden_napi.so");
const module = { exports: {} as Addon };
(process as unknown as { dlopen(module: object, path: string): void }).dlopen(module, path);
const addon = module.exports;

const out = new Uint32Array(8192);
const check = new Uint32Array(8192);
const input = new Uint8Array(1 << 16);
const encoder = new TextEncoder();
for (const nonAscii of [false, true]) {
  for (const size of SIZES) {
    const text = emailText(size, nonAscii);
    const n = tokenizeHash(text, check);
    const viaString = addon.tokenizeHash(text, out);
    const sameString = viaString === n && out.subarray(0, n).every((h, i) => h === check[i]);
    const { written } = encoder.encodeInto(text, input);
    const viaBytes = addon.tokenizeHashBytes(input, written, out);
    const sameBytes = viaBytes === n && out.subarray(0, n).every((h, i) => h === check[i]);
    if (!sameString || !sameBytes) throw new Error(`napi tokenize disagrees with TS on ${size} B (${nonAscii})`);
  }
}
console.log("napi tokenize hashes equal the TS tokenizer's on all 6 texts");

const BATCH = { minSampleNs: 50_000 };
const buf256 = new Uint8Array(256).map((_, i) => i);
table(
  "Node-API (napi-rs) call overhead",
  [
    bench("napi noop()", () => addon.noop(), BATCH),
    bench("napi sumBytes(Uint8Array 256)", () => addon.sumBytes(buf256), BATCH),
  ],
  "ns",
);

const rows: (Stats & { extra: Record<string, string> })[] = [];
for (const nonAscii of [false, true]) {
  for (const size of SIZES) {
    const text = emailText(size, nonAscii);
    const bytes = encoder.encode(text).length;
    const label = `${nonAscii ? "non-ASCII" : "ASCII"} ${size} B`;
    const cases: [string, () => number][] = [
      ["napi tokenizeHash(string)", () => addon.tokenizeHash(text, out)],
      [
        "napi encodeInto + tokenizeHashBytes",
        () => addon.tokenizeHashBytes(input, encoder.encodeInto(text, input).written, out),
      ],
    ];
    for (const [name, op] of cases) {
      const stats = bench(`${label}: ${name}`, op);
      rows.push({ ...stats, extra: { "ns/KiB": perKiB(stats.meanNs, bytes) } });
    }
  }
}
table("Tokenize + murmur3 via napi-rs (end to end)", rows);
