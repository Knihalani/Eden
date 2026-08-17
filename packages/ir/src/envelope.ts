import type { StretchProgram } from "./types";
import { eq } from "./eq";
import { getPath } from "./path";

export function inDistribution(program: StretchProgram, input: Record<string, unknown>): boolean {
  const env = program.contract.envelope?.inputs;
  if (!env) return program.contract.allowExact === true;
  for (const [path, values] of Object.entries(env)) {
    if (!Array.isArray(values)) return false;
    const v = getPath(input, path);
    if (!values.some((w) => eq(w, v))) return false;
  }
  return true;
}
