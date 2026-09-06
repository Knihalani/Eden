import { isMutating, isReadName, type StretchProgram } from "@eden/ir";

export function sharedAcrossLine(n: number): string {
  return `shared across ${n} agents`;
}

export function wrapFleetId(explicit?: string): string {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const env = process.env.EDEN_FLEET;
  return typeof env === "string" && env.length > 0 ? env : "";
}

export function wrapAgentId(explicit?: string, sessionId = ""): string {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const env = process.env.EDEN_AGENT;
  if (typeof env === "string" && env.length > 0) return env;
  return sessionId;
}

export function wrapRegion(explicit?: string): string {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const env = process.env.EDEN_REGION;
  return typeof env === "string" && env.length > 0 ? env : "";
}

/**
 * Read-only iff every sequence name is a read and none is a mutation.
 * Empty sequence is not shareable.
 */
export function isProgramReadOnly(program: StretchProgram): boolean {
  const seq = program.sequence ?? [];
  if (!seq.length) return false;
  return seq.every((n) => isReadName(n) && !isMutating(n));
}
