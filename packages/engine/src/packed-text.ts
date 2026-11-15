/**
 * Compact item text for the cache (`CacheLimits.packText`, on by default; D188 reopened D111's compressed text). A
 * JS string holding one character past Latin-1 (a typographic dash, an arrow) is two bytes a character, and cached
 * item text was about half of a synced user's heap (ingest.bench.ts `--world`). A packed item keeps its text compressed
 * (zstd level 1 since D1926, DEFLATE level 6 before; Latin-1 bytes when every character fits, else UTF-8) and decodes
 * it on read: `text` is an own, enumerable getter, so reads, spreads, `JSON` and `structuredClone` see the same item as
 * before.
 *
 * A small process-wide memo of recently decoded texts, keyed by the packed bytes (as the held string) in one map per
 * tag (encoding and codec), so two keys are equal only when the packed bytes and their decoding are, and so the texts:
 * a hit is always the reading item's own text, whoever else holds the same words ("Ã©" in Latin-1 and "é" in UTF-8
 * are the same bytes, hence a map a tag). It keeps the repeated reads of one candidate on the ask path from
 * decompressing each time.
 */
// Imported, not the global: under `bun test --parallel` a reused worker was seen with a global `Buffer` whose `from`
// was TypedArray.from (A23's review; no code here assigns it), so `Buffer.from(text, "latin1")` threw in 1 run of 3.
import { Buffer } from "node:buffer";
import type { ContextItem } from "@eden/protocol";

/** Shorter text stays a plain string: its frame header and the byte array's own cost would eat the saving. */
export const MIN_PACK_CHARS = 256;
/** Recently decoded texts kept (`decoded`): a lookup's candidates and their repeated reads, not a user's items. */
const MEMO_ITEMS = 256;

const PACKED = Symbol("eden.packedText");

/**
 * The packed bytes, held as a one-byte string of them (each byte one Latin-1 character; D998), not a Uint8Array: a
 * typed array is two cells (the view and its ArrayBuffer) and a malloc'd store beside the bytes, about 200 bytes of
 * heap an item more than the string (`live-heap.bench.ts`). Inflating copies them into a Buffer first, a few hundred
 * bytes, once per decode the memo misses.
 */
type Packed = ContextItem & { readonly [PACKED]: string };

const encoder = new TextEncoder();
// `ignoreBOM`: a text that starts with U+FEFF decodes with it, as it was stored and indexed. The default drops a
// leading one, so before the review of D1913 such a copy read without the character its terms were taken with, and,
// once the memo held the packed text, read one way or the other by whether another user's forget had emptied it.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
/**
 * How a packed text is held, as a tag: bit 0 Latin-1 bytes (else UTF-8), bit 1 a zstd frame without its 4-byte magic
 * (else raw DEFLATE). `packItem` packs with zstd level 1 since D1926 (DEFLATE level 6 before: 2.7x the compress time
 * for 6-8% fewer bytes); DEFLATE bytes still come from a warm blob of `PERSIST_FORMAT` 6 and read as before.
 */
export type PackTag = 0 | 1 | 2 | 3;
const LATIN1 = 1;
const ZSTD = 2;
/** A zstd frame's magic number, cut from the held bytes (every frame starts with it) and put back to decode. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** Decoded texts by held bytes, one map a tag. */
const decoded = [
  new Map<string, string>(),
  new Map<string, string>(),
  new Map<string, string>(),
  new Map<string, string>(),
];

function unpack(held: string, tag: PackTag): string {
  const memo = decoded[tag]!;
  const hit = memo.get(held);
  if (hit !== undefined) return hit;
  const latin1 = (tag & LATIN1) !== 0;
  let raw: Uint8Array;
  if ((tag & ZSTD) !== 0) {
    const frame = Buffer.allocUnsafe(held.length + 4);
    ZSTD_MAGIC.copy(frame, 0);
    frame.write(held, 4, "latin1");
    raw = Bun.zstdDecompressSync(frame);
  } else raw = Bun.inflateSync(Buffer.from(held, "latin1"));
  // Latin-1 text comes back through `latin1`, which makes a one-byte string; a UTF-8 decode of the same bytes gives a
  // two-byte one for any accented letter, and every regex and hash over it ran slower (pipeline.bench, 1.17x).
  const text = latin1
    ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("latin1")
    : decoder.decode(raw);
  remember(held, tag, text);
  return text;
}

/** Notes `held`'s decoded text in the memo. */
function remember(held: string, tag: PackTag, text: string): void {
  const memo = decoded[tag]!;
  // First in, first out: a hit is not moved up, which keeps the memo's own cost off the many hits.
  if (memo.size >= MEMO_ITEMS) memo.delete(memo.keys().next().value as string);
  memo.set(held, text);
}

/** Shared by every packed item, so each holds only its bytes; one a tag (`TEXT[tag]`). */
const TEXT: readonly PropertyDescriptor[] = ([0, 1, 2, 3] as const).map((tag) => ({
  get(this: Packed) {
    return unpack(this[PACKED], tag);
  },
  enumerable: true,
  configurable: false,
}));
/** A packed item's tag, from its getter (no field of its own). */
function tagOf(item: ContextItem): PackTag {
  const get = Object.getOwnPropertyDescriptor(item, "text")!.get;
  return TEXT.findIndex((d) => d.get === get) as PackTag;
}

