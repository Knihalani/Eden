/**
 * The experiment's tokenizer in TypeScript; it must match `native/eden-native/src/tokenize.rs` exactly:
 * a token starts at a letter or digit (Unicode `Alphabetic` or general category N) and continues while the char is
 * a letter, digit, `'`, `_` or `-`; it is lowercased, a trailing `'s` is stripped, a token of at most one code
 * point is dropped, and each kept token yields murmur3 x86_32 (seed 0) of its UTF-8 bytes.
 *
 * A hand-written `charCodeAt` scanner with an ASCII fast path: an all-ASCII token is lowercased and hashed straight
 * from the string's code units (equal to its UTF-8 bytes); any other token is sliced, lowercased and encoded.
 */

/** 1 = may start a token, 2 = may only continue one, 0 = neither. */
const ASCII_CLASS = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  const ch = String.fromCharCode(c);
  if (/[A-Za-z0-9]/.test(ch)) ASCII_CLASS[c] = 1;
  else if (ch === "'" || ch === "_" || ch === "-") ASCII_CLASS[c] = 2;
}

const WORD = /^[\p{Alphabetic}\p{N}]$/u;
/** Lazily filled classification of BMP code points: 0 unknown, 1 word, 2 not. */
const BMP_CACHE = new Uint8Array(65536);

function isWordCodePoint(cp: number): boolean {
  if (cp < 65536) {
    let cached = BMP_CACHE[cp]!;
    if (cached === 0) BMP_CACHE[cp] = cached = WORD.test(String.fromCharCode(cp)) ? 1 : 2;
    return cached === 1;
  }
  return WORD.test(String.fromCodePoint(cp));
}

const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;

function mixK(k: number): number {
  k = Math.imul(k, C1);
  k = (k << 15) | (k >>> 17);
  return Math.imul(k, C2);
}

function mixH(h: number, k: number): number {
  h ^= k;
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

function finish(h: number, length: number): number {
  h ^= length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** murmur3 x86_32 of bytes. */
export function murmur3(bytes: Uint8Array, seed = 0): number {
  let h = seed | 0;
  const length = bytes.length;
  const blocks = length & ~3;
  let i = 0;
  for (; i < blocks; i += 4) {
    h = mixH(h, mixK(bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24)));
  }
  if (i < length) {
    let k = 0;
    for (let shift = 0; i < length; i++, shift += 8) k |= bytes[i]! << shift;
    h ^= mixK(k);
  }
  return finish(h, length);
}

/** An ASCII code unit, lowercased. */
const lowerAscii = (c: number) => (c >= 65 && c <= 90 ? c | 32 : c);

/** murmur3 of `text[start, end)`, all ASCII, lowercased on the fly (code units equal UTF-8 bytes). */
function murmur3AsciiLower(text: string, start: number, end: number): number {
  let h = 0;
  const length = end - start;
  const blocks = start + (length & ~3);
  let i = start;
  for (; i < blocks; i += 4) {
    const k =
      lowerAscii(text.charCodeAt(i)) |
      (lowerAscii(text.charCodeAt(i + 1)) << 8) |
      (lowerAscii(text.charCodeAt(i + 2)) << 16) |
      (lowerAscii(text.charCodeAt(i + 3)) << 24);
    h = mixH(h, mixK(k));
  }
  if (i < end) {
    let k = 0;
    for (let shift = 0; i < end; i++, shift += 8) k |= lowerAscii(text.charCodeAt(i)) << shift;
    h ^= mixK(k);
  }
  return finish(h, length);
}

const encoder = new TextEncoder();

/**
 * Tokenizes `text`, writing hashes to `out` while it has room; returns the token count. With `hashToken`, every
 * kept token is sliced, lowercased and hashed by it instead (the `Bun.hash.murmur32v3` variant of the benchmark).
 */
export function tokenizeHash(text: string, out: Uint32Array, hashToken?: (token: string) => number): number {
  const n = text.length;
  let i = 0;
  let count = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c < 128) {
      if (ASCII_CLASS[c] !== 1) {
        i++;
        continue;
      }
    } else {
      const cp = text.codePointAt(i)!;
      if (!isWordCodePoint(cp)) {
        i += cp > 0xffff ? 2 : 1;
        continue;
      }
    }
    const start = i;
    let ascii = true;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c < 128) {
        if (ASCII_CLASS[c] === 0) break;
        i++;
      } else {
        const cp = text.codePointAt(i)!;
        if (!isWordCodePoint(cp)) break;
        ascii = false;
        i += cp > 0xffff ? 2 : 1;
      }
    }
    let hash: number;
    if (ascii) {
      let end = i;
      if (end - start >= 2 && text.charCodeAt(end - 2) === 39 && (text.charCodeAt(end - 1) | 32) === 115) end -= 2;
      if (end - start <= 1) continue;
      hash = hashToken ? hashToken(text.slice(start, end).toLowerCase()) : murmur3AsciiLower(text, start, end);
    } else {
      let token = text.slice(start, i).toLowerCase();
      if (token.endsWith("'s")) token = token.slice(0, -2);
      // At most one code point: one unit, or one surrogate pair.
      if (token.length <= 1 || (token.length === 2 && token.codePointAt(0)! > 0xffff)) continue;
      hash = hashToken ? hashToken(token) : murmur3(encoder.encode(token));
    }
    if (count < out.length) out[count] = hash;
    count++;
  }
  return count;
}
