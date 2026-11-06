/**
 * Compact item text for the cache (`CacheLimits.compactText`, on by default; D177 reopened D111's compressed text). A
 * JS string holding one character past Latin-1 (a typographic dash, an arrow) is two bytes a character, and cached
 * item text was about half of a synced user's heap (ingest.bench.ts `--world`). A packed item keeps its text deflated
 * (Latin-1 bytes when every character fits, else UTF-8) and decodes it on read: `text` is an own, enumerable getter,
 * so reads, spreads, `JSON` and `structuredClone` see the same item as before.
 *
 * A small process-wide memo of recently decoded texts, keyed by the packed bytes (one item's own; never shared between
 * items, users or tenants), keeps the repeated reads of one candidate on the ask path from inflating each time.
 */
import type { ContextItem } from "@eden/protocol";

/** Shorter text stays a plain string: its deflate header and the byte array's own cost would eat the saving. */
export const MIN_PACK_CHARS = 256;
/** Recently decoded texts kept (`decoded`): a lookup's candidates and their repeated reads, not a user's items. */
const MEMO_ITEMS = 256;

const PACKED = Symbol("eden.packedText");
type Bytes = Uint8Array<ArrayBuffer>;

type Packed = ContextItem & { readonly [PACKED]: Bytes };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const decoded = new Map<Bytes, string>();

function unpack(bytes: Bytes, latin1: boolean): string {
  const hit = decoded.get(bytes);
  if (hit !== undefined) return hit;
  const raw = Bun.inflateSync(bytes);
  // Latin-1 text comes back through `latin1`, which makes a one-byte string; a UTF-8 decode of the same bytes gives a
  // two-byte one for any accented letter, and every regex and hash over it ran slower (pipeline.bench, 1.17x).
  const text = latin1
    ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("latin1")
    : decoder.decode(raw);
  // First in, first out: a hit is not moved up, which keeps the memo's own cost off the many hits.
  if (decoded.size >= MEMO_ITEMS) decoded.delete(decoded.keys().next().value as Bytes);
  decoded.set(bytes, text);
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
  const plain = latin1 ? Buffer.from(text, "latin1") : encoder.encode(text);
  const bytes = Bun.deflateSync(plain);
  if (bytes.byteLength > (latin1 ? text.length : text.length * 2) * 0.8) return item;
  const { text: _, ...rest } = item;
  Object.defineProperty(rest, PACKED, { value: bytes, enumerable: false });
  Object.defineProperty(rest, "text", latin1 ? LATIN1_TEXT : UTF8_TEXT);
  return rest as ContextItem;
}

export function isPacked(item: ContextItem): boolean {
  return PACKED in item;
}