/** A surrogate not in a pair: in a `u` regex a well-formed pair is one code point, so only a lone half is `Cs`. */
const LONE_SURROGATE = /\p{Cs}/u;

/** Whether every character is Latin-1, so a JS string of it holds a byte a character, not two. */
function isLatin1(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0xff) return false;
  return true;
}

/**
 * A copy of `item` whose text is held compressed, or `item` itself when packing would not save at least a fifth of the
 * text's bytes (short text, text that does not compress).
 */
export function packItem(item: ContextItem): ContextItem {
  const text = item.text;
  if (text.length < MIN_PACK_CHARS || isPacked(item)) return item;
  const latin1 = isLatin1(text);
  // A lone surrogate (text cut inside an emoji) would come back from UTF-8 as U+FFFD: a held copy that no longer
  // matches what was indexed, and that every refresh would see as changed. Such text stays plain.
  if (!latin1 && LONE_SURROGATE.test(text)) return item;
  const plain = latin1 ? Buffer.from(text, "latin1") : encoder.encode(text);
  // Every frame starts with the same magic: its 4 bytes are not held (`unpack` puts them back).
  const bytes = Bun.zstdCompressSync(plain, { level: 1 }).subarray(4);
  if (bytes.byteLength > (latin1 ? text.length : text.length * 2) * 0.8) return item;
  const { text: _, ...rest } = item;
  const held = heldOf(bytes);
  const tag = ((latin1 ? LATIN1 : 0) | ZSTD) as PackTag;
  Object.defineProperty(rest, PACKED, { value: held, enumerable: false });
  Object.defineProperty(rest, "text", TEXT[tag]!);
  // The text these bytes decode to is in hand: the sync's `onStored` reads every copy just stored (its mentions), and
  // would otherwise decompress each straight back (D1913). The same entry a first decode would make, so a hit is still
  // this copy's own text: Latin-1 text through `latin1` from its bytes (a one-byte string, as `unpack` makes, D998),
  // other text as it is (a UTF-8 decode returns the same characters, BOM and all).
  remember(held, tag, latin1 ? (plain as Buffer).toString("latin1") : text);
  return rest as ContextItem;
}

/** Bytes as the one-byte string a packed item holds (`Packed`). */
function heldOf(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

/**
 * A packed copy of `item` holding `held`'s bytes, when `held` is packed and its text is `item`'s (the caller checked):
 * a refresh with the same words keeps the text packed without compressing it again, in whichever codec it was.
 * Otherwise `packItem(item)`.
 */
export function repackLike(item: ContextItem, held: ContextItem): ContextItem {
  if (!isPacked(held) || isPacked(item)) return packItem(item);
  const { text: _, ...rest } = item;
  Object.defineProperty(rest, PACKED, { value: (held as Packed)[PACKED], enumerable: false });
  Object.defineProperty(rest, "text", TEXT[tagOf(held)]!);
  return rest as ContextItem;
}

/**
 * Drops every decoded text the memo holds. Called when a user's items are forgotten or removed, so their decoded text
 * does not outlive them in the memo (another item reaches an entry only with the same bytes, so the same text; it
 * should not stay resident all the same).
 */
export function clearDecoded(): void {
  for (const memo of decoded) memo.clear();
}

/** Decoded texts the memo holds (for tests). */
export function decodedCount(): number {
  return decoded.reduce((n, memo) => n + memo.size, 0);
}

export function isPacked(item: ContextItem): boolean {
  return PACKED in item;
}

/**
 * A packed item's bytes and how they decode, or undefined for an item held plain (D860: a fast freeze copies the bytes
 * into the frozen blob as they are, so a thaw does not compress them again).
 */
export function packedOf(item: ContextItem): { bytes: Uint8Array; tag: PackTag; latin1: boolean } | undefined {
  if (!isPacked(item)) return undefined;
  const tag = tagOf(item);
  return { bytes: Buffer.from((item as Packed)[PACKED], "latin1"), tag, latin1: (tag & LATIN1) !== 0 };
}

/** Every own field of `item` but `text`, without reading `text` (a packed item's getter would decompress it). */
export function withoutText(item: ContextItem): Omit<ContextItem, "text"> {
  const rest: Record<string, unknown> = {};
  for (const k of Object.keys(item)) if (k !== "text") rest[k] = (item as unknown as Record<string, unknown>)[k];
  return rest as Omit<ContextItem, "text">;
}

/**
 * A packed item from `rest` and bytes `packedOf` gave (D860): the inverse of `withoutText` plus `packedOf`. Throws a
 * `RangeError` for a tag that is not a `PackTag` (a blob that does not read as this build's: the thaw that read it
 * fails, and `ItemCache` discards a blob from disk that fails so, D1926).
 */
export function packedFrom(rest: Omit<ContextItem, "text">, bytes: Uint8Array, tag: PackTag): ContextItem {
  if (TEXT[tag] === undefined || !Number.isInteger(tag)) throw new RangeError(`not a packed-text tag: ${String(tag)}`);
  const item = { ...rest };
  Object.defineProperty(item, PACKED, { value: heldOf(bytes), enumerable: false });
  Object.defineProperty(item, "text", TEXT[tag]!);
  return item as ContextItem;
}
