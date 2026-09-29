/** Operator consent for AgentMemory. Boolean env check — not an LLM, not a network call. */

export type MemoryConsent = "on" | "readonly" | "off";

const OFF = new Set(["0", "off", "false", "none"]);
const READONLY = new Set(["readonly", "read-only", "ro"]);

/**
 * Read `EDEN_MEMORY` at call time (default arg is evaluated per call — do not cache at construct).
 *
 * - unset / "" / "1" / "on" / "true" / "yes" → on (default)
 * - "0" / "off" / "false" / "none" → off
 * - "readonly" / "read-only" / "ro" → readonly
 * - unknown → on (fail-open; do not 500)
 *
 * Distinct from `EDEN_KNOW` (Know catalog).
 */
export function memoryConsent(raw = process.env.EDEN_MEMORY): MemoryConsent {
  try {
    const v = raw == null ? "" : String(raw).trim().toLowerCase();
    if (OFF.has(v)) return "off";
    if (READONLY.has(v)) return "readonly";
    return "on";
  } catch {
    // Prefer never throws. Unknown/fault → on (fail-open). Callers that must
    // identity-pass (inject) still wrap this in their own try and return the original body.
    return "on";
  }
}

/**
 * Writes (observe, remember, persist, forget, pin, sleep).
 * Forget and pin are writes: readonly and off are no-ops.
 * Default off-switch is fail-open for the agent: no throw.
 */
export function memoryWritesAllowed(raw = process.env.EDEN_MEMORY): boolean {
  try {
    return memoryConsent(raw) === "on";
  } catch {
    return false; // if consent cannot be read, do not write
  }
}
