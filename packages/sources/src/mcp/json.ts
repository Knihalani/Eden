import { bodyShapeUnder } from "@eden/protocol";

const decoder = new TextDecoder();

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
