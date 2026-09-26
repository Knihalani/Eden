import { isMutating, isReadName, type StretchProgram } from "@eden/ir";

export function sharedAcrossLine(n: number): string {
  return `shared across ${n} agents`;
}

function fromEnv(explicit: string | undefined, key: string, fallback = ""): string {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const env = process.env[key];
  return typeof env === "string" && env.length > 0 ? env : fallback;
}
export const wrapFleetId = (explicit?: string): string => fromEnv(explicit, "EDEN_FLEET");
export const wrapAgentId = (explicit?: string, sessionId = ""): string => fromEnv(explicit, "EDEN_AGENT", sessionId);
export const wrapRegion = (explicit?: string): string => fromEnv(explicit, "EDEN_REGION");

export function isProgramReadOnly(program: StretchProgram): boolean {
  const seq = program.sequence ?? [];
  if (!seq.length) return false;
  return seq.every((n) => isReadName(n) && !isMutating(n));
}

export function isSafeToWarm(program: StretchProgram): boolean {
  if (!isProgramReadOnly(program)) return false;
  for (const step of program.steps ?? []) {
    if (step.kind === "island") return false;
    if (step.kind === "tool" && (isMutating(step.tool) || !isReadName(step.tool))) return false;
  }
  return true;
}
