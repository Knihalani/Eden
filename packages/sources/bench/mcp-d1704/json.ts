// Frozen as D1704 shipped it, with `bodyShapeUnder`'s byte loop of that time inlined (D1840 changed the shared one).
const decoder = new TextDecoder();

function bodyShapeUnder(bytes: Uint8Array): boolean {
  const maxDepth = 1_000 + 8;
  const maxValues = 1_000_000 + 10_000;
  let depth = 0;
  let values = 0;
  let inString = false;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!;
    if (inString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x5b || c === 0x7b) {
      if (++depth > maxDepth || ++values > maxValues) return false;
    } else if (c === 0x5d || c === 0x7d) depth--;
    else if (c === 0x2c && ++values > maxValues) return false;
  }
  return true;
}

/**
 * JSON from a peer's bytes, or undefined when it is not JSON or is shaped to make the parse costly: nested past
 * ~1,000 levels or holding more than ~1,000,000 values, counted by `@eden/protocol`'s byte scan before `JSON.parse`
 * (D100's bound, reused). The caller has already capped the byte count. Never throws.
 */
export function parseJsonBytes(bytes: Uint8Array): unknown {
  if (!bodyShapeUnder(bytes)) return undefined;
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return undefined;
  }
}
