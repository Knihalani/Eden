/** Task module for bench/offload.bench.ts: the secret gate, which the engine runs on every item it caches. */
import { sanitizeForStore } from "../../../redact/src/secrets";

export function sanitize(text: string): string {
  return sanitizeForStore(text);
}

export function sanitizeAll(texts: string[]): string[] {
  return texts.map(sanitizeForStore);
}

/** For measuring a pool's own overhead. */
export function noop(x: unknown): unknown {
  return x;
}
