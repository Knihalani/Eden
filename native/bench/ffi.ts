/**
 * Kernels 1 and 2 (Bun only): bun:ffi per-call overhead, and the cost of getting a JS string into memory Rust can
 * read (UTF-8 or UTF-16), per KiB.
 */
import { ptr } from "bun:ffi";
import { emailText, SIZES } from "./lib/gen";
import { bench, perKiB, table, type Stats } from "./lib/harness";
import { encode, lib, LIB_PATH } from "./lib/native";

console.log(`lib: ${LIB_PATH}`);
const BATCH = { minSampleNs: 50_000 };

// --- 1. Call overhead ------------------------------------------------------------------------------------------
const jsNoop = new Function() as () => void;
const buf256 = new Uint8Array(256).map((_, i) => i);
const buf256Ptr = ptr(buf256);
const call: Stats[] = [
  bench("JS empty function (baseline)", () => jsNoop(), BATCH),
  bench("ffi noop()", () => lib.eden_noop(), BATCH),
  bench("ffi sum_bytes(Uint8Array, 256)", () => lib.eden_sum_bytes(buf256, 256), BATCH),
  bench("ffi sum_bytes(cached ptr number, 256)", () => lib.eden_sum_bytes(buf256Ptr, 256), BATCH),
  bench("ffi sum_bytes(ptr(arr) per call, 256)", () => lib.eden_sum_bytes(ptr(buf256), 256), BATCH),
  bench(
    "JS sum of 256 bytes (loop)",
    () => {
      let sum = 0;
      for (let i = 0; i < 256; i++) sum = (sum + buf256[i]!) | 0;
      return sum;
    },
    BATCH,
  ),
];
for (const size of [2048, 16384]) {
  const buf = new Uint8Array(size).map((_, i) => i);
  call.push(bench(`ffi sum_bytes(Uint8Array, ${size})`, () => lib.eden_sum_bytes(buf, size), BATCH));
}
table("bun:ffi call overhead", call, "ns");

// --- 2. String marshalling -------------------------------------------------------------------------------------
const encoder = new TextEncoder();
let units = new Uint16Array(1 << 15);
const utf16Buf = Buffer.alloc(1 << 16);
const rows: (Stats & { extra: Record<string, string> })[] = [];
for (const nonAscii of [false, true]) {
  for (const size of SIZES) {
    const text = emailText(size, nonAscii);
    const bytes = encoder.encode(text).length;
    const label = `${nonAscii ? "non-ASCII" : "ASCII"} ${size} B`;
    const cases: [string, () => unknown][] = [
      ["encodeInto reused Uint8Array", () => encode(text).length],
      ["Buffer.from(str)", () => Buffer.from(text).length],
      ["TextEncoder.encode(str)", () => encoder.encode(text).length],
      [
        "UTF-16 charCodeAt loop into reused Uint16Array",
        () => {
          if (text.length > units.length) units = new Uint16Array(text.length);
          for (let i = 0; i < text.length; i++) units[i] = text.charCodeAt(i);
          return text.length;
        },
      ],
      ["UTF-16 Buffer.write(str, 'utf16le') reused", () => utf16Buf.write(text, 0, "utf16le")],
      [
        "encodeInto + ffi sum_bytes (end to end)",
        () => {
          const view = encode(text);
          return lib.eden_sum_bytes(view, view.length);
        },
      ],
      [
        "Buffer.write utf16le + ffi sum_u16 (end to end)",
        () => lib.eden_sum_u16(utf16Buf, utf16Buf.write(text, 0, "utf16le") >>> 1),
      ],
    ];
    for (const [name, op] of cases) {
      const stats = bench(`${label}: ${name}`, op);
      rows.push({ ...stats, extra: { "ns/KiB (UTF-8 bytes)": perKiB(stats.meanNs, bytes) } });
    }
  }
}
table("String marshalling: JS string to native-readable memory", rows);
