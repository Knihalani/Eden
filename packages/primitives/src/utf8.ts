/**
 * UTF-8 sizes of JS strings without encoding them, for byte budgets (injection packets, cache costs, model inputs).
 *
 * `truncateUtf8` replaces the engine's per-character `Buffer.byteLength(out + ch)` loop, which was quadratic and the
 * largest single cost in the end-to-end profile (20.9% of CPU; packages/engine/bench/pipeline.bench.ts).
 */

/** UTF-8 length of `s` in bytes, as `TextEncoder` would encode it (a lone surrogate becomes U+FFFD: 3 bytes). */
export function utf8Length(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * The longest prefix of `s` whose UTF-8 encoding fits in `maxBytes`, never splitting a surrogate pair. One pass,
 * stopping at the cut: O(cut), not O(n²).
 */
export function truncateUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  // Every code unit is at most 3 bytes: a string this short always fits, with no scan.
  if (s.length * 3 <= maxBytes) return s;
  let bytes = 0;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        if (bytes + 4 > maxBytes) return s.slice(0, i);
        bytes += 4;
        i++;
        continue;
      }
    }
    const b = c < 0x80 ? 1 : c < 0x800 ? 2 : 3; // a lone surrogate encodes as U+FFFD: 3 bytes
    if (bytes + b > maxBytes) return s.slice(0, i);
    bytes += b;
  }
  return s;
}
