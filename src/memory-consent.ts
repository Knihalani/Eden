/** Operator consent for AgentMemory. Boolean env check — not an LLM, not a network call. */

export type MemoryConsent = "on" | "readonly" | "off";

const ON = new Set(["", "1", "on", "true", "yes"]);
const READONLY = new Set(["readonly", "read-only", "ro"]);

/**
 * Read `EDEN_MEMORY` at call time (default arg is evaluated per call — do not cache at construct). It is the master
 * flag of EXECUTION X7, whose unknown values resolve to off.
 *
 * - unset / "" / "1" / "on" / "true" / "yes" → on (default)
 * - "readonly" / "read-only" / "ro" → readonly
 * - "0" / "off" / "false" / "none", and any other value → off (identity: nothing read, written or injected)
 *
 * Distinct from `EDEN_KNOW` (Know catalog).
 */
export function memoryConsent(raw = process.env.EDEN_MEMORY): MemoryConsent {
  try {
    const v = raw == null ? "" : String(raw).trim().toLowerCase();
    if (ON.has(v)) return "on";
    if (READONLY.has(v)) return "readonly";
    return "off";
  } catch {
    // Prefer never throws. A fault reads as off, the identity. Callers that must identity-pass (inject) still wrap
    // this in their own try and return the original body.
    return "off";
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
