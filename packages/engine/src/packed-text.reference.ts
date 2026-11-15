/**
 * `packItem` as it packed before D1926: raw DEFLATE level 6, tags 0 (UTF-8) and 1 (Latin-1). Kept as the tests'
 * source of the copies a warm blob of `PERSIST_FORMAT` 6 holds (`packed-text.test.ts`, `cache-freeze.test.ts`,
 * `persist.test.ts`), which this build still reads; nothing outside tests imports it.
 */
// Imported, not the global (packed-text.ts says why).
import { Buffer } from "node:buffer";
import type { ContextItem } from "@eden/protocol";
import { isPacked, MIN_PACK_CHARS, packedFrom, withoutText } from "./packed-text";

/** A copy of `it` packed as before D1926, or `it` when that packing would have left it plain. */
export function deflatePacked(it: ContextItem): ContextItem {
  const text = it.text;
  if (text.length < MIN_PACK_CHARS || isPacked(it)) return it;
  const latin1 = !/[^\x00-\xff]/.test(text);
  if (!latin1 && /\p{Cs}/u.test(text)) return it;
  const bytes = Bun.deflateSync(latin1 ? Buffer.from(text, "latin1") : new TextEncoder().encode(text));
  if (bytes.byteLength > (latin1 ? text.length : text.length * 2) * 0.8) return it;
  return packedFrom(withoutText(it), bytes, latin1 ? 1 : 0);
}
