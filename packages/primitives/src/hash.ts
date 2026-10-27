/**
 * 32-bit hashes for hash tables, sketches and dedup. Not cryptographic.
 *
 * Choice (bench/hash.bench.ts): on Bun, the native `Bun.hash` family hashes a 2 KB string an order of magnitude or
 * more faster than any JS implementation, so whole-string hashing uses it. The JS functions here exist for the case
 * natives cannot serve: hashing a *range* of a string without slicing it (the tokenizer hashes tokens in place, so
 * no substring is allocated), where the per-call native overhead dominates for short tokens.
 */

/**
 * FNV-1a over UTF-16 code units of `s[start, end)`. For ASCII this equals FNV-1a over the UTF-8 bytes. One multiply
 * per char and no tail handling: the cheapest hash for short tokens.
 *
 * No default parameters, on purpose: on JavaScriptCore a default parameter in a hot loop function cost 5x
 * (13.49 µs vs 2.72 µs per 2 KB; bench/jsc.bench.ts). Every hot function here avoids them.
 */
export function fnv1a(s: string, start: number, end: number): number {
  let h = 0x811c9dc5 | 0;
  for (let i = start; i < end; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** murmur3_x86_32 over the bytes of a Uint8Array range. Better avalanche than FNV for long keys and sketches. */
export function murmur3(bytes: Uint8Array, seed: number, start: number, end: number): number {
  let h = seed >>> 0;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let i = start;
  const blocks = end - ((end - start) & 3);
  for (; i < blocks; i += 4) {
    let k = bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24);
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  // Tail: 1–3 bytes (written without switch fallthrough, which the tsconfig forbids).
  const tail = (end - start) & 3;
  if (tail > 0) {
    let k = bytes[i]!;
    if (tail > 1) k ^= bytes[i + 1]! << 8;
    if (tail > 2) k ^= bytes[i + 2]! << 16;
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
  }
  h ^= end - start;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Final mix (murmur3 fmix32): spreads a weak 32-bit value, e.g. before taking low bits for a table index. */
export function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * A whole string's 32-bit hash, native on Bun. xxHash32 returns a number directly; wyhash is faster on long strings
 * but returns a 64-bit value whose BigInt conversion costs more than the hash below ~1 KB (bench/hash.bench.ts).
 */
export function hashString(s: string, seed: number): number {
  return Bun.hash.xxHash32(s, seed);
}
