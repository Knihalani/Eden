/**
 * Compact item text for the cache (`CacheLimits.packText`, on by default; D188 reopened D111's compressed text). A
 * JS string holding one character past Latin-1 (a typographic dash, an arrow) is two bytes a character, and cached
 * item text was about half of a synced user's heap (ingest.bench.ts `--world`). A packed item keeps its text deflated
 * (Latin-1 bytes when every character fits, else UTF-8) and decodes it on read: `text` is an own, enumerable getter,
 * so reads, spreads, `JSON` and `structuredClone` see the same item as before.
 *
 * A small process-wide memo of recently decoded texts, keyed by the packed bytes (as the held string, so two keys are
 * equal only when the deflated bytes, and so the texts, are: a hit is always the reading item's own text, whoever
 * else holds the same words), keeps the repeated reads of one candidate on the ask path from inflating each time.
 */
// Imported, not the global: under `bun test --parallel` a reused worker was seen with a global `Buffer` whose `from`
// was TypedArray.from (A23's review; no code here assigns it), so `Buffer.from(text, "latin1")` threw in 1 run of 3.
import { Buffer } from "node:buffer";
import type { ContextItem } from "@eden/protocol";

/** Shorter text stays a plain string: its deflate header and the byte array's own cost would eat the saving. */
export const MIN_PACK_CHARS = 256;
/** Recently decoded texts kept (`decoded`): a lookup's candidates and their repeated reads, not a user's items. */
const MEMO_ITEMS = 256;

const PACKED = Symbol("eden.packedText");

/**
 * The deflated bytes, held as a one-byte string of them (each byte one Latin-1 character; D998), not a Uint8Array: a
 * typed array is two cells (the view and its ArrayBuffer) and a malloc'd store beside the bytes, about 200 bytes of
 * heap an item more than the string (`live-heap.bench.ts`). Inflating copies them into a Buffer first, a few hundred
 * bytes, once per decode the memo misses.
 */
type Packed = ContextItem & { readonly [PACKED]: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const decoded = new Map<string, string>();

function unpack(held: string, latin1: boolean): string {
  const hit = decoded.get(held);
  if (hit !== undefined) return hit;
  const raw = Bun.inflateSync(Buffer.from(held, "latin1"));
  // Latin-1 text comes back through `latin1`, which makes a one-byte string; a UTF-8 decode of the same bytes gives a
  // two-byte one for any accented letter, and every regex and hash over it ran slower (pipeline.bench, 1.17x).
  const text = latin1
    ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("latin1")
    : decoder.decode(raw);
  // First in, first out: a hit is not moved up, which keeps the memo's own cost off the many hits.
  if (decoded.size >= MEMO_ITEMS) decoded.delete(decoded.keys().next().value as string);
  decoded.set(held, text);
  return text;
}

/** Shared by every packed item, so each holds only its bytes; one for each way its text was encoded. */
const LATIN1_TEXT: PropertyDescriptor = {
  get(this: Packed) {
    return unpack(this[PACKED], true);
  },
  enumerable: true,
  configurable: false,
};
const UTF8_TEXT: PropertyDescriptor = {
  get(this: Packed) {
    return unpack(this[PACKED], false);
  },
  enumerable: true,
  configurable: false,
};

/** A surrogate not in a pair: in a `u` regex a well-formed pair is one code point, so only a lone half is `Cs`. */
const LONE_SURROGATE = /\p{Cs}/u;

/** Whether every character is Latin-1, so a JS string of it holds a byte a character, not two. */
function isLatin1(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0xff) return false;
  return true;
}

/**
 * A copy of `item` whose text is held deflated, or `item` itself when packing would not save at least a fifth of the
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
  const bytes = Bun.deflateSync(plain);
  if (bytes.byteLength > (latin1 ? text.length : text.length * 2) * 0.8) return item;
  const { text: _, ...rest } = item;
  Object.defineProperty(rest, PACKED, { value: heldOf(bytes), enumerable: false });
  Object.defineProperty(rest, "text", latin1 ? LATIN1_TEXT : UTF8_TEXT);
  return rest as ContextItem;
}

/** Bytes as the one-byte string a packed item holds (`Packed`). */
function heldOf(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

/**
 * A packed copy of `item` holding `held`'s bytes, when `held` is packed and its text is `item`'s (the caller checked):
 * a refresh with the same words keeps the text deflated without deflating it again. Otherwise `packItem(item)`.
 */
export function repackLike(item: ContextItem, held: ContextItem): ContextItem {
  if (!isPacked(held) || isPacked(item)) return packItem(item);
  const desc = Object.getOwnPropertyDescriptor(held, "text")!;
  const { text: _, ...rest } = item;
  Object.defineProperty(rest, PACKED, { value: (held as Packed)[PACKED], enumerable: false });
  Object.defineProperty(rest, "text", desc.get === LATIN1_TEXT.get ? LATIN1_TEXT : UTF8_TEXT);
  return rest as ContextItem;
}

/**
 * Drops every decoded text the memo holds. Called when a user's items are forgotten or removed, so their decoded text
 * does not outlive them in the memo (it is never reachable from another item, but it should not stay resident).
 */
export function clearDecoded(): void {
  decoded.clear();
}

/** Decoded texts the memo holds (for tests). */
export function decodedCount(): number {
  return decoded.size;
}

export function isPacked(item: ContextItem): boolean {
  return PACKED in item;
}

/**
 * A packed item's deflated bytes and how they decode, or undefined for an item held plain (D860: a fast freeze copies
 * the bytes into the frozen blob as they are, so a thaw does not deflate them again).
 */
export function packedOf(item: ContextItem): { bytes: Uint8Array; latin1: boolean } | undefined {
  if (!isPacked(item)) return undefined;
  const desc = Object.getOwnPropertyDescriptor(item, "text")!;
  return { bytes: Buffer.from((item as Packed)[PACKED], "latin1"), latin1: desc.get === LATIN1_TEXT.get };
}

/** Every own field of `item` but `text`, without reading `text` (a packed item's getter would inflate it). */
export function withoutText(item: ContextItem): Omit<ContextItem, "text"> {
  const rest: Record<string, unknown> = {};
  for (const k of Object.keys(item)) if (k !== "text") rest[k] = (item as unknown as Record<string, unknown>)[k];
  return rest as Omit<ContextItem, "text">;
}

/** A packed item from `rest` and bytes `packedOf` gave (D860): the inverse of `withoutText` plus `packedOf`. */
export function packedFrom(rest: Omit<ContextItem, "text">, bytes: Uint8Array, latin1: boolean): ContextItem {
  const item = { ...rest };
  Object.defineProperty(item, PACKED, { value: heldOf(bytes), enumerable: false });
  Object.defineProperty(item, "text", latin1 ? LATIN1_TEXT : UTF8_TEXT);
  return item as ContextItem;
}
