/**
 * Kernel 5 (Bun only): Bun's native hashes on the same strings, against murmur3 in TS and in Rust, for reference;
 * and `String.prototype.normalize("NFKC")` on ASCII and non-ASCII text.
 */
import { emailText, SIZES } from "./lib/gen";
import { bench, perKiB, table, type Stats } from "./lib/harness";
import { encode, lib } from "./lib/native";
import { murmur3 } from "./lib/tokenize";

const encoder = new TextEncoder();
const rows: (Stats & { extra: Record<string, string> })[] = [];
for (const nonAscii of [false, true]) {
  for (const size of SIZES) {
    const text = emailText(size, nonAscii);
    const bytes = encoder.encode(text);
    const label = `${nonAscii ? "non-ASCII" : "ASCII"} ${size} B`;
    const cases: [string, () => unknown][] = [
      ["Bun.hash(str) (wyhash)", () => Bun.hash(text)],
      ["Bun.hash.murmur32v3(str)", () => Bun.hash.murmur32v3(text)],
      ["Bun.hash.murmur32v3(bytes)", () => Bun.hash.murmur32v3(bytes)],
      ["TS murmur3(bytes)", () => murmur3(bytes)],
      ["TS encodeInto + murmur3", () => murmur3(encode(text))],
      [
        "Rust FFI encodeInto + murmur3",
        () => {
          const view = encode(text);
          return lib.eden_murmur3(view, view.length, 0);
        },
      ],
      ["str.normalize('NFKC')", () => text.normalize("NFKC").length],
      ["str.toLowerCase()", () => text.toLowerCase().length],
    ];
    for (const [name, op] of cases) {
      const stats = bench(`${label}: ${name}`, op);
      rows.push({ ...stats, extra: { "ns/KiB": perKiB(stats.meanNs, bytes.length) } });
    }
  }
}
table("Bun built-ins and reference hashes", rows);
